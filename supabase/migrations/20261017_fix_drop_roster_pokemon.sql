-- Fix drop_roster_pokemon ambiguity and refund sign
--
-- Re-creates `drop_roster_pokemon` from 20261015 with two corrections:
--   1. The DELETE now qualifies its columns with a table alias. The original
--      `WHERE team_id = ...` collided with the function's own RETURNS TABLE
--      output parameter `team_id`, producing "column reference 'team_id' is
--      ambiguous".
--   2. The refund is recorded as a negative cost_delta (costs are positive,
--      refunds negative) so the transaction history renders a drop as `+N` and
--      the ledger reconciles against the roster tier total.
--
-- Written as a standalone migration so it is re-appliable even though
-- 20261015 is already applied by name.
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

  INSERT INTO public.transactions (
    league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
    cost_delta, note
  ) VALUES (
    p_league_id, v_season_id, v_user_id, v_team_id, p_pokemon_id, 'dropped',
    1, -v_refund, 'Released from the roster'
  );

  -- The alias disambiguates the columns from the RETURNS TABLE output
  -- parameter also named `team_id`.
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

-- Force PostgREST to pick up the new function body immediately.
NOTIFY pgrst, 'reload schema';