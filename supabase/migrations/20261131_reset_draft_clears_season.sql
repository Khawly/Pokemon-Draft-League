-- Lets reset_draft run at any point in a season by clearing everything the draft
-- produced, and stops it leaving league-level state behind.
--
-- 20261129 made reset_draft refuse once the season had matches or trades, on the
-- grounds that re-running the draft cannot preserve them. That was too blunt: an
-- owner re-drafting after a bad auto-pick should not be locked out of their own
-- season. This replaces the refusal with an explicit, ordered teardown, so the
-- reset still works and what it removes is a decision on the record rather than a
-- side effect of deleting teams.
--
-- 1. The teardown is now deliberate and ordered.
--    Everything that depends on a team hangs off it by ON DELETE CASCADE
--    (20250911:102, 158-159, 173, 217; 20260920:22): team_roster, matches (and so
--    match_results and match_scheduling_proposals), transactions, trade_items (and
--    so trades) and draft_picks. Deleting public.teams used to take the season with
--    it as a silent consequence, and the trades rows outlived their own items,
--    leaving trades marked completed that described nothing.
--
--    Now matches and trades are deleted first, by season, before anything that
--    references teams. The cascades then have nothing left to reach, so the order
--    of the statements is what guarantees a consistent result instead of relying
--    on which delete happened to run first.
--
--    This does destroy that season's matches, results and trades. That is
--    unavoidable rather than incidental: the rosters being re-drafted are gone, so
--    a result recorded against the old roster no longer describes anything, and
--    the transaction ledger that priced a trade is deleted along with the rosters
--    it priced. Preserving them would mean keeping the old teams and rosters, at
--    which point the reset is not a reset. The confirmation dialog now says so.
--
-- 2. The league-level state that pointed at the old season is cleared.
--    reset_draft never touched league_settings, so three things went stale:
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

  /*
   * Tear the season down in dependency order.
   *
   * Matches and trades go first and are named explicitly, even though every one of
   * these tables hangs off public.teams by ON DELETE CASCADE. Deleting them up
   * front means the cascades have nothing left to reach, so the result is the same
   * whatever order the planner happens to run the statements in, and the blast
   * radius of a reset is written down rather than inferred from the schema.
   *
   * matches takes match_results and match_scheduling_proposals with it; trades
   * takes trade_items. See the header for why the trade rows must go too rather
   * than surviving as empty shells.
   */
  DELETE FROM public.matches m
  WHERE m.league_id = p_league_id AND m.season_id = v_season_id;

  DELETE FROM public.trades t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  DELETE FROM public.transactions x
  WHERE x.league_id = p_league_id AND x.season_id = v_season_id;

  DELETE FROM public.team_roster r
  USING public.teams t
  WHERE r.team_id = t.id
    AND t.league_id = p_league_id
    AND t.season_id = v_season_id;

  DELETE FROM public.draft_picks d
  WHERE d.league_id = p_league_id AND d.season_id = v_season_id;

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

  -- Teams last. Everything above that references them has already gone, so this
-- delete has no cascade left to perform; start_draft then mints fresh rows on the
-- next start, which is why the frozen bracket seeds cannot survive it.
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