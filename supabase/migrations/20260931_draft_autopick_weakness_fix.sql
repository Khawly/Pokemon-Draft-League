-- Fixes pokemon_weaknesses introduced in 20260930: the exp(sum(ln(...)))
-- product glows on immunities (ln(0) raises) and floating-point rounding can
-- misclassify an exact 1.0x neutral matchup. Since each attacking type has at
-- most two chart rows per defender, the net multiplier is exactly: weak iff at
-- least one row is 2x, no row is 0 (immune), and no row is 0.5 (halved). This
-- boolean version is integer-exact and immune to ln(0).

-- @param p_primary - The Pokemon's primary normalized type, e.g. "fire".
-- @param p_secondary - The Pokemon's secondary normalized type, or NULL.
-- @returns The distinct attacking types the Pokemon is weak to (2x or 4x).
CREATE OR REPLACE FUNCTION public.pokemon_weaknesses(
  p_primary TEXT,
  p_secondary TEXT
)
RETURNS SETOF TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT c.attacking
  FROM public.type_chart c
  WHERE c.defending = lower(p_primary)
     OR (p_secondary IS NOT NULL AND c.defending = lower(p_secondary))
  GROUP BY c.attacking
  HAVING bool_or(c.multiplier = 2)
     AND NOT bool_or(c.multiplier = 0)
     AND NOT bool_or(c.multiplier = 0.5);
$$;