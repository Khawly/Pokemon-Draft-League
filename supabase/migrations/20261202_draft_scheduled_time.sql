-- Owner-configurable draft date and league-wide notification.
--
-- The draft settings page gains a date and time field so the owner can announce
-- when the draft runs. The value is stored as an absolute instant so every
-- member reads it in the zone they picked in their own settings, and the Draft
-- Board renders it from that instant.
--
-- Setting or clearing the date fans a notification out to every other active
-- member. The fan-out reuses notify_league_members, which already skips the
-- actor, so the owner is not told about their own change.

-- The instant the league's draft is scheduled to start, or null when no date has
-- been set. Read by the Draft Board and the dashboard notification panel.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS draft_at TIMESTAMPTZ;

COMMENT ON COLUMN public.league_settings.draft_at IS
  'Absolute instant the draft is scheduled to start, set by the owner on the draft settings page.';

-- Announces a newly scheduled or cleared draft date to the rest of the league.
--
-- Runs AFTER INSERT OR UPDATE OF draft_at so a first save that creates the
-- settings row notifies as well as a later edit. The guard ignores an upsert
-- that rewrites the same value, which the settings page does on every save
-- because it writes the whole row.
--
-- The message deliberately carries no clock time: the instant is displayed in
-- each recipient's own zone on the Draft Board, and a single stored string
-- cannot express that for a whole league.
CREATE OR REPLACE FUNCTION public.notify_draft_time_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.draft_at IS NOT DISTINCT FROM OLD.draft_at THEN
    RETURN NEW;
  END IF;

  -- An insert with no date is just a league setting up its row; there is
  -- nothing to announce.
  IF NEW.draft_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'draft_unscheduled',
      'The scheduled draft date and time were cleared.',
      'league_settings',
      NEW.id
    );

    RETURN NEW;
  END IF;

  PERFORM public.notify_league_members(
    NEW.league_id,
    NEW.season_id,
    auth.uid(),
    'draft_scheduled',
    'The draft date and time have been set. Open the Draft Board to see when the draft starts in your time zone.',
    'league_settings',
    NEW.id
  );

  RETURN NEW;
END;
$$;

-- Trigger functions are not called by clients, so keep them off the browser
-- roles even though the trigger itself runs as the table owner.
REVOKE ALL ON FUNCTION public.notify_draft_time_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS league_settings_notify_draft_time ON public.league_settings;
CREATE TRIGGER league_settings_notify_draft_time
AFTER INSERT OR UPDATE OF draft_at ON public.league_settings
FOR EACH ROW
EXECUTE FUNCTION public.notify_draft_time_change();

-- ------------------------------------------------------------------ new season
--
-- Re-issues start_new_season so a new season starts with no scheduled draft.
--
-- The function copies the previous settings row by merging it into itself, which
-- is what carries a setting added later forward without the function listing it.
-- draft_at is the deliberate exception: the next draft is on a new date, so
-- carrying the old instant forward would show a stale date on the new board.
-- It would also fire the notification trigger above, announcing a draft time
-- nobody set for this season.
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
  v_archive_season_id UUID;
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
   * Refused mid-draft. A draft in progress is the one thing a new season would
   * destroy without the owner meaning to, because the picks are the work of
   * everyone in the league.
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
   * The settings row is copied by merging the old row into itself with the
   * progress columns replaced. draft_at is cleared because the next draft is
   * scheduled separately.
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
        'draft_at', NULL,
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
   * No ON CONFLICT guard: the season was created moments ago, so no rules row
   * can exist for it yet. Naming season_id in a conflict target would also
   * collide with this function's OUT parameter of the same name.
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
   * One fresh team per owner. Draft position is cleared so the new draft order
   * is drawn again rather than inherited, and the salary override is cleared
   * so every team falls back to the league's own figure.
   */
  INSERT INTO public.teams (
    league_id, season_id, owner_user_id, team_name, draft_position, total_salary_override
  )
  SELECT
    t.league_id, v_new_season_id, t.owner_user_id, t.team_name, NULL, NULL
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = v_old_season_id;

  /*
   * Every earlier season is now history, so compact them all -- including any
   * that were already closed before the archive existed. A failure here rolls
   * back the whole season switch; archive_season_pools is idempotent, so a
   * retry is safe.
   */
  FOR v_archive_season_id IN
    SELECT s.id
    FROM public.seasons s
    WHERE s.league_id = p_league_id
      AND s.id <> v_new_season_id
      AND s.status <> 'draft_active'
  LOOP
    PERFORM public.archive_season_pools(p_league_id, v_archive_season_id);
  END LOOP;

  season_id := v_new_season_id;
  season_number := v_new_number;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.start_new_season(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_new_season(UUID) TO authenticated;

-- Force PostgREST to pick up the new column and function immediately.
NOTIFY pgrst, 'reload schema';
