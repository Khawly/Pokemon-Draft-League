-- Allows the league owner to pick up free agents before the draft begins.
--
-- Free agent pickups were gated on the season being `draft_complete`. The owner
-- now also needs to place a Pokemon while the season is still `draft_pending`,
-- for example to pre-assign a team's roster before the draft turns over (the
-- new season copies its team rows from the previous one, so the target teams
-- already exist).
--
-- Members are unchanged: their pickups still unlock only once the draft is
-- complete. The draft itself remains a closed window for everyone, because a
-- pickup during `draft_active` would race the draft engine for the pool.
--
-- This only replaces the status gate. Signature, ownership rules, the
-- transaction-fee waiver, pool availability, and affordability are unchanged
-- from 20261171_owner_free_agent_any_team.sql.

CREATE OR REPLACE FUNCTION public.pickup_roster_pokemon(
  p_league_id UUID,
  p_pokemon_id TEXT,
  p_team_id UUID DEFAULT NULL,
  p_waive_transaction_cost BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (roster_id UUID, team_id UUID, tier_value INTEGER, charged_tokens INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_is_owner BOOLEAN;
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
  v_team_owner_id UUID;
  v_roster_id UUID;
  v_waive BOOLEAN := COALESCE(p_waive_transaction_cost, FALSE);
  v_note TEXT := 'Picked up from the free agents';
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  v_is_owner := public.is_league_owner(p_league_id);

  -- A waiver is a league-owner override of the configured fee, never a member
  -- option, so reject it outright instead of silently charging the fee.
  IF v_waive AND NOT v_is_owner THEN
    RAISE EXCEPTION 'Only the league owner can waive the transaction cost.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_season_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  /*
   * Members unlock after the draft. The owner may also work while the season is
   * still pending, but never during the draft itself: the draft engine is
   * claiming from the same pool and a concurrent pickup would make both sides
   * disagree about who owns the Pokemon.
   */
  IF v_season_status = 'draft_active' THEN
    RAISE EXCEPTION 'Free agent pickups are not available while the draft is in progress.';
  END IF;

  IF v_season_status <> 'draft_complete'
     AND NOT (v_season_status = 'draft_pending' AND v_is_owner) THEN
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

  IF p_team_id IS NULL THEN
    -- Original behaviour: the member's own team.
    SELECT t.id INTO v_team_id
    FROM public.teams t
    WHERE t.league_id = p_league_id
      AND t.season_id = v_season_id
      AND t.owner_user_id = v_user_id
    LIMIT 1;

    IF v_team_id IS NULL THEN
      RAISE EXCEPTION 'You do not own a team in this season.';
    END IF;
  ELSE
    -- The target must belong to this league season, and only the league owner may
    -- name a team the caller does not own.
    SELECT t.id, t.owner_user_id INTO v_team_id, v_team_owner_id
    FROM public.teams t
    WHERE t.id = p_team_id
      AND t.league_id = p_league_id
      AND t.season_id = v_season_id
    LIMIT 1;

    IF v_team_id IS NULL THEN
      RAISE EXCEPTION 'That team is not part of this season.';
    END IF;

    IF v_team_owner_id <> v_user_id AND NOT v_is_owner THEN
      RAISE EXCEPTION 'Only the league owner can add free agents to another team.';
    END IF;
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

  -- The draft engine keeps drafted Pokemon in-pool, so roster existence is the
  -- real availability check (a Pokemon may only be on one team per season).
  IF EXISTS (
    SELECT 1 FROM public.team_roster r
    JOIN public.teams t ON t.id = r.team_id
    WHERE t.season_id = v_season_id AND r.pokemon_id = p_pokemon_id
  ) THEN
    RAISE EXCEPTION 'That Pokemon is already on a team.';
  END IF;

  v_charge := (CASE WHEN v_enable_costs THEN v_tier ELSE 0 END)
            + (CASE WHEN v_enable_tx_costs AND NOT v_waive THEN v_tx_cost ELSE 0 END);

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

    -- Spent is the target team's ledger sum: added rows carry tier plus any
    -- transaction fee, and dropped rows refund the tier, so the team's full
    -- binding spend (including previously sunk fees) is subtracted from the
    -- budget.
    SELECT COALESCE(SUM(t.cost_delta), 0) INTO v_spent
    FROM public.transactions t
    WHERE t.team_id = v_team_id;

    IF v_budget IS NULL OR (v_budget - v_spent - v_charge) < 0 THEN
      RAISE EXCEPTION 'This pickup would put the team salary below 0.';
    END IF;
  END IF;

  INSERT INTO public.team_roster (team_id, pokemon_id, species_name, tier_value, source)
  VALUES (v_team_id, p_pokemon_id, v_species, v_tier, 'pickup')
  RETURNING id INTO v_roster_id;

  -- Leave an audit trail for the waiver: the ledger's cost_delta alone cannot
  -- distinguish a league with transaction costs disabled from one where the owner
  -- skipped the fee, and a later review will want to know which happened.
  IF v_waive AND v_enable_tx_costs AND v_tx_cost > 0 THEN
    v_note := v_note || ' (transaction cost waived by the league owner)';
  END IF;

  INSERT INTO public.transactions (
    league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
    cost_delta, note
  ) VALUES (
    p_league_id, v_season_id, v_user_id, v_team_id, p_pokemon_id, 'added',
    1, v_charge, v_note
  );

  RETURN QUERY SELECT v_roster_id, v_team_id, v_tier, v_charge;
END;
$$;

-- Keep the write RPC away from anon; only signed-in league members (checked
-- inside the function) may call it.
REVOKE ALL ON FUNCTION public.pickup_roster_pokemon(UUID, TEXT, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pickup_roster_pokemon(UUID, TEXT, UUID, BOOLEAN) TO authenticated;

-- Force PostgREST to pick up the replaced function immediately.
NOTIFY pgrst, 'reload schema';
