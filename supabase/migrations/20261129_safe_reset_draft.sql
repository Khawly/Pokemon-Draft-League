-- Makes reset_draft refuse once the season has real history, and clears the
-- league-level state it used to leave behind.
--
-- Two separate problems, both of which bite hardest on a long draft where a reset
-- is most tempting.
--
-- 1. reset_draft destroyed the whole season, not just the draft.
--    It deleted public.teams (20261113:287), and matches.player_1_team_id,
--    matches.player_2_team_id, matches.winner_team_id, match_results.winner_team_id
--    and trade_items.team_id are all REFERENCES teams(id) ON DELETE CASCADE
--    (20250911:158-159, 173, 216). Resetting on day 8 to redo round 3 therefore
--    wiped every scheduled match, every reported result and every trade's item
--    list, while the trades rows themselves survived with no items, leaving
--    trades marked completed that no longer describe anything. The confirmation
--    dialog only mentioned picks and rosters.
--
--    It is fixed by refusing rather than by deleting more: once a season has
--    matches or trades there is no way to re-run the draft without destroying
--    them, so the honest answer is to decline and let the owner start a new
--    season. A draft that is still in progress has generated no matches yet, so
--    the reset they actually want still works.
--
-- 2. reset_draft left league-level state pointing at a season that no longer
--    existed.
--    It never touched league_settings, so three things went stale:
--
--      playoff_state_json kept the frozen bracket seeds. start_draft re-creates
--        teams with fresh gen_random_uuid() keys, so every frozen seed is gone.
--        generate_playoff_round reuses the frozen list without an existence check
--        (20261018:490-494), feeds those dead UUIDs into matches.player_1_team_id
--        (:525), the insert fails on the foreign key, and the error is swallowed
--        into 'playoffs_pending' (20261022:365-369). The league then re-drafts,
--        completes, and silently never opens a bracket, while the heartbeat
--        retries every 60 seconds for the rest of the season.
--
--      current_week and regular_season_completed_at still pointed at weeks of a
--        season with no matches, so advance_league_week_deadline settled nothing
--        and kept walking the pointer forward.
--
--      week_progress_log still held the pre-reset snapshots. undo_league_week_progress
--        checks staleness by comparing league_settings against the journal's
--        new_* columns (20261022:524-529). Clearing league_settings without
--        clearing the journal would leave that guard passing, so undo would run
--        against an empty season and report 'undone' with matches_reopened: 0.
--
-- The priority list snapshot and restore, the season stamp resets and the
-- ownership checks are all carried over from 20261113 unchanged.

CREATE OR REPLACE FUNCTION public.reset_draft(
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
  v_match_count INTEGER;
  v_trade_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to reset the draft.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can reset the draft.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season exists for this league.';
  END IF;

  IF v_status = 'draft_pending' THEN
    RETURN QUERY SELECT v_season_id, 'draft_pending';
    RETURN;
  END IF;

  -- The teardown below deletes teams, which cascades into matches, results and
  -- trade items. Refuse rather than destroy a season that has already produced
  -- any of that: re-running the draft means starting a new season instead.
  SELECT COUNT(*)::INTEGER INTO v_match_count
  FROM public.matches m
  WHERE m.season_id = v_season_id;

  IF v_match_count > 0 THEN
    RAISE EXCEPTION
      'This season already has % scheduled match(es), and resetting the draft would delete them along with their results. Start a new season to re-draft instead.',
      v_match_count;
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_trade_count
  FROM public.trades t
  WHERE t.season_id = v_season_id;

  IF v_trade_count > 0 THEN
    RAISE EXCEPTION
      'This season already has % trade(s), and resetting the draft would delete what was traded. Start a new season to re-draft instead.',
      v_trade_count;
  END IF;

  -- Tear down the draft's generated state in foreign-key order so nothing the
  -- arena references outlives the reset.
  DELETE FROM public.draft_picks d
  WHERE d.league_id = p_league_id AND d.season_id = v_season_id;

  DELETE FROM public.team_roster r
  USING public.teams t
  WHERE r.team_id = t.id
    AND t.league_id = p_league_id
    AND t.season_id = v_season_id;

  DELETE FROM public.transactions x
  WHERE x.league_id = p_league_id AND x.season_id = v_season_id;

  DELETE FROM public.draft_priority_lists pl
  WHERE pl.season_id = v_season_id;

  -- Put the priority lists back the way the league built them. The picks those
  -- lists referred to were just deleted, so restoring an entry is consistent
  -- rather than resurrecting an already-taken Pokemon.
  INSERT INTO public.draft_priority_lists (
    league_id, season_id, user_id, round_number, slot_index, pokemon_id, auto_pick, skip_pick
  )
  SELECT s.league_id, s.season_id, s.user_id, s.round_number,
         s.slot_index, s.pokemon_id, s.auto_pick, s.skip_pick
  FROM public.draft_priority_snapshots s
  WHERE s.season_id = v_season_id;

  -- The snapshot has done its job. Dropping it means a later start re-captures
  -- the current lists rather than restoring this older copy.
  DELETE FROM public.draft_priority_snapshots s
  WHERE s.season_id = v_season_id;

  DELETE FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  -- Clear the league-level state that pointed at the season just torn down.
  -- The frozen bracket seeds are the important one: start_draft mints fresh team
  -- ids, so leaving them behind makes generate_playoff_round fail on a foreign
  -- key and retry silently forever. current_week and the anchor would otherwise
  -- keep advancing against a season with no matches, and the week progression
  -- journal has to go with them or undo would read as current.
  UPDATE public.league_settings
  SET playoff_state_json = '{}'::jsonb,
      current_week = 0,
      regular_season_completed_at = NULL,
      week_deadline_anchor_date = NULL,
      updated_at = NOW()
  WHERE season_id = v_season_id;

  DELETE FROM public.week_progress_log w
  WHERE w.season_id = v_season_id;

  UPDATE public.seasons
  SET status = 'draft_pending',
      draft_started_at = NULL,
      draft_pick_started_at = NULL,
      draft_completed_at = NULL,
      draft_paused_at = NULL
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_pending';
END;
$$;

REVOKE ALL ON FUNCTION public.reset_draft(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_draft(UUID) TO authenticated;

-- Force PostgREST to pick up the new function bodies immediately.
NOTIFY pgrst, 'reload schema';