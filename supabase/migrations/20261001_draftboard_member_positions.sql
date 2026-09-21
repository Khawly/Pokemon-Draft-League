-- Draft positions as per-player slots
--
-- The draft order is now owned by each player (league member) instead of a
-- separate team row: league_members gains draft_position, unique per league.
-- start_draft validates member positions and auto-creates (or syncs) one
-- backing team row per active member, position-synced, so the pick ledger,
-- rosters, and transactions keep their team foreign keys intact.

-- Per-player draft order slot; NULL means unassigned. Unique per league
-- among assigned members, matching the integer-column UX on the draft board.
ALTER TABLE public.league_members
  ADD COLUMN IF NOT EXISTS draft_position INTEGER;

DROP INDEX IF EXISTS league_members_league_draft_position_uk;
CREATE UNIQUE INDEX league_members_league_draft_position_uk
  ON public.league_members (league_id, draft_position)
  WHERE draft_position IS NOT NULL;

-- Rewrites start_draft so the pre-flight checklist runs against player slots:
-- the league needs a full active roster (number_of_players) with every member
-- holding a draft_position, plus an in-pool Pokemon. Ordered active members
-- are then mirrored into one teams row each (team_name from the profile,
-- draft_position synced from the member) because the draft engine, pick
-- ledger, rosters, and transactions all key off team_id. Idempotent: an
-- existing team row for a member is updated, never duplicated.
--
-- @param p_league_id - The id of the league whose draft is being started.
-- @returns The id and new status of the started season.
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
  -- pick ledger / roster / transaction tables keep working unchanged.
  INSERT INTO public.teams (league_id, season_id, owner_user_id, team_name, draft_position)
  SELECT lm.league_id, v_season_id, lm.user_id,
         COALESCE(p.display_name, 'Player ' || substr(lm.user_id::text, 1, 8)),
         lm.draft_position
  FROM public.league_members lm
  LEFT JOIN public.profiles p ON p.id = lm.user_id
  WHERE lm.league_id = p_league_id AND lm.is_active = TRUE
  ON CONFLICT (league_id, season_id, owner_user_id)
  DO UPDATE SET draft_position = EXCLUDED.draft_position;

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

  UPDATE public.seasons
  SET status = 'draft_active', draft_started_at = NOW(), draft_pick_started_at = NOW()
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;