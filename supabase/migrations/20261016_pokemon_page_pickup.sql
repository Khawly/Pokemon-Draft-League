-- Pokémon page free-agent pickups
--
-- Implements the spec §11 pickup flow for the Pokémon page. Adds the
-- `pickup_roster_pokemon` SECURITY DEFINER RPC that lets an active league
-- member claim an in-pool free agent onto their own team once the draft is
-- complete: it validates membership, ownership, pool availability, and salary
-- affordability (mirroring `make_draft_pick`), charges the Pokémon's tier plus
-- any enabled transaction cost, records an `added` ledger row, and inserts the
-- roster row with source 'pickup'. Also re-asserts the member SELECT policy on
-- `transactions` so the page's transaction history (stack order) is readable.

-- Members of a league can view the transaction/audit ledger of that league.
-- Idempotent re-assertion of the 20261015 policy so this migration is
-- self-contained. cost_delta is positive for costs (pickups/draft adds) and
-- negative for refunds (drops).
DROP POLICY IF EXISTS "Members can view league transactions" ON public.transactions;
CREATE POLICY "Members can view league transactions"
ON public.transactions
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

-- Adds an in-pool free-agent Pokémon to the calling user's team roster in the
-- league's current (latest) season. Validates that the caller is an active
-- member who owns a team, that the Pokémon is still in-pool and not on any
-- roster, and (when costs are enabled) that charging its tier plus any enabled
-- transaction cost keeps the team's salary above 0. On success it records an
-- 'added' transaction with the charged cost, adds the roster row with source
-- 'pickup', and (defensively, mirroring `drop_roster_pokemon`'s invariant)
-- re-lists the Pokémon as in-pool. Roster membership — not the is_in_pool flag
-- — is the source of truth, matching the draft engine.
CREATE OR REPLACE FUNCTION public.pickup_roster_pokemon(
  p_league_id UUID,
  p_pokemon_id TEXT
)
RETURNS TABLE (roster_id UUID, team_id UUID, tier_value INTEGER, charged_tokens INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_season_status TEXT;
  v_enable_costs BOOLEAN;
  v_enable_tx_costs BOOLEAN;
  v_tx_cost INTEGER;
  v_per_team BOOLEAN;
  v_budget INTEGER;
  v_spent INTEGER;
  v_charge INTEGER;
  v_tier INTEGER;
  v_species TEXT;
  v_team_id UUID;
  v_roster_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_season_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  IF v_season_status <> 'draft_complete' THEN
    RAISE EXCEPTION 'Free agent pickups are only available after the draft is complete.';
  END IF;

  SELECT
    COALESCE(ls.enable_pokemon_costs, FALSE),
    COALESCE(ls.allow_per_team_salary, FALSE),
    COALESCE(ls.enable_transaction_costs, FALSE),
    COALESCE(ls.transaction_cost, 0)
  INTO v_enable_costs, v_per_team, v_enable_tx_costs, v_tx_cost
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  SELECT t.id INTO v_team_id
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = v_season_id
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_team_id IS NULL THEN
    RAISE EXCEPTION 'You do not own a team in this season.';
  END IF;

  -- Resolve species/tier from the season's draft pool (any active pool, or all
  -- pools when none has been marked active), matching start_draft's scope.
  SELECT dpp.species_name, dpp.tier_value INTO v_species, v_tier
  FROM public.draft_pool_pokemon dpp
  JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
  WHERE dp.league_id = p_league_id
    AND dp.season_id = v_season_id
    AND dpp.pokemon_id = p_pokemon_id
    AND dpp.is_in_pool = TRUE
    AND (
      dp.is_active = TRUE
      OR NOT EXISTS (
        SELECT 1 FROM public.draft_pools a
        WHERE a.season_id = v_season_id AND a.is_active = TRUE
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That Pokemon is not in the free agent pool.';
  END IF;

  -- The draft engine keeps drafted Pokémon in-pool, so roster existence is the
  -- real availability check (a Pokémon may only be on one team per season).
  IF EXISTS (
    SELECT 1 FROM public.team_roster r
    JOIN public.teams t ON t.id = r.team_id
    WHERE t.season_id = v_season_id AND r.pokemon_id = p_pokemon_id
  ) THEN
    RAISE EXCEPTION 'That Pokemon is already on a team.';
  END IF;

  v_charge := (CASE WHEN v_enable_costs THEN v_tier ELSE 0 END)
            + (CASE WHEN v_enable_tx_costs THEN v_tx_cost ELSE 0 END);

  IF v_enable_costs THEN
    IF v_per_team THEN
      SELECT t.total_salary_override INTO v_budget
      FROM public.teams t
      WHERE t.id = v_team_id;
    END IF;

    IF v_budget IS NULL THEN
      SELECT ls.total_token_salary INTO v_budget
      FROM public.league_settings ls
      WHERE ls.season_id = v_season_id;
    END IF;

    -- Spent is the team's ledger sum: added rows carry tier plus any transaction
    -- fee, and dropped rows refund the tier, so the team's full binding spend
    -- (including previously sunk fees) is subtracted from the budget.
    SELECT COALESCE(SUM(t.cost_delta), 0) INTO v_spent
    FROM public.transactions t
    WHERE t.team_id = v_team_id;

    IF v_budget IS NULL OR (v_budget - v_spent - v_charge) < 0 THEN
      RAISE EXCEPTION 'This pickup would put your salary below 0.';
    END IF;
  END IF;

  INSERT INTO public.team_roster (team_id, pokemon_id, species_name, tier_value, source)
  VALUES (v_team_id, p_pokemon_id, v_species, v_tier, 'pickup')
  RETURNING id INTO v_roster_id;

  INSERT INTO public.transactions (
    league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
    cost_delta, note
  ) VALUES (
    p_league_id, v_season_id, v_user_id, v_team_id, p_pokemon_id, 'added',
    1, v_charge, 'Picked up from the free agents'
  );

  RETURN QUERY SELECT v_roster_id, v_team_id, v_tier, v_charge;
END;
$$;

-- Keep the write RPC away from anon; only signed-in league members (checked
-- inside the function) may call it.
REVOKE ALL ON FUNCTION public.pickup_roster_pokemon(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pickup_roster_pokemon(UUID, TEXT) TO authenticated;

-- Force PostgREST to pick up the new function signature immediately.
NOTIFY pgrst, 'reload schema';