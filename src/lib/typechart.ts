/*
 * Pokémon type-effectiveness chart for the Pokemon Draft League.
 *
 * Holds the canonical 18-type matchup table (attacker type → damage multiplier
 * against a defender type) plus helpers used by the Team page: a Pokémon's
 * defensive matchups (how much damage each attacking type deals against its own
 * typing, columns across the 18 types) and its offensive matchups (what its own
 * attacks deal to a defender type). Both multiply their type values and reduce
 * to the multiplier set (0, 0.25, 0.5, 1, 2, 4). For the defensive grid,
 * `getMatchupColor` leaves neutral uncolored, shades immunities black,
 * resistances green, and weaknesses red, emphasizing the most severe step of
 * each family with a neon glow.
 */

/** All 18 types in a stable display order (chart columns/rows). */
export const TYPE_LIST = [
  "normal",
  "fire",
  "water",
  "electric",
  "grass",
  "ice",
  "fighting",
  "poison",
  "ground",
  "flying",
  "psychic",
  "bug",
  "rock",
  "ghost",
  "dragon",
  "dark",
  "steel",
  "fairy",
] as const;

/** A valid type name from the 18-type chart. */
export type PokemonType = (typeof TYPE_LIST)[number];

/**
 * Canonical attack-type → defender-type damage multipliers. Missing pairings
 * default to 1 (neutral). Only 0.5 (not very effective), 0 (immune), and 2
 * (super effective) are listed explicitly; 0.25 (double resist) and 4 (double
 * weakness) arise from multiplying two or more of these.
 */
const TYPE_CHART: Record<PokemonType, Partial<Record<PokemonType, number>>> = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: {
    fire: 0.5,
    water: 0.5,
    grass: 2,
    ice: 2,
    bug: 2,
    rock: 0.5,
    dragon: 0.5,
    steel: 2,
  },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: {
    water: 2,
    electric: 0.5,
    grass: 0.5,
    ground: 0,
    flying: 2,
    dragon: 0.5,
  },
  grass: {
    fire: 0.5,
    water: 2,
    grass: 0.5,
    poison: 0.5,
    ground: 2,
    flying: 0.5,
    bug: 0.5,
    rock: 2,
    dragon: 0.5,
    steel: 0.5,
  },
  ice: {
    fire: 0.5,
    water: 0.5,
    grass: 2,
    ice: 0.5,
    ground: 2,
    flying: 2,
    dragon: 2,
    steel: 0.5,
  },
  fighting: {
    normal: 2,
    ice: 2,
    poison: 0.5,
    flying: 0.5,
    psychic: 0.5,
    bug: 0.5,
    rock: 2,
    ghost: 0,
    dark: 2,
    steel: 2,
    fairy: 0.5,
  },
  poison: {
    grass: 2,
    poison: 0.5,
    ground: 0.5,
    rock: 0.5,
    ghost: 0.5,
    steel: 0,
    fairy: 2,
  },
  ground: {
    fire: 2,
    electric: 2,
    grass: 0.5,
    poison: 2,
    flying: 0,
    bug: 0.5,
    rock: 2,
    steel: 2,
  },
  flying: {
    electric: 0.5,
    grass: 2,
    fighting: 2,
    bug: 2,
    rock: 0.5,
    steel: 0.5,
  },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: {
    fire: 0.5,
    grass: 2,
    fighting: 0.5,
    poison: 0.5,
    flying: 0.5,
    psychic: 2,
    ghost: 0.5,
    dark: 2,
    steel: 0.5,
    fairy: 0.5,
  },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

/**
 * Damage multiplier of an attacking type against a defender type.
 *
 * @param attackType - The attacking type.
 * @param defenderType - The defending type.
 * @returns 0, 0.5, 1, or 2 per the canonical chart.
 */
export function getTypeMultiplier(
  attackType: PokemonType,
  defenderType: PokemonType,
): number {
  return TYPE_CHART[attackType][defenderType] ?? 1;
}

