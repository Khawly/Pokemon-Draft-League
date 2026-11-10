/*
 * Checks the rare-species classification the draft pool's category buttons use.
 *
 * The flags come from the bundled data rather than a hand-written list, so these
 * assertions guard the join: a base species, a form of a legendary, a Mega, a
 * Gigantamax form, and a slug the dataset does not know.
 */
import { describe, expect, it } from "vitest";

import { getPokemonRarity, isCosmeticPokemonForm } from "./pokeapi";

describe("getPokemonRarity", () => {
  it("classifies a legendary species", () => {
    expect(getPokemonRarity("mewtwo")).toEqual({
      isLegendary: true,
      isMythical: false,
      isMega: false,
      isGigantamax: false,
    });
  });

  it("classifies a mythical species", () => {
    expect(getPokemonRarity("mew")).toEqual({
      isLegendary: false,
      isMythical: true,
      isMega: false,
      isGigantamax: false,
    });
  });

  it("keeps a legendary's alternate forms legendary", () => {
    expect(getPokemonRarity("zacian-crowned")).toEqual({
      isLegendary: true,
      isMythical: false,
      isMega: false,
      isGigantamax: false,
    });
  });

  it("classifies Mega Evolutions, including named variants", () => {
    for (const slug of [
      "venusaur-mega",
      "charizard-mega-x",
      "charizard-mega-y",
    ]) {
      expect(getPokemonRarity(slug).isMega, slug).toBe(true);
    }
  });

  it("can classify a form as both legendary and Mega", () => {
    // Mega Mewtwo is caught by both buttons, which is correct: it is both.
    expect(getPokemonRarity("mewtwo-mega-x")).toEqual({
      isLegendary: true,
      isMythical: false,
      isMega: true,
      isGigantamax: false,
    });
  });

  it("classifies a Gigantamax form without calling it legendary or Mega", () => {
    expect(getPokemonRarity("charizard-gmax")).toEqual({
      isLegendary: false,
      isMythical: false,
      isMega: false,
      isGigantamax: true,
    });
  });

  it("does not treat a species whose name contains 'mega' as a Mega", () => {
    expect(getPokemonRarity("meganium")).toEqual({
      isLegendary: false,
      isMythical: false,
      isMega: false,
      isGigantamax: false,
    });
  });

  it("leaves an ordinary species unclassified", () => {
    expect(getPokemonRarity("pikachu")).toEqual({
      isLegendary: false,
      isMythical: false,
      isMega: false,
      isGigantamax: false,
    });
  });

  it("treats an unknown slug as unclassified rather than throwing", () => {
    expect(getPokemonRarity("not-a-pokemon")).toEqual({
      isLegendary: false,
      isMythical: false,
      isMega: false,
      isGigantamax: false,
    });
  });
});

describe("isCosmeticPokemonForm", () => {
  it("treats Mega and Gigantamax forms as cosmetic", () => {
    for (const slug of ["charizard-mega-x", "charizard-gmax"]) {
      expect(isCosmeticPokemonForm(slug), slug).toBe(true);
    }
  });

  it("treats a form with identical typing, stats, and abilities as cosmetic", () => {
    for (const slug of ["pikachu-rock-star", "minior-orange-meteor"]) {
      expect(isCosmeticPokemonForm(slug), slug).toBe(true);
    }
  });

  it("keeps a form that changes typing, even when stats and abilities match", () => {
    for (const slug of ["castform-sunny", "oricorio-pom-pom"]) {
      expect(isCosmeticPokemonForm(slug), slug).toBe(false);
    }
  });

  it("keeps regional and stat-changing forms", () => {
    for (const slug of ["vulpix-alola", "deoxys-defense"]) {
      expect(isCosmeticPokemonForm(slug), slug).toBe(false);
    }
  });

  it("does not classify a base species as a cosmetic form", () => {
    expect(isCosmeticPokemonForm("charizard")).toBe(false);
  });
});
