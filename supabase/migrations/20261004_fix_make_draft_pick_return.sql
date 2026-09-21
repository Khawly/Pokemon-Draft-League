-- Fix make_draft_pick's return-row shape
--
-- make_draft_pick declares RETURNS TABLE (season_id, overall_pick,
-- round_number, pick_in_round, status) but filled it with
-- `RETURN QUERY SELECT * FROM insert_draft_pick(...)`, which only supplies
-- (season_id, status). Postgres rejects the two-column row against the
-- five-column OUT list ("Returned type text does not match expected type
-- integer in column 2") the moment a real pick is attempted. The result is
-- now assembled explicitly from the resolved turn plus the inner insert's
-- status, preserving the intended API shape.

-- Recreates make_draft_pick with corrected RETURN QUERY projections for both
-- the pass and the normal pick path. Validates the turn, pool membership,
-- duplication, and salary before recording, exactly as before.
--
-- @param p_league_id - The league whose draft is being picked from.
-- @param p_pokemon_id - The slug of the Pokemon to draft (NULL to pass).
-- @returns The recorded pick's season/round/pick metadata and season status.
CREATE OR REPLACE FUNCTION public.make_draft_pick(
  p_league_id UUID,
  p_pokemon_id TEXT DEFAULT NULL
)
RETURNS TABLE (season_id UUID, overall_pick INTEGER, round_number INTEGER, pick_in_round INTEGER, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_turn RECORD;
  v_species TEXT;
  v_tier INTEGER;
  v_cost INTEGER;
  v_enable_costs BOOLEAN;
  v_per_team BOOLEAN;
  v_budget INTEGER;
  v_override INTEGER;
  v_spent INTEGER;
BEGIN
  -- Resolve and validate the on-turn team (raises for non-members/inactive).
  FOR v_turn IN SELECT * FROM public.get_draft_turn(p_league_id) LOOP
    EXIT;
  END LOOP;

  IF auth.uid() <> v_turn.on_turn_user_id THEN
    RAISE EXCEPTION 'It is not your turn to make a pick.';
  END IF;

  SELECT
    COALESCE(ls.enable_pokemon_costs, FALSE),
    COALESCE(ls.allow_per_team_salary, FALSE)
  INTO v_enable_costs, v_per_team
  FROM public.league_settings ls
  WHERE ls.season_id = v_turn.season_id;

  IF p_pokemon_id IS NULL THEN
    RETURN QUERY
    SELECT ins.season_id, v_turn.overall_pick, v_turn.round_number,
           v_turn.pick_in_round, ins.status
    FROM public.insert_draft_pick(
      p_league_id, v_turn.season_id, v_turn.team_id, auth.uid(),
      v_turn.round_number, v_turn.pick_in_round, v_turn.overall_pick,
      NULL, NULL, 0, 0, TRUE
    ) AS ins;
    RETURN;
  END IF;

  -- Resolve species/tier from the season's draft pool (any active pool, or all
  -- pools when none has been marked active), matching start_draft's scope.
  SELECT dpp.species_name, dpp.tier_value INTO v_species, v_tier
  FROM public.draft_pool_pokemon dpp
  JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
  WHERE dp.season_id = v_turn.season_id
    AND dpp.pokemon_id = p_pokemon_id
    AND dpp.is_in_pool = TRUE
    AND (
      dp.is_active = TRUE
      OR NOT EXISTS (
        SELECT 1 FROM public.draft_pools a
        WHERE a.season_id = v_turn.season_id AND a.is_active = TRUE
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That Pokemon is not in the draft pool.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.draft_picks d
    WHERE d.season_id = v_turn.season_id AND d.pokemon_id = p_pokemon_id
  ) THEN
    RAISE EXCEPTION 'That Pokemon has already been drafted.';
  END IF;

  -- Also refuse to re-draft a species already on any roster from earlier data.
  IF EXISTS (
    SELECT 1 FROM public.team_roster r
    JOIN public.teams t ON t.id = r.team_id
    WHERE t.season_id = v_turn.season_id AND r.pokemon_id = p_pokemon_id
  ) THEN
    RAISE EXCEPTION 'That Pokemon is already on a roster.';
  END IF;

  v_cost := 0;
  IF v_enable_costs THEN
    v_cost := v_tier;

    SELECT COALESCE(SUM(d.cost_delta), 0) INTO v_spent
    FROM public.draft_picks d
    WHERE d.season_id = v_turn.season_id AND d.team_id = v_turn.team_id;

    IF v_per_team THEN
      SELECT t.total_salary_override INTO v_override
      FROM public.teams t
      WHERE t.id = v_turn.team_id;
      v_budget := v_override;
    END IF;

    IF v_budget IS NULL THEN
      SELECT ls.total_token_salary INTO v_budget
      FROM public.league_settings ls
      WHERE ls.season_id = v_turn.season_id;
    END IF;

    IF v_budget IS NULL OR (v_budget - v_spent - v_cost) < 0 THEN
      RAISE EXCEPTION 'This pick would put your salary below 0.';
    END IF;
  END IF;

  RETURN QUERY
  SELECT ins.season_id, v_turn.overall_pick, v_turn.round_number,
         v_turn.pick_in_round, ins.status
  FROM public.insert_draft_pick(
    p_league_id, v_turn.season_id, v_turn.team_id, auth.uid(),
    v_turn.round_number, v_turn.pick_in_round, v_turn.overall_pick,
    p_pokemon_id, v_species, v_tier, v_cost, FALSE
  ) AS ins;
  RETURN;
END;
$$;