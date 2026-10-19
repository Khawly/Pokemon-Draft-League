-- Starts a new season for a league, carrying the rules forward and nothing else.
--
-- A season is the unit everything else hangs off: teams, rosters, matches, draft pools and
-- the settings row itself are all season-scoped. Starting a new one therefore means minting
-- fresh rows rather than editing the old ones, which is what leaves last season's results
-- and rosters intact and readable.
--
-- What carries over are the rules: the settings row is copied whole, then the handful of
-- columns that describe progress rather than policy are reset. What does not carry over is
-- everything a season accumulates. Rosters, matches, draft picks and pools belong to the
-- old season and stay there, so the new one starts with no Pokemon, no results and no pool.
--
-- A team's salary override is cleared too. "Reset to the league settings" means exactly
-- that: the new team inherits whatever the league charges rather than keeping a figure that
-- may have been negotiated for the season it was set in.

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

REVOKE ALL ON FUNCTION public.start_new_season(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_new_season(UUID) TO authenticated;