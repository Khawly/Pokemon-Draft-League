-- Makes league rules a per-season record again, and carries them into a new season.
--
-- Rules have always been stored per season, but two things treated them as if only the
-- newest season mattered. The read policy scoped SELECT to the league's latest season, and
-- start_new_season copied the settings row but not the rules document. Together that meant a
-- league which started a new season appeared to lose its rules: the old season's text became
-- unreadable, and the new season had none.

/*
 * Any active member may read any season of their own league.
 *
 * The rules for a finished season are part of that season's record, the same as its results
 * and standings, and the schedule pages now let a member look back at one. Writes are
 * unaffected: they still go through save_league_rules, which is owner-only and always
 * targets the current season.
 */
DROP POLICY IF EXISTS "Members can view their league rules" ON public.rules_documents;

CREATE POLICY "Members can view their league rules"
  ON public.rules_documents
  FOR SELECT
  TO authenticated
  USING (public.is_active_league_member(league_id));

/*
 * Starting a season now copies the rules text forward.
 *
 * The text is a starting point for the new season rather than an immutable artefact: the
 * owner edits it for the season ahead. Copying is what "the new season keeps the same rules"
 * means for the document, and leaving it blank would silently discard the league's written
 * rules every time a season turned over.
 *
 * Everything else about starting a season is unchanged.
 */
CREATE OR REPLACE FUNCTION public.start_new_season(p_league_id UUID)
RETURNS TABLE (season_id UUID, season_number INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_old_season_id UUID;
  v_old_status TEXT;
  v_old_number INTEGER;
  v_new_season_id UUID;
  v_new_number INTEGER;
  v_team_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to start a season.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can start a season.';
  END IF;

  SELECT s.id, s.status, s.season_number
  INTO v_old_season_id, v_old_status, v_old_number
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_old_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  /*
   * Refused mid-draft. A draft in progress is the one thing a new season would destroy
   * without the owner meaning to, because the picks are the work of everyone in the league.
   */
  IF v_old_status = 'draft_active' THEN
    RAISE EXCEPTION 'Finish or reset the current draft before starting a new season.';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_old_season_id;

  IF v_team_count = 0 THEN
    RAISE EXCEPTION 'This league has no teams to carry into a new season.';
  END IF;

  v_new_number := v_old_number + 1;

  INSERT INTO public.seasons (league_id, season_number, status)
  VALUES (p_league_id, v_new_number, 'draft_pending')
  RETURNING id INTO v_new_season_id;

  /*
   * The settings row is copied by merging the old row into itself with the progress columns
   * replaced. Written this way rather than as an explicit column list so a setting added
   * later is carried forward without this function having to learn about it -- the failure
   * mode of a column list is silent, and a new season quietly missing a rule.
   */
  INSERT INTO public.league_settings
  SELECT (
    jsonb_populate_record(
      NULL::public.league_settings,
      to_jsonb(ls) || jsonb_build_object(
        'id', gen_random_uuid(),
        'season_id', v_new_season_id,
        'playoff_state_json', '{}'::jsonb,
        'current_week', 0,
        'regular_season_completed_at', NULL,
        'week_deadline_anchor_date', NULL,
        'updated_at', NOW()
      )
    )
  ).*
  FROM public.league_settings ls
  WHERE ls.season_id = v_old_season_id;

  -- If the old season somehow had no settings row, the new one still needs one.
  IF NOT EXISTS (
    SELECT 1 FROM public.league_settings ls WHERE ls.season_id = v_new_season_id
  ) THEN
    INSERT INTO public.league_settings (league_id, season_id)
    VALUES (p_league_id, v_new_season_id);
  END IF;

  /*
   * No ON CONFLICT guard: the season was created moments ago, so no rules row can exist
   * for it yet. Naming season_id in a conflict target would also collide with this
   * function's OUT parameter of the same name.
   */
  INSERT INTO public.rules_documents (
    league_id, season_id, created_by, content, file_url
  )
  SELECT
    rd.league_id, v_new_season_id, rd.created_by, rd.content, rd.file_url
  FROM public.rules_documents rd
  WHERE rd.league_id = p_league_id
    AND rd.season_id = v_old_season_id
    AND rd.created_by IS NOT NULL;

  /*
   * One fresh team per owner. Draft position is cleared so the new draft order is drawn
   * again rather than inherited, and the salary override is cleared so every team falls
   * back to the league's own figure.
   */
  INSERT INTO public.teams (
    league_id, season_id, owner_user_id, team_name, draft_position, total_salary_override
  )
  SELECT
    t.league_id, v_new_season_id, t.owner_user_id, t.team_name, NULL, NULL
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = v_old_season_id;

  season_id := v_new_season_id;
  season_number := v_new_number;

  RETURN NEXT;
END;
$$;

/*
 * Backfill: seasons created before this fix did not get their rules copied.
 *
 * For each league, if the newest season has no rules of its own, copy the most recent
 * earlier season's text into it. Only the newest season is touched, because that is the one
 * start_new_season created without a copy; older seasons keep whatever they were given.
 */
INSERT INTO public.rules_documents (league_id, season_id, created_by, content, file_url)
SELECT latest.league_id, latest.id, src.created_by, src.content, src.file_url
FROM (
  SELECT DISTINCT ON (s.league_id)
    s.league_id, s.id, s.season_number
  FROM public.seasons s
  ORDER BY s.league_id, s.season_number DESC
) AS latest
JOIN LATERAL (
  SELECT rd.created_by, rd.content, rd.file_url
  FROM public.rules_documents rd
  JOIN public.seasons rs ON rs.id = rd.season_id
  WHERE rs.league_id = latest.league_id
    AND rs.season_number < latest.season_number
    AND rd.created_by IS NOT NULL
  ORDER BY rs.season_number DESC
  LIMIT 1
) AS src ON TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM public.rules_documents d WHERE d.season_id = latest.id
)
ON CONFLICT (league_id, season_id) DO NOTHING;

REVOKE ALL ON FUNCTION public.start_new_season(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_new_season(UUID) TO authenticated;

-- Force PostgREST to pick up the new policy immediately.
NOTIFY pgrst, 'reload schema';
