-- Fix team_salary_totals: unaliased columns produced a record with no such fields
--
-- Approving a trade failed with:
--
--   ERROR: record "v_team" has no field "allow_per_team_salary"
--
-- The function reads the team's settings into a plpgsql record:
--
--   SELECT
--     t.id, t.season_id, t.total_salary_override,
--     COALESCE(ls.enable_pokemon_costs, FALSE),
--     COALESCE(ls.allow_per_team_salary, FALSE),
--     ls.total_token_salary
--   INTO v_team
--
-- A `SELECT ... INTO record` names each field after the result *column*, not after
-- whatever produced it. Bare columns like `t.id` keep their names, but an unaliased
-- expression is named after the function that computed it, so both of those fields
-- are called `coalesce` -- the second one silently takes a suffixed name of its own.
-- `v_team.allow_per_team_salary` and `v_team.enable_pokemon_costs` therefore refer to
-- fields that do not exist, and the function fails on the first of them.
--
-- Aliasing the two expressions gives the record the field names the rest of the body
-- expects. Nothing else about the function changes; the body below is carried over
-- from 20261103 with only the two aliases added, and diffed to prove it.
--
-- Only team_salary_totals is re-created here. complete_trade is untouched, because
-- this is the second defect on the same path: the alias collision in 20261105 and the
-- named-argument name in 20261106 were both in complete_trade, and this one is in the
-- helper it calls. Each was invisible to review because a record field and a named
-- argument both look like the name they ought to have.
--
-- The trade is still in 'pending_approval' with no roster row moved and no ledger row
-- written, because the failure happens before any write and the transaction rolls
-- back.
CREATE OR REPLACE FUNCTION public.team_salary_totals(p_team_id UUID)
RETURNS TABLE (budget INTEGER, spent INTEGER, remaining INTEGER)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team RECORD;
  v_per_team BOOLEAN;
  v_budget INTEGER;
  v_spent INTEGER;
BEGIN
  SELECT
    t.id, t.season_id, t.total_salary_override,
    COALESCE(ls.enable_pokemon_costs, FALSE) AS enable_pokemon_costs,
    COALESCE(ls.allow_per_team_salary, FALSE) AS allow_per_team_salary,
    ls.total_token_salary
  INTO v_team
  FROM public.teams t
  LEFT JOIN public.league_settings ls ON ls.season_id = t.season_id
  WHERE t.id = p_team_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That team does not exist.';
  END IF;

  v_per_team := v_team.allow_per_team_salary;
  v_budget := CASE
    WHEN v_per_team AND v_team.total_salary_override IS NOT NULL
      THEN v_team.total_salary_override
    ELSE v_team.total_token_salary
  END;

  SELECT COALESCE(SUM(tr.cost_delta), 0) INTO v_spent
  FROM public.transactions tr
  WHERE tr.team_id = p_team_id;

  -- Costs disabled means the app treats the salary as unlimited rather than zero,
  -- so the caller has to be able to tell that apart from being broke. A null budget
  -- and a null remaining are that signal; the spend is irrelevant when nothing is
  -- charged for it, so it reads as zero rather than as a real ledger sum.
  IF NOT v_team.enable_pokemon_costs THEN
    RETURN QUERY SELECT NULL::INTEGER, 0, NULL::INTEGER;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    COALESCE(v_budget, 0),
    v_spent,
    COALESCE(v_budget, 0) - v_spent;
END;
$$;

-- No GRANT: only complete_trade calls this, and it runs as its own definer.
REVOKE ALL ON FUNCTION public.team_salary_totals(UUID) FROM PUBLIC;

-- Force PostgREST to pick up the new function body immediately.
NOTIFY pgrst, 'reload schema';
