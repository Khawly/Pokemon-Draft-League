-- Sync per-member token salary overrides from the Members Settings page into
-- every team row so the Teams / Pokemon / Draft pages and the SQL draft-engine
-- budget checks reflect the owner's changes immediately.
--
-- The Members Settings page used to write only league_members.total_token_salary
-- (a column nothing else reads), while all salary display and enforcement reads
-- teams.total_salary_override. This migration adds a single RPC that writes both
-- places atomically, and teaches start_draft to backfill the override from the
-- member record when it mirrors team rows.

-- RPC that sets one active member's total token salary and mirrors it onto every
-- team the member owns in the league (across all seasons). Owner-only guarded by
-- SECURITY DEFINER so RLS cannot block the cross-table write.
CREATE OR REPLACE FUNCTION public.update_league_member_salary(
  p_league_id UUID,
  p_user_id UUID,
  p_total_token_salary INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_active_member BOOLEAN;
BEGIN
  -- Only the league owner may set another member's budget.
  IF NOT is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can update member token salaries.';
  END IF;

  -- Per-member salaries only apply when the league has opted in.
  IF NOT EXISTS (
    SELECT 1 FROM public.league_settings ls
    WHERE ls.league_id = p_league_id
      AND ls.allow_per_team_salary = TRUE
  ) THEN
    RAISE EXCEPTION 'Per-team token salaries are not enabled for this league.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = p_league_id
      AND lm.user_id = p_user_id
      AND lm.is_active = TRUE
  ) INTO v_is_active_member;

  IF NOT v_is_active_member THEN
    RAISE EXCEPTION 'This league has no active member with that user id.';
  END IF;

  IF p_total_token_salary IS NULL OR p_total_token_salary < 0 THEN
    RAISE EXCEPTION 'Total token salary must be a non-negative whole number.';
  END IF;

  UPDATE public.league_members lm
  SET total_token_salary = p_total_token_salary
  WHERE lm.league_id = p_league_id
    AND lm.user_id = p_user_id;

  -- Mirror the override onto every team the member owns in this league so the
  -- salary read paths (teams.total_salary_override) pick it up everywhere.
  UPDATE public.teams t
  SET total_salary_override = p_total_token_salary
  WHERE t.league_id = p_league_id
    AND t.owner_user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_league_member_salary(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_league_member_salary(UUID, UUID, INTEGER) TO authenticated;

-- Re-issue start_draft (latest version from 20261008) so the team rows it
-- mirrors from league_members also copy the member's salary into
-- teams.total_salary_override instead of leaving it NULL. Salary guards and
-- every other behavior are unchanged.
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