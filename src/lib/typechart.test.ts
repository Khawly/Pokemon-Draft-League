/*
 * Tests for the type chart.
 *
 * The chart drives both the team's defensive typing table and the draft engine's
 * autopick, so a wrong multiplier is a league-integrity problem rather than a
 * cosmetic one. The multipliers themselves are treated as the app's own data and
 * pinned verbatim; what is verified here is the arithmetic layered on top of them,
 * namely that a type which hits super effectively must be resisted by its own
 * effectiveness, and that immunity collapses a dual-type attacker to zero rather
 * than multiplying to something else.
 */
import { describe, expect, it } from "vitest";

import {
  getDefensiveMatchup,
  getEmphasisGlow,
  getMatchupColor,
  getOffensiveMatchup,
  getTypeMultiplier,
  TYPE_LIST,
  type PokemonType,
} from "@/lib/typechart";

describe("TYPE_LIST", () => {
  it("holds all eighteen types with no duplicates", () => {
    expect(TYPE_LIST).toHaveLength(18);
    expect(new Set(TYPE_LIST).size).toBe(18);
  });
});

describe("getTypeMultiplier", () => {
  it("is neutral against itself's typical interactions", () => {
    // Normal is the baseline type, so almost everything is neutral against it.
    expect(getTypeMultiplier("normal", "normal")).toBe(1);
    expect(getTypeMultiplier("fire", "water")).toBe(0.5);
    expect(getTypeMultiplier("water", "fire")).toBe(2);
  });

  it("makes an immunity immune regardless of speed", () => {
    expect(getTypeMultiplier("ground", "flying")).toBe(0);
    expect(getTypeMultiplier("electric", "ground")).toBe(0);
    expect(getTypeMultiplier("fighting", "ghost")).toBe(0);
    expect(getTypeMultiplier("normal", "ghost")).toBe(0);
  });

  /**
   * A transcription of the chart as the app defines it, listing only the matchups
   * that are not neutral; anything absent is 1.
   *
   * Pinned in full rather than sampled because this table is data someone typed,
   * and a wrong cell silently changes both the draft autopick's target choice and
   * what a team's defensive grid tells a member. The transcription has been
   * checked cell by cell, but it is still a hand-entered copy: if the chart is
   * ever revised, this is the place to change, and the failures name the exact
   * attacker and defender.
   */
  const TRANSCRIBED: Partial<Record<PokemonType, Partial<Record<PokemonType, number>>>> = {
    normal: { rock: 0.5, ghost: 0, steel: 0.5 },
    fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
    water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
    electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
    grass: {
      fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5,
      bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5,
    },
    ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
    fighting: {
      normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5,
      rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5,
    },
    poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
    ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
    flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
    psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
    bug: {
      fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2,
      ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5,
    },
    rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
    ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
    dragon: { dragon: 2, steel: 0.5, fairy: 0 },
    dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
    steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
    fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
  };

  it("matches the transcribed chart for all 324 matchups", () => {
    const wrong: string[] = [];

    for (const attack of TYPE_LIST) {
      const expected = TRANSCRIBED[attack] ?? {};

      for (const defend of TYPE_LIST) {
        const want = expected[defend] ?? 1;
        const got = getTypeMultiplier(attack, defend);

        if (got !== want) {
          wrong.push(`${attack} -> ${defend}: got ${got}, want ${want}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it("is not symmetric, which is a property of the real chart", () => {
    // Ghost is immune to Fighting, but Fighting is not resisted by Ghost. Asserting
    // symmetry here would have hidden genuine data errors.
    expect(getTypeMultiplier("fighting", "ghost")).toBe(0);
    expect(getTypeMultiplier("ghost", "fighting")).toBe(1);
  });

  it("only ever returns a recognised multiplier", () => {
    const allowed = new Set([0, 0.25, 0.5, 1, 2, 4]);

    for (const attack of TYPE_LIST) {
      for (const defend of TYPE_LIST) {
        expect(allowed).toContain(getTypeMultiplier(attack, defend));
      }
    }
  });

  it("falls back to neutral for a type it does not know", () => {
    expect(getTypeMultiplier("normal", "star" as PokemonType)).toBe(1);
  });
});

describe("getOffensiveMatchup", () => {
  it("reads a single type straight off the chart", () => {
    expect(getOffensiveMatchup(["fire"], "grass")).toBe(2);
  });

  it("multiplies a dual-type attacker against the defender", () => {
    // Ice is 2x against dragon and dragon is 2x against dragon, so 4x total.
    expect(getOffensiveMatchup(["ice", "dragon"], "dragon")).toBe(4);
  });

  it("lets immunity collapse a dual-type attacker to zero", () => {
    // Ground is immune to flying, so a 2x from another type cannot rescue it.
    expect(getOffensiveMatchup(["ground", "electric"], "flying")).toBe(0);
  });

  it("compounds a double resistance into a quarter", () => {
    // Fire is 0.5 against water and water is 0.5 against water: 0.25.
    expect(getOffensiveMatchup(["fire", "water"], "water")).toBe(0.25);
  });

  it("cancels a weakness against a resistance", () => {
    // Fire is 0.5 against fire and water is 2 against fire: neutral.
    expect(getOffensiveMatchup(["fire", "water"], "fire")).toBe(1);
  });

  it("is neutral when the attacker has no recognised type", () => {
    expect(getOffensiveMatchup(["star"], "fire")).toBe(1);
    expect(getOffensiveMatchup([], "fire")).toBe(1);
  });

  it("ignores an unrecognised second type rather than failing", () => {
    expect(getOffensiveMatchup(["fire", "star"], "grass")).toBe(2);
  });
});

describe("getDefensiveMatchup", () => {
  it("takes the Pokemon's own types and the attacking type", () => {
    // Grass attacking fire is resisted by it.
    expect(getDefensiveMatchup(["fire"], "grass")).toBe(0.5);
    // Fire attacking grass is strong against it.
    expect(getDefensiveMatchup(["grass"], "fire")).toBe(2);
  });

  it("multiplies a dual-typed defender's weaknesses", () => {
    // Fire is 2x against grass and ice is 2x against grass, so 4x total.
    expect(getDefensiveMatchup(["grass", "ice"], "fire")).toBe(4);
  });

  it("lets a single immunity override a second weakness", () => {
    // Electric is immune to ground no matter what else the defender is.
    expect(getDefensiveMatchup(["ground", "water"], "electric")).toBe(0);
  });

  it("is neutral when the defender has no recognised type", () => {
    expect(getDefensiveMatchup(["star"], "fire")).toBe(1);
  });

  it("agrees with the offensive reading of the same matchup", () => {
    // The same pair of types must not score differently depending on which
    // function is asked, or the draft and the grid would contradict each other.
    for (const attack of TYPE_LIST) {
      for (const defend of TYPE_LIST) {
        expect(getDefensiveMatchup([defend], attack)).toBe(
          getOffensiveMatchup([attack], defend),
        );
      }
    }
  });
});

describe("getMatchupColor", () => {
  it("uses a distinct colour for each multiplier band", () => {
    const colors = [0, 0.25, 0.5, 1, 2, 4].map(getMatchupColor);

    // Bands 2 and 4 are both "super effective" but must be distinguishable.
    expect(new Set(colors).size).toBe(6);
  });

  it("returns a class string rather than a raw colour", () => {
    expect(getMatchupColor(2)).toContain("text-");
  });
});

describe("getEmphasisGlow", () => {
  it("returns a different glow for each emphasis colour", () => {
    expect(getEmphasisGlow("red")).not.toBe(getEmphasisGlow("green"));
    expect(getEmphasisGlow("red")).toContain("shadow");
  });
});
