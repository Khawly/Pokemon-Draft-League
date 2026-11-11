-- Draft-live notification, deadline wording with old/new values, and invite
-- rotation when a draft starts.
--
-- Deadlines now name both the previous and the new value so a member can see
-- what changed. Free agency deadlines join trade and weekly deadlines. Starting
-- a draft tells the league it is live and replaces the invite code, so links
-- handed out before the draft no longer admit anyone.

-- ------------------------------------------------------- deadline wording

-- Replaces the wording-only version from 20261191. Each deadline's message now
-- renders the old and new value. Trade and free agency deadlines are instants,
-- rendered in UTC because the notification text is shared by every member; the
-- weekly deadline keeps its calendar date, local time, and zone.
CREATE OR REPLACE FUNCTION public.notify_league_deadline_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_automatic_advance BOOLEAN;
  v_old_weekly TEXT;
  v_new_weekly TEXT;
  v_old_trade TEXT;
  v_new_trade TEXT;
  v_old_free_agency TEXT;
  v_new_free_agency TEXT;
  v_paused_changed BOOLEAN;
BEGIN
  IF NEW.trade_deadline_at IS DISTINCT FROM OLD.trade_deadline_at THEN
    v_old_trade := COALESCE(
      to_char(OLD.trade_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );
    v_new_trade := COALESCE(
      to_char(NEW.trade_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'trade_deadline_changed',
      format('The trade deadline was changed from %s to %s.', v_old_trade, v_new_trade),
      'league_settings',
      NEW.id
    );
  END IF;

  IF NEW.free_agency_deadline_at IS DISTINCT FROM OLD.free_agency_deadline_at THEN
    v_old_free_agency := COALESCE(
      to_char(OLD.free_agency_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );
    v_new_free_agency := COALESCE(
      to_char(NEW.free_agency_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'free_agency_deadline_changed',
      format('The free agency deadline was changed from %s to %s.', v_old_free_agency, v_new_free_agency),
      'league_settings',
      NEW.id
    );
  END IF;

  v_old_weekly := CASE
    WHEN OLD.week_deadline_enabled THEN
      COALESCE(to_char(OLD.week_deadline_anchor_date, 'Mon DD, YYYY'), 'no start date')
        || ' at ' || OLD.week_deadline_time
        || ' (' || OLD.week_deadline_timezone || ')'
    ELSE 'off'
  END;

  v_new_weekly := CASE
    WHEN NEW.week_deadline_enabled THEN
      COALESCE(to_char(NEW.week_deadline_anchor_date, 'Mon DD, YYYY'), 'no start date')
        || ' at ' || NEW.week_deadline_time
        || ' (' || NEW.week_deadline_timezone || ')'
    ELSE 'off'
  END;

  v_automatic_advance :=
    NEW.week_deadline_last_advanced_at IS DISTINCT FROM OLD.week_deadline_last_advanced_at;
  v_paused_changed :=
    NEW.week_deadline_paused IS DISTINCT FROM OLD.week_deadline_paused;

  /*
   * The deadline sweep rewrites the anchor date as it advances a week. That is
   * not an owner change, so the last-advanced marker suppresses it. Comparing
   * the rendered labels also suppresses an edit to a disabled deadline that
   * cannot change what anyone sees.
   */
  IF NOT v_automatic_advance AND v_old_weekly IS DISTINCT FROM v_new_weekly THEN
    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'week_deadline_changed',
      format('The weekly deadline was changed from %s to %s.', v_old_weekly, v_new_weekly),
      'league_settings',
      NEW.id
    );
  ELSIF v_paused_changed THEN
    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'week_deadline_changed',
      CASE
        WHEN NEW.week_deadline_paused THEN
          'The weekly deadline was paused.'
        ELSE
          'The weekly deadline was resumed.'
      END,
      'league_settings',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

-- --------------------------------------------------------------- start draft

-- Re-issues start_draft from 20261113 with two additions: the league is told
-- the draft is live, and the invite code is rotated so links shared before the
-- draft stop working. Every validation, priority-list snapshot, team mirror,
-- and bot autopick is unchanged.
--
-- @param p_league_id - The league whose latest season to start drafting.
-- @returns The season id and its new (draft_active) status.
CREATE OR REPLACE FUNCTION public.start_draft(
  p_league_id UUID
)
RETURNS TABLE (season_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_status TEXT;
  v_max_players INTEGER;
  v_member_count INTEGER;
  v_assigned_count INTEGER;
  v_pool_pokemon_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to start the draft.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can start the draft.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season exists for this league.';
  END IF;

  IF v_status = 'draft_active' THEN
    RAISE EXCEPTION 'The draft has already started.';
  END IF;

  IF v_status IN ('draft_complete', 'archived') THEN
    RAISE EXCEPTION 'The draft for this season is already complete.';
  END IF;

  SELECT l.number_of_players INTO v_max_players
  FROM public.leagues l
  WHERE l.id = p_league_id;

  SELECT COUNT(*)::INTEGER INTO v_member_count
  FROM public.league_members lm
  WHERE lm.league_id = p_league_id AND lm.is_active = TRUE;

  IF v_member_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: fill all player slots first (% of % filled).',
      v_member_count,
      v_max_players;
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_assigned_count
  FROM public.league_members lm
  WHERE lm.league_id = p_league_id
    AND lm.is_active = TRUE
    AND lm.draft_position IS NOT NULL;

  IF v_assigned_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: assign a draft position to every player (%).',
      v_assigned_count;
  END IF;

  UPDATE public.teams t
  SET draft_position = lm.draft_position,
      total_salary_override = lm.total_token_salary
  FROM public.league_members lm
  WHERE t.league_id = p_league_id
    AND t.season_id = v_season_id
    AND t.owner_user_id = lm.user_id
    AND lm.league_id = p_league_id
    AND lm.is_active = TRUE;

  INSERT INTO public.teams (league_id, season_id, owner_user_id, team_name, draft_position, total_salary_override)
  SELECT lm.league_id, v_season_id, lm.user_id,
         COALESCE(p.display_name, 'Player ' || substr(lm.user_id::text, 1, 8)),
         lm.draft_position,
         lm.total_token_salary
  FROM public.league_members lm
  LEFT JOIN public.profiles p ON p.id = lm.user_id
  WHERE lm.league_id = p_league_id
    AND lm.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.league_id = p_league_id
        AND t.season_id = v_season_id
        AND t.owner_user_id = lm.user_id
    );

  SELECT COUNT(*)::INTEGER INTO v_pool_pokemon_count
  FROM public.draft_pool_pokemon dpp
  JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
  WHERE dp.season_id = v_season_id
    AND dpp.is_in_pool = TRUE
    AND (
      dp.is_active = TRUE
      OR NOT EXISTS (
        SELECT 1 FROM public.draft_pools a
        WHERE a.season_id = v_season_id AND a.is_active = TRUE
      )
    );

  IF v_pool_pokemon_count <= 0 THEN
    RAISE EXCEPTION 'Draft cannot start: the draft pool has no in-pool Pokemon yet.';
  END IF;

  DELETE FROM public.draft_priority_snapshots s
  WHERE s.season_id = v_season_id;

  INSERT INTO public.draft_priority_snapshots (
    league_id, season_id, user_id, round_number, slot_index, pokemon_id, auto_pick, skip_pick
  )
  SELECT pl.league_id, pl.season_id, pl.user_id, pl.round_number,
         pl.slot_index, pl.pokemon_id, pl.auto_pick, pl.skip_pick
  FROM public.draft_priority_lists pl
  WHERE pl.season_id = v_season_id;

  UPDATE public.seasons
  SET status = 'draft_active', draft_started_at = NOW(), draft_pick_started_at = NOW(),
      draft_paused_at = NULL
  WHERE id = v_season_id;

  /*
   * A draft is a league-wide event, so every active member is told it is live.
   * The owner is excluded because they just pressed the button; they are taken
   * straight to the arena by the draft board.
   */
  PERFORM public.notify_league_members(
    p_league_id,
    v_season_id,
    v_user_id,
    'draft_live',
    'The draft is live. Make your picks!',
    'season',
    v_season_id
  );

  /*
   * Rotate the invite link at the same moment. Any code handed out before the
   * draft is deleted, so opening it after this can only be rejected as revoked;
   * the replacement is the code the draft board will show from now on.
   */
  DELETE FROM public.league_invites
  WHERE league_id = p_league_id;

  INSERT INTO public.league_invites (league_id, token, created_by, expires_at)
  VALUES (
    p_league_id,
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    v_user_id,
    NOW() + INTERVAL '30 days'
  );

  -- If the first on-clock player is an auto-pick test bot, start drafting
  -- immediately instead of waiting out the first timer.
  PERFORM public.advance_bot_autopicks(p_league_id);

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;

REVOKE ALL ON FUNCTION public.start_draft(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_draft(UUID) TO authenticated;

-- Force PostgREST to pick up the replaced functions immediately.
NOTIFY pgrst, 'reload schema';