/**
 * Offensive matchup value of a Pokémon (with its combined attacking types)
 * against a defender type.
 *
 * Each of the Pokémon's types is evaluated against the defender and the values
 * multiply, so dual-typed attackers can reach 4 (double weakness on the
 * defender) or 0.25 (double resist) and any 0 (immune) collapses to 0.
 *
 * @param attackerTypes - The Pokémon's own type list (1-2 types).
 * @param defenderType - The defending type being checked against.
 * @returns The combined damage multiplier (0, 0.25, 0.5, 1, 2, or 4).
 */
export function getOffensiveMatchup(
  attackerTypes: string[],
  defenderType: PokemonType,
): number {
  const effective = attackerTypes.filter((type): type is PokemonType =>
    (TYPE_LIST as readonly string[]).includes(type),
  );

  if (effective.length === 0) {
    return 1;
  }

  return effective.reduce(
    (product, attackType) =>
      product * getTypeMultiplier(attackType, defenderType),
    1,
  );
}

/**
 * Defensive matchup value of a Pokémon (evaluated with its defensive typings)
 * against an attacking type.
 *
 * Each of the Pokémon's own types is checked against the attacking type and the
 * values multiply: a Water/Flying Pokémon takes 1 (Water 0.5 × Flying 2) from
 * Grass attacks, 4 from Electric (Electric 2 × 2 through both typings), and 0
 * from Ground (Ground 0 via Flying immunity). Rows in the defensive typing grid
 * are the team's Pokémon, columns are the 18 attacking types.
 *
 * @param pokemonTypes - The Pokémon's defensive type list (1-2 types).
 * @param attackType - The attacking type being checked against the Pokémon.
 * @returns The combined damage multiplier (0, 0.25, 0.5, 1, 2, or 4).
 */
export function getDefensiveMatchup(
  pokemonTypes: string[],
  attackType: PokemonType,
): number {
  const effective = pokemonTypes.filter((type): type is PokemonType =>
    (TYPE_LIST as readonly string[]).includes(type),
  );

  if (effective.length === 0) {
    return 1;
  }

  return effective.reduce(
    (product, defensiveType) =>
      product * getTypeMultiplier(attackType, defensiveType),
    1,
  );
}

/**
 * Neon glow class for the emphasized step of a color family.
 *
 * The emphasized steps of the defensive grid (double weaknesses, strong
 * resists, and their roster totals) share this so the glow reads the same in
 * every place the chart uses it.
 *
 * @param color - The color family to glow.
 * @returns The box-shadow utility classes.
 */
export function getEmphasisGlow(color: "red" | "green"): string {
  return color === "red"
    ? "shadow-[0_0_12px_rgba(239,68,68,0.9)]"
    : "shadow-[0_0_12px_rgba(34,197,94,0.75)]";
}

/**
 * Tailwind classes for a defensive matchup cell value: neutral hits get no
 * shading, immunities are black, resisted hits shade green (these are good for
 * the defending Pokémon), and weaknesses shade red (bad for the defending
 * Pokémon). Within each family the plain step is the muted shade and the
 * strongest step is the vivid one, emphasized with a neon glow. Every value
 * keeps white text so only the cell fill carries meaning.
 *
 * 0.25 strongly resisted, 0.5 resisted, 1 neutral, 2 weak, 4 double weak.
 *
 * @param multiplier - The matchup value to color.
 * @returns The cell background/text utility classes.
 */
export function getMatchupColor(multiplier: number): string {
  if (multiplier === 0) {
    return "bg-slate-950 text-white";
  }
  // The strong resist (0.25) is the vivid, glowing green; the plain resist
  // (0.5) steps down to a darker green.
  if (multiplier === 0.25) {
    return `bg-green-500 text-white ${getEmphasisGlow("green")}`;
  }
  if (multiplier === 0.5) {
    return "bg-green-700 text-white";
  }
  // Neutral takes no color at all so the colored cells read at a glance.
  if (multiplier === 1) {
    return "";
  }
  // Weaknesses follow the same shape: a straight weakness steps down to a
  // darker red and anything worse is the vivid, glowing red.
  if (multiplier === 2) {
    return "bg-red-700 text-white";
  }
  return `bg-red-500 text-white ${getEmphasisGlow("red")}`;
}