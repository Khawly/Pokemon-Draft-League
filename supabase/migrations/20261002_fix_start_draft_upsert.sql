-- Fix ambiguous season_id reference in start_draft
--
-- Postgres raises "column reference season_id is ambiguous" on
-- INSERT ... ON CONFLICT (league_id, season_id, owner_user_id) inside
-- start_draft because the bare conflict-target column collides with the
-- function's RETURNS TABLE (season_id, status) OUT parameter (a PL/pgSQL
-- quirk specific to ON CONFLICT; ordinary column references are unaffected).
-- The upsert is therefore reimplemented as update-then-insert with every
-- identifier schema/table-qualified so no bare column name can collide.

-- Recreates start_draft with the team-mirroring step corrected. Behavior is
-- unchanged: one team row per active member, draft_position synced from the
-- member, idempotent for rows that already exist.
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
  -- pick ledger / roster / transaction tables keep working unchanged. Rewritten
  -- as update-then-insert (all identifiers qualified) to avoid the ambiguous
  -- column reference the ON CONFLICT clause raises next to the OUT parameters.
  UPDATE public.teams t
  SET draft_position = lm.draft_position
  FROM public.league_members lm
  WHERE t.league_id = p_league_id
    AND t.season_id = v_season_id
    AND t.owner_user_id = lm.user_id
    AND lm.league_id = p_league_id
    AND lm.is_active = TRUE;

  INSERT INTO public.teams (league_id, season_id, owner_user_id, team_name, draft_position)
  SELECT lm.league_id, v_season_id, lm.user_id,
         COALESCE(p.display_name, 'Player ' || substr(lm.user_id::text, 1, 8)),
         lm.draft_position
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

  UPDATE public.seasons
  SET status = 'draft_active', draft_started_at = NOW(), draft_pick_started_at = NOW()
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;