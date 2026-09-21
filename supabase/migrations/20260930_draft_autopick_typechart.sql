-- Fixes the weakness resolver shipped in 20260929: the original
-- `pokemon_weaknesses` only unioned weaknesses from each type separately and
-- did not account for (a) immunities, e.g. Flying blocking Ground, nor (b)
-- reduced multipliers from the secondary type, e.g. Ice being only 0.5x
-- against Fire so Charizard (Fire/Flying) is NOT weak to Ice. This migration
-- replaces it with a full standard type chart plus a function that multiplies
-- the two types' multipliers so 4x weaknesses, halved resistances, and
-- immunities all reflect the true damage profile.

-- Full type-effectiveness chart. Columns: defending type, attacking type, damage
-- multiplier (1 neutral, 2 super-effective, 0.5 not very effective, 0 immune).
CREATE TABLE IF NOT EXISTS public.type_chart (
  defending TEXT NOT NULL,
  attacking TEXT NOT NULL,
  multiplier NUMERIC(3, 1) NOT NULL CHECK (multiplier IN (0, 0.5, 1, 2)),
  PRIMARY KEY (defending, attacking)
);

INSERT INTO public.type_chart (defending, attacking, multiplier) VALUES
  -- Normal: Weak to Fighting, immune to Ghost.
  ('normal', 'normal', 1), ('normal', 'fire', 1), ('normal', 'water', 1),
  ('normal', 'electric', 1), ('normal', 'grass', 1), ('normal', 'ice', 1),
  ('normal', 'fighting', 2), ('normal', 'poison', 1), ('normal', 'ground', 1),
  ('normal', 'flying', 1), ('normal', 'psychic', 1), ('normal', 'bug', 1),
  ('normal', 'rock', 1), ('normal', 'ghost', 0), ('normal', 'dragon', 1),
  ('normal', 'dark', 1), ('normal', 'steel', 1), ('normal', 'fairy', 1),
  -- Fire: Weak to Water, Ground, Rock. Resists Fire, Grass, Ice, Bug, Steel, Fairy.
  ('fire', 'normal', 1), ('fire', 'fire', 0.5), ('fire', 'water', 2),
  ('fire', 'electric', 1), ('fire', 'grass', 0.5), ('fire', 'ice', 0.5),
  ('fire', 'fighting', 1), ('fire', 'poison', 1), ('fire', 'ground', 2),
  ('fire', 'flying', 1), ('fire', 'psychic', 1), ('fire', 'bug', 0.5),
  ('fire', 'rock', 2), ('fire', 'ghost', 1), ('fire', 'dragon', 1),
  ('fire', 'dark', 1), ('fire', 'steel', 0.5), ('fire', 'fairy', 0.5),
  -- Water: Weak to Electric, Grass. Resists Fire, Water, Ice, Steel.
  ('water', 'normal', 1), ('water', 'fire', 0.5), ('water', 'water', 0.5),
  ('water', 'electric', 2), ('water', 'grass', 2), ('water', 'ice', 0.5),
  ('water', 'fighting', 1), ('water', 'poison', 1), ('water', 'ground', 1),
  ('water', 'flying', 1), ('water', 'psychic', 1), ('water', 'bug', 1),
  ('water', 'rock', 1), ('water', 'ghost', 1), ('water', 'dragon', 1),
  ('water', 'dark', 1), ('water', 'steel', 0.5), ('water', 'fairy', 1),
  -- Electric: Weak to Ground, immune to Electric. Resists Electric, Flying, Steel.
  ('electric', 'normal', 1), ('electric', 'fire', 1), ('electric', 'water', 1),
  ('electric', 'electric', 0.5), ('electric', 'grass', 1), ('electric', 'ice', 1),
  ('electric', 'fighting', 1), ('electric', 'poison', 1), ('electric', 'ground', 2),
  ('electric', 'flying', 0.5), ('electric', 'psychic', 1), ('electric', 'bug', 1),
  ('electric', 'rock', 1), ('electric', 'ghost', 1), ('electric', 'dragon', 1),
  ('electric', 'dark', 1), ('electric', 'steel', 0.5), ('electric', 'fairy', 1),
  -- Grass: Weak to Fire, Ice, Poison, Flying, Bug. Resists Water, Electric, Grass, Ground.
  ('grass', 'normal', 1), ('grass', 'fire', 2), ('grass', 'water', 0.5),
  ('grass', 'electric', 0.5), ('grass', 'grass', 0.5), ('grass', 'ice', 2),
  ('grass', 'fighting', 1), ('grass', 'poison', 2), ('grass', 'ground', 0.5),
  ('grass', 'flying', 2), ('grass', 'psychic', 1), ('grass', 'bug', 2),
  ('grass', 'rock', 1), ('grass', 'ghost', 1), ('grass', 'dragon', 1),
  ('grass', 'dark', 1), ('grass', 'steel', 1), ('grass', 'fairy', 1),
  -- Ice: Weak to Fire, Fighting, Rock, Steel. Resists Ice.
  ('ice', 'normal', 1), ('ice', 'fire', 2), ('ice', 'water', 1),
  ('ice', 'electric', 1), ('ice', 'grass', 1), ('ice', 'ice', 0.5),
  ('ice', 'fighting', 2), ('ice', 'poison', 1), ('ice', 'ground', 1),
  ('ice', 'flying', 1), ('ice', 'psychic', 1), ('ice', 'bug', 1),
  ('ice', 'rock', 2), ('ice', 'ghost', 1), ('ice', 'dragon', 1),
  ('ice', 'dark', 1), ('ice', 'steel', 2), ('ice', 'fairy', 1),
  -- Fighting: Weak to Flying, Psychic, Fairy. Resists Bug, Rock, Dark.
  ('fighting', 'normal', 1), ('fighting', 'fire', 1), ('fighting', 'water', 1),
  ('fighting', 'electric', 1), ('fighting', 'grass', 1), ('fighting', 'ice', 1),
  ('fighting', 'fighting', 1), ('fighting', 'poison', 1), ('fighting', 'ground', 1),
  ('fighting', 'flying', 2), ('fighting', 'psychic', 2), ('fighting', 'bug', 0.5),
  ('fighting', 'rock', 0.5), ('fighting', 'ghost', 1), ('fighting', 'dragon', 1),
  ('fighting', 'dark', 0.5), ('fighting', 'steel', 1), ('fighting', 'fairy', 2),
  -- Poison: Weak to Ground, Psychic. Resists Grass, Fighting, Poison, Bug, Fairy.
  ('poison', 'normal', 1), ('poison', 'fire', 1), ('poison', 'water', 1),
  ('poison', 'electric', 1), ('poison', 'grass', 0.5), ('poison', 'ice', 1),
  ('poison', 'fighting', 0.5), ('poison', 'poison', 0.5), ('poison', 'ground', 2),
  ('poison', 'flying', 1), ('poison', 'psychic', 2), ('poison', 'bug', 0.5),
  ('poison', 'rock', 1), ('poison', 'ghost', 1), ('poison', 'dragon', 1),
  ('poison', 'dark', 1), ('poison', 'steel', 1), ('poison', 'fairy', 0.5),
  -- Ground: Weak to Water, Grass, Ice. Resists Poison, Rock. Immune to Electric.
  ('ground', 'normal', 1), ('ground', 'fire', 1), ('ground', 'water', 2),
  ('ground', 'electric', 0), ('ground', 'grass', 2), ('ground', 'ice', 2),
  ('ground', 'fighting', 1), ('ground', 'poison', 0.5), ('ground', 'ground', 1),
  ('ground', 'flying', 1), ('ground', 'psychic', 1), ('ground', 'bug', 1),
  ('ground', 'rock', 0.5), ('ground', 'ghost', 1), ('ground', 'dragon', 1),
  ('ground', 'dark', 1), ('ground', 'steel', 1), ('ground', 'fairy', 1),
  -- Flying: Weak to Electric, Ice, Rock. Resists Grass, Fighting, Bug. Immune to Ground.
  ('flying', 'normal', 1), ('flying', 'fire', 1), ('flying', 'water', 1),
  ('flying', 'electric', 2), ('flying', 'grass', 0.5), ('flying', 'ice', 2),
  ('flying', 'fighting', 0.5), ('flying', 'poison', 1), ('flying', 'ground', 0),
  ('flying', 'flying', 1), ('flying', 'psychic', 1), ('flying', 'bug', 0.5),
  ('flying', 'rock', 2), ('flying', 'ghost', 1), ('flying', 'dragon', 1),
  ('flying', 'dark', 1), ('flying', 'steel', 1), ('flying', 'fairy', 1),
  -- Psychic: Weak to Bug, Ghost, Dark. Resists Fighting, Psychic.
  ('psychic', 'normal', 1), ('psychic', 'fire', 1), ('psychic', 'water', 1),
  ('psychic', 'electric', 1), ('psychic', 'grass', 1), ('psychic', 'ice', 1),
  ('psychic', 'fighting', 0.5), ('psychic', 'poison', 1), ('psychic', 'ground', 1),
  ('psychic', 'flying', 1), ('psychic', 'psychic', 0.5), ('psychic', 'bug', 2),
  ('psychic', 'rock', 1), ('psychic', 'ghost', 2), ('psychic', 'dragon', 1),
  ('psychic', 'dark', 2), ('psychic', 'steel', 1), ('psychic', 'fairy', 1),
  -- Bug: Weak to Fire, Flying, Rock. Resists Grass, Fighting, Ground.
  ('bug', 'normal', 1), ('bug', 'fire', 2), ('bug', 'water', 1),
  ('bug', 'electric', 1), ('bug', 'grass', 0.5), ('bug', 'ice', 1),
  ('bug', 'fighting', 0.5), ('bug', 'poison', 1), ('bug', 'ground', 0.5),
  ('bug', 'flying', 2), ('bug', 'psychic', 1), ('bug', 'bug', 1),
  ('bug', 'rock', 2), ('bug', 'ghost', 1), ('bug', 'dragon', 1),
  ('bug', 'dark', 1), ('bug', 'steel', 1), ('bug', 'fairy', 1),
  -- Rock: Weak to Water, Grass, Fighting, Ground, Steel. Resists Normal, Fire, Poison, Flying.
  ('rock', 'normal', 0.5), ('rock', 'fire', 0.5), ('rock', 'water', 2),
  ('rock', 'electric', 1), ('rock', 'grass', 2), ('rock', 'ice', 1),
  ('rock', 'fighting', 2), ('rock', 'poison', 0.5), ('rock', 'ground', 2),
  ('rock', 'flying', 0.5), ('rock', 'psychic', 1), ('rock', 'bug', 1),
  ('rock', 'rock', 1), ('rock', 'ghost', 1), ('rock', 'dragon', 1),
  ('rock', 'dark', 1), ('rock', 'steel', 2), ('rock', 'fairy', 1),
  -- Ghost: Weak to Ghost, Dark. Resists Poison, Bug. Immune to Normal, Fighting.
  ('ghost', 'normal', 0), ('ghost', 'fire', 1), ('ghost', 'water', 1),
  ('ghost', 'electric', 1), ('ghost', 'grass', 1), ('ghost', 'ice', 1),
  ('ghost', 'fighting', 0), ('ghost', 'poison', 0.5), ('ghost', 'ground', 1),
  ('ghost', 'flying', 1), ('ghost', 'psychic', 1), ('ghost', 'bug', 0.5),
  ('ghost', 'rock', 1), ('ghost', 'ghost', 2), ('ghost', 'dragon', 1),
  ('ghost', 'dark', 2), ('ghost', 'steel', 1), ('ghost', 'fairy', 1),
  -- Dragon: Weak to Ice, Dragon, Fairy. Resists Fire, Water, Electric, Grass.
  ('dragon', 'normal', 1), ('dragon', 'fire', 0.5), ('dragon', 'water', 0.5),
  ('dragon', 'electric', 0.5), ('dragon', 'grass', 0.5), ('dragon', 'ice', 2),
  ('dragon', 'fighting', 1), ('dragon', 'poison', 1), ('dragon', 'ground', 1),
  ('dragon', 'flying', 1), ('dragon', 'psychic', 1), ('dragon', 'bug', 1),
  ('dragon', 'rock', 1), ('dragon', 'ghost', 1), ('dragon', 'dragon', 2),
  ('dragon', 'dark', 1), ('dragon', 'steel', 1), ('dragon', 'fairy', 2),
  -- Dark: Weak to Fighting, Bug, Fairy. Resists Ghost, Dark. Immune to Psychic.
  ('dark', 'normal', 1), ('dark', 'fire', 1), ('dark', 'water', 1),
  ('dark', 'electric', 1), ('dark', 'grass', 1), ('dark', 'ice', 1),
  ('dark', 'fighting', 2), ('dark', 'poison', 1), ('dark', 'ground', 1),
  ('dark', 'flying', 1), ('dark', 'psychic', 0), ('dark', 'bug', 2),
  ('dark', 'rock', 1), ('dark', 'ghost', 0.5), ('dark', 'dragon', 1),
  ('dark', 'dark', 0.5), ('dark', 'steel', 1), ('dark', 'fairy', 2),
  -- Steel: Weak to Fire, Fighting, Ground. Resists Normal, Grass, Ice, Flying,
  -- Psychic, Bug, Rock, Dragon, Steel, Fairy. Immune to Poison.
  ('steel', 'normal', 0.5), ('steel', 'fire', 2), ('steel', 'water', 1),
  ('steel', 'electric', 1), ('steel', 'grass', 0.5), ('steel', 'ice', 0.5),
  ('steel', 'fighting', 2), ('steel', 'poison', 0), ('steel', 'ground', 2),
  ('steel', 'flying', 0.5), ('steel', 'psychic', 0.5), ('steel', 'bug', 0.5),
  ('steel', 'rock', 0.5), ('steel', 'ghost', 1), ('steel', 'dragon', 0.5),
  ('steel', 'dark', 0.5), ('steel', 'steel', 0.5), ('steel', 'fairy', 0.5),
  -- Fairy: Weak to Poison, Steel. Resists Fighting, Bug, Dark. Immune to Dragon.
  ('fairy', 'normal', 1), ('fairy', 'fire', 1), ('fairy', 'water', 1),
  ('fairy', 'electric', 1), ('fairy', 'grass', 1), ('fairy', 'ice', 1),
  ('fairy', 'fighting', 0.5), ('fairy', 'poison', 2), ('fairy', 'ground', 1),
  ('fairy', 'flying', 1), ('fairy', 'psychic', 1), ('fairy', 'bug', 0.5),
  ('fairy', 'rock', 1), ('fairy', 'ghost', 1), ('fairy', 'dragon', 0),
  ('fairy', 'dark', 0.5), ('fairy', 'steel', 2), ('fairy', 'fairy', 1);

-- Resolves the attacking types that deal super-effective (2x+) damage to a
-- Pokemon by multiplying the primary and secondary type chart rows, so 4x
-- weaknesses, halved resistances, and immunities are all respected. A weakness
-- here means "an opposing move type that hits this Pokemon for bonus damage",
-- which is what duplicate-weakness avoidance needs to compare.
--
-- @param p_primary - The Pokemon's primary normalized type, e.g. "fire".
-- @param p_secondary - The Pokemon's secondary normalized type, or NULL.
-- @returns The distinct attacking types the Pokemon is weak to.
CREATE OR REPLACE FUNCTION public.pokemon_weaknesses(
  p_primary TEXT,
  p_secondary TEXT
)
RETURNS SETOF TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT product.attacking
  FROM (
    SELECT c.attacking,
      CASE WHEN bool_or(c.multiplier = 0) THEN 0
           ELSE exp(sum(ln(c.multiplier))) END AS net_multiplier
    FROM public.type_chart c
    WHERE c.defending = lower(p_primary)
       OR (p_secondary IS NOT NULL AND c.defending = lower(p_secondary))
    GROUP BY c.attacking
  ) product
  WHERE product.net_multiplier > 1;
$$;