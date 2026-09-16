-- Active draft pool selection
--
-- Adds draft_pools.is_active so a season can mark exactly one saved pool as the
-- pool the draft will use, enforces that with a partial unique index, and adds a
-- SECURITY DEFINER RPC to switch the active pool atomically (owner-only). Also
-- re-scopes start_draft to count only the active pool when one is set.

-- Flag marking the one pool a season uses for the draft.
ALTER TABLE public.draft_pools
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE;

-- At most one active draft pool per season; the partial index only covers rows
-- where is_active is true so inactive pools are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS draft_pools_one_active_per_season_uk
  ON public.draft_pools (season_id)
  WHERE is_active;

-- SECURITY DEFINER RPC that switches the active pool for the target pool's
-- season. Only the league owner may call it. Deactivates any other active pool
-- in the season before activating the target so the partial unique index is
-- never violated, and returns the activated pool id.
CREATE OR REPLACE FUNCTION public.set_active_draft_pool(p_pool_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_league_id UUID;
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to set the active pool.';
  END IF;

  SELECT dp.league_id, dp.season_id INTO v_league_id, v_season_id
  FROM public.draft_pools dp
  WHERE dp.id = p_pool_id;

  IF v_league_id IS NULL THEN
    RAISE EXCEPTION 'That draft pool does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = v_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can set the active pool.';
  END IF;

  UPDATE public.draft_pools
  SET is_active = FALSE
  WHERE season_id = v_season_id AND is_active = TRUE AND id <> p_pool_id;

  UPDATE public.draft_pools
  SET is_active = TRUE
  WHERE id = p_pool_id;

  RETURN p_pool_id;
END;
$$;

-- SECURITY DEFINER RPC that transitions the latest season of a league into
-- draft_active. Only the league owner may call it; the function then enforces
-- the full pre-draft checklist: a season exists and is not already active or
-- complete, every team slot is filled, every team has a draft_position, and the
-- active draft pool contains at least one in-pool Pokemon. Falls back to
-- counting every pool in the season when no active pool has been set.
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
  v_team_count INTEGER;
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

  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  IF v_team_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: fill all team slots first (% of % filled).',
      v_team_count,
      v_max_players;
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_assigned_count
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = v_season_id
    AND t.draft_position IS NOT NULL;

  IF v_assigned_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: assign a draft position to every team (%).',
      v_assigned_count;
  END IF;

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
  SET status = 'draft_active', draft_started_at = NOW()
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;

-- Force PostgREST to pick up the new RPC/function signatures immediately so
-- `set_active_draft_pool` is callable without waiting for a schema-cache refresh.
NOTIFY pgrst, 'reload schema';
