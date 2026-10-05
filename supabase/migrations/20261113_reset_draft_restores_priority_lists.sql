-- Restores priority lists on draft reset
--
-- The draft consumes every player's priority list as it runs:
-- insert_draft_pick prunes each drafted Pokemon out of every list in the
-- season, so by the time an owner resets the draft the lists hold only what was
-- never picked. reset_draft then deleted them outright, which threw away a list
-- the league had spent real effort building.
--
-- This migration snapshots the lists when the draft starts and restores them on
-- reset. Re-issues start_draft (latest version from 20261019) to capture the
-- snapshot, and reset_draft (latest version from 20261006) to restore from it
-- instead of clearing. Everything else about both RPCs is unchanged.

-- The per-season copy of every player's priority list, taken at the instant the
-- draft starts. Mirrors draft_priority_lists so the restore is a straight
-- re-insert, including the auto/skip round flags.
CREATE TABLE IF NOT EXISTS public.draft_priority_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number >= 1),
  slot_index INTEGER NOT NULL CHECK (slot_index >= 0),
  pokemon_id TEXT NOT NULL,
  auto_pick BOOLEAN NOT NULL DEFAULT FALSE,
  skip_pick BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Mirrors the live table's uniqueness so one player's round cannot hold two
  -- entries at the same slot, which would make the restore ambiguous.
  UNIQUE (league_id, season_id, user_id, round_number, slot_index)
);

-- Speeds both the capture in start_draft and the restore in reset_draft, which
-- each scan the whole season.
CREATE INDEX IF NOT EXISTS draft_priority_snapshots_season_idx
  ON public.draft_priority_snapshots (season_id);

-- The snapshot holds the same private per-user data as draft_priority_lists, so
-- it gets the same treatment: RLS on, and no client-facing policy at all. Only
-- start_draft and reset_draft ever touch it, and both are SECURITY DEFINER, which
-- runs as the owner and so bypasses RLS. Granting SELECT here would leak every
-- player's hidden list to any authenticated member.
ALTER TABLE public.draft_priority_snapshots ENABLE ROW LEVEL SECURITY;

-- Re-issues start_draft with one addition: a snapshot of every player's priority
-- list is captured on the way to draft_active. Everything else (ownership and
-- checklist validation, the team mirror carrying draft position and salary, the
-- pool check, the season update, and the immediate bot autopick) is identical to
-- 20261019. start_draft already refuses to run on a season that is not
-- draft_pending, so this runs exactly once per draft start.
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

  -- Draft order must be fully assigned before the order locks in.
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

  -- Mirror the ordered member list into one team row per active member so the
  -- pick ledger / roster / transaction tables keep working unchanged. The draft
  -- position and the per-member salary override ride along from the member row.
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

  -- Capture the league's priority lists as they stand at the moment the draft
  -- starts, so a reset can put them back. Taken after every validation above so a
  -- refused start leaves no snapshot behind. Replaced rather than appended
  -- because a season reset back to draft_pending re-snapshots on its next start,
  -- and the newer list is the one worth restoring.
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

  -- If the first on-clock player is an auto-pick test bot, start drafting
  -- immediately instead of waiting out the first timer.
  PERFORM public.advance_bot_autopicks(p_league_id);

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;

-- Re-issues reset_draft (latest version from 20261006) with one behavior change:
-- each player's priority list is restored to the state it was in when the draft
-- started, instead of being deleted. Ownership check, idempotency on an already
-- pending season, the pick/roster/transaction teardown, the pause stamp clear,
-- and the returned status are all unchanged.
--
-- A season that started before this migration existed has no snapshot rows, in
-- which case the restore inserts nothing and the lists are left cleared exactly
-- as they were before.
--
-- @param p_league_id - The id of the league whose latest season to reset.
-- @returns The id and new (draft_pending) status of the season.
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