-- Team page reads and the drop_roster_pokemon RPC
--
-- The Team page reads match history and the transaction/audit ledger, but
-- `matches`, `match_results`, and `transactions` only had RLS enabled with no
-- policies, so league members could not read them (RLS denies by default).
-- This migration:
--   - adds member SELECT policies for matches, match_results, and transactions
--   - lets league owners/admins DELETE a match and its results (the Team page's
--     owner/admin-only "Delete" column in match history)
--   - adds drop_roster_pokemon, a SECURITY DEFINER RPC that validates the
--     caller owns the roster slot in the current season, refunds the Pokemon's
--     tier cost into the team's token salary via a transaction ledger row,
--     removes it from the roster, and re-sets it as in-pool (free agent)

-- Members of a league can view that league's scheduled matches.
DROP POLICY IF EXISTS "Members can view league matches" ON public.matches;
CREATE POLICY "Members can view league matches"
ON public.matches
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

-- Only the league owner or an admin may delete a match (removes the scheduled
-- head-to-head and, via ON DELETE CASCADE, its results).
DROP POLICY IF EXISTS "League staff can delete matches" ON public.matches;
CREATE POLICY "League staff can delete matches"
ON public.matches
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.league_members lm
    WHERE lm.league_id = matches.league_id
      AND lm.user_id = auth.uid()
      AND lm.is_active = TRUE
      AND lm.role IN ('owner', 'admin')
  )
);

-- Members of a league can view a match's reported results by joining through
-- the match row to the league membership check.
DROP POLICY IF EXISTS "Members can view league match results" ON public.match_results;
CREATE POLICY "Members can view league match results"
ON public.match_results
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.matches m
    WHERE m.id = match_results.match_id
      AND public.is_active_league_member(m.league_id)
  )
);

-- Only the league owner or an admin can delete reported match results.
DROP POLICY IF EXISTS "League staff can delete match results" ON public.match_results;
CREATE POLICY "League staff can delete match results"
ON public.match_results
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.matches m
    JOIN public.league_members lm
      ON lm.league_id = m.league_id
    WHERE m.id = match_results.match_id
      AND lm.user_id = auth.uid()
      AND lm.is_active = TRUE
      AND lm.role IN ('owner', 'admin')
  )
);

-- Members of a league can view the transaction/audit ledger of that league.
-- cost_delta is positive for costs (draft adds) and negative for refunds
-- (drops), so a team's salary can be reconciled from this ledger.
DROP POLICY IF EXISTS "Members can view league transactions" ON public.transactions;
CREATE POLICY "Members can view league transactions"
ON public.transactions
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

-- Drops a Pokemon from the calling user's team roster in the league's current
-- (latest) season. Validates that the caller owns the roster slot, then records
-- a 'dropped' transaction refunding the Pokemon's tier cost into the team's
-- token salary, removes the roster row, and re-marks the Pokemon as in-pool so
-- it is free-agent eligible again. Only allowed once the draft is complete.
CREATE OR REPLACE FUNCTION public.drop_roster_pokemon(
  p_league_id UUID,
  p_pokemon_id TEXT
)
RETURNS TABLE (team_id UUID, refunded_tokens INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_season_status TEXT;
  v_enable_costs BOOLEAN;
  v_team_id UUID;
  v_tier INTEGER;
  v_refund INTEGER;
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
    RAISE EXCEPTION 'Rosters can only be changed after the draft is complete.';
  END IF;

  SELECT COALESCE(ls.enable_pokemon_costs, FALSE) INTO v_enable_costs
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

  SELECT r.tier_value INTO v_tier
  FROM public.team_roster r
  WHERE r.team_id = v_team_id AND r.pokemon_id = p_pokemon_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That Pokemon is not on your roster.';
  END IF;

  v_refund := CASE WHEN v_enable_costs THEN v_tier ELSE 0 END;

  -- Record the refund as a negative cost_delta (costs are positive, refunds
  -- negative) so the transaction history renders it as a `+N` reimbursement and
  -- the ledger reconciles against the roster tier total.
  INSERT INTO public.transactions (
    league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
    cost_delta, note
  ) VALUES (
    p_league_id, v_season_id, v_user_id, v_team_id, p_pokemon_id, 'dropped',
    1, -v_refund, 'Released from the roster'
  );

  -- Qualify the DELETE columns with a table alias: the RETURNS TABLE output
  -- parameter `team_id` shares the roster column's name, which otherwise makes
  -- the reference ambiguous.
  DELETE FROM public.team_roster r
  WHERE r.team_id = v_team_id AND r.pokemon_id = p_pokemon_id;

  -- Re-list the Pokemon in every pool for the current season so it is
  -- free-agent eligible again (invariant: a Pokemon is either in-pool or on
  -- exactly one roster, never both).
  UPDATE public.draft_pool_pokemon dpp
  SET is_in_pool = TRUE, updated_at = NOW()
  FROM public.draft_pools dp
  WHERE dp.league_id = p_league_id
    AND dp.season_id = v_season_id
    AND dp.id = dpp.draft_pool_id
    AND dpp.pokemon_id = p_pokemon_id
    AND dpp.is_in_pool = FALSE;

  RETURN QUERY SELECT v_team_id, v_refund;
END;
$$;

-- Keep the write RPC away from anon; only signed-in league members (checked
-- inside the function) may call it.
REVOKE ALL ON FUNCTION public.drop_roster_pokemon(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drop_roster_pokemon(UUID, TEXT) TO authenticated;

-- Force PostgREST to pick up the new policies/function immediately.
NOTIFY pgrst, 'reload schema';