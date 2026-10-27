-- League owners can remove a Pokemon from any team's roster
--
-- The Teams page's Drop control originally only worked on the signed-in member's
-- own roster. The league owner now needs to release a Pokemon from any team —
-- for example when a member asks them to fix a roster — with the same refund
-- semantics as a member's own drop: the Pokemon's tier is credited back to the
-- team that loses it (when Pokemon costs are enabled) and the Pokemon returns to
-- the free agent pool.
--
-- This replaces the two-argument `drop_roster_pokemon` with the same function
-- plus one optional argument:
--
--   p_team_id  target team; NULL keeps the original "my own team" behaviour.
--              A non-owner may only name their own team.
--
-- The draft window mirrors 20261172_owner_pre_draft_pickups.sql: members need
-- `draft_complete`, the owner may also work while the season is `draft_pending`,
-- and nobody may change rosters while the draft is running.
--
-- Refunds stay tier-only. A transaction fee is sunk when it is charged, so
-- removing the Pokemon returns what its roster slot cost, not every token ever
-- spent acquiring it. This is the same rule the member drop already followed.

-- The old signature has to be dropped rather than replaced: PostgreSQL cannot add
-- parameters to an existing function with CREATE OR REPLACE. The new signature
-- keeps the original two arguments first and gives the new one a default, so
-- existing callers that pass only league and Pokemon keep working.
DROP FUNCTION IF EXISTS public.drop_roster_pokemon(UUID, TEXT);

-- Removes a Pokemon from a team roster in the league's current (latest) season.
-- The caller must be an active member; targeting a team they do not own requires
-- being the league owner. Validates the season state, records a 'dropped'
-- transaction that refunds the target team's tier cost (when costs are enabled),
-- deletes the roster row, and re-lists the Pokemon as a free agent. Returns the
-- target team and the tokens refunded.
CREATE OR REPLACE FUNCTION public.drop_roster_pokemon(
  p_league_id UUID,
  p_pokemon_id TEXT,
  p_team_id UUID DEFAULT NULL
)
RETURNS TABLE (team_id UUID, refunded_tokens INTEGER)
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
  v_team_id UUID;
  v_team_owner_id UUID;
  v_tier INTEGER;
  v_refund INTEGER;
  v_note TEXT := 'Released from the roster';
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  v_is_owner := public.is_league_owner(p_league_id);

  SELECT s.id, s.status INTO v_season_id, v_season_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  IF v_season_status = 'draft_active' THEN
    RAISE EXCEPTION 'Rosters cannot be changed while the draft is in progress.';
  END IF;

  IF v_season_status <> 'draft_complete'
     AND NOT (v_season_status = 'draft_pending' AND v_is_owner) THEN
    RAISE EXCEPTION 'Rosters can only be changed after the draft is complete.';
  END IF;

  SELECT COALESCE(ls.enable_pokemon_costs, FALSE) INTO v_enable_costs
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  IF p_team_id IS NULL THEN
    -- Original behaviour: the member's own team.
    SELECT t.id, t.owner_user_id INTO v_team_id, v_team_owner_id
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
      RAISE EXCEPTION 'Only the league owner can remove Pokemon from another team.';
    END IF;
  END IF;

  SELECT r.tier_value INTO v_tier
  FROM public.team_roster r
  WHERE r.team_id = v_team_id AND r.pokemon_id = p_pokemon_id;

  IF NOT FOUND THEN
    IF p_team_id IS NULL THEN
      RAISE EXCEPTION 'That Pokemon is not on your roster.';
    ELSE
      RAISE EXCEPTION 'That Pokemon is not on that team''s roster.';
    END IF;
  END IF;

  v_refund := CASE WHEN v_enable_costs THEN v_tier ELSE 0 END;

  -- An owner acting on somebody else's team leaves that fact in the audit trail;
  -- the transaction's user_id already names the actor, but the note makes the
  -- reason readable without joining to the team row.
  IF v_team_owner_id IS DISTINCT FROM v_user_id THEN
    v_note := 'Removed from the roster by the league owner';
  END IF;

  -- Record the refund as a negative cost_delta (costs are positive, refunds
  -- negative) so the transaction history renders it as a `+N` reimbursement and
  -- the ledger reconciles against the roster tier total.
  INSERT INTO public.transactions (
    league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
    cost_delta, note
  ) VALUES (
    p_league_id, v_season_id, v_user_id, v_team_id, p_pokemon_id, 'dropped',
    1, -v_refund, v_note
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
REVOKE ALL ON FUNCTION public.drop_roster_pokemon(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drop_roster_pokemon(UUID, TEXT, UUID) TO authenticated;

-- Force PostgREST to pick up the new function signature immediately.
NOTIFY pgrst, 'reload schema';
