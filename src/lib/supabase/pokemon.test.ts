/*
 * Tests for the Pokémon page's pure helpers.
 *
 * The focus here is the type grouping on the free agent table, because the rules
 * that decide its order are easy to get subtly wrong: a dual-typed Pokémon
 * counting twice, an unranked one being treated as better than a tier 1, and a
 * sort that quietly filters rows out of the table.
 */
import { describe, expect, it } from "vitest";

import {
  ALL_POKEMON_TYPES,
  poolTypeCounts,
  sortPoolByType,
  type PokemonPoolRow,
} from "@/lib/supabase/pokemon";

/**
 * Builds a free-agent row with just the fields the type helpers read.
 *
 * @param name - Display name, which is also the stable tiebreaker.
 * @param tier - Tier value, where 0 means unranked.
 * @param types - Typing as lowercase PokeAPI type names.
 * @returns A pool row for the helper under test.
 */
function row(
  name: string,
  tier: number,
  types: string[] = [],
): PokemonPoolRow {
  return {
    pokemon_id: name.toLowerCase(),
    species_name: name.toLowerCase(),
    tier_value: tier,
    name,
    types,
    dex: 0,
    spriteId: 0,
    bst: null,
    generation: null,
    stats: null,
    abilities: null,
  };
}

describe("poolTypeCounts", () => {
  it("counts each type a row carries", () => {
    const counts = poolTypeCounts([
      row("Charizard", 3, ["fire", "flying"]),
      row("Venusaur", 2, ["grass", "poison"]),
    ]);

    expect(counts.get("fire")).toBe(1);
    expect(counts.get("flying")).toBe(1);
    expect(counts.get("grass")).toBe(1);
  });

  it("counts a dual-typed Pokemon once under each of its types", () => {
    // Scanning for Water has to surface a Water/Ice Pokemon, which is the whole
    // reason to pick a type rather than read the Type column.
    const counts = poolTypeCounts([row("Cloyster", 2, ["water", "ice"])]);

    expect(counts.get("water")).toBe(1);
    expect(counts.get("ice")).toBe(1);
  });

  it("accumulates across rows", () => {
    const counts = poolTypeCounts([
      row("Charizard", 3, ["fire", "flying"]),
      row("Moltres", 1, ["fire", "flying"]),
    ]);

    expect(counts.get("fire")).toBe(2);
    expect(counts.get("flying")).toBe(2);
  });

  it("omits types no row carries", () => {
    // The dropdown needs to be able to show a type as empty, which it can only
    // do if a missing type is absent rather than present as zero.
    const counts = poolTypeCounts([row("Pikachu", 2, ["electric"])]);

    expect(counts.has("water")).toBe(false);
  });

  it("ignores rows with no types at all", () => {
    // A slug missing from the bundled catalog yields an empty type list, and must
    // not register under a blank key.
    const counts = poolTypeCounts([
      row("Unknown", 1, []),
      row("Blanks", 1, ["  "]),
    ]);

    expect(counts.size).toBe(0);
  });

  it("normalises case and surrounding whitespace", () => {
    const counts = poolTypeCounts([row("Odd", 1, [" Fire ", "FLYING"])]);

    expect(counts.get("fire")).toBe(1);
    expect(counts.get("flying")).toBe(1);
  });

  it("returns nothing for an empty pool", () => {
    expect(poolTypeCounts([]).size).toBe(0);
  });
});

describe("sortPoolByType", () => {
  it("puts the chosen type first", () => {
    const sorted = sortPoolByType(
      [
        row("Blastoise", 2, ["water"]),
        row("Charizard", 3, ["fire", "flying"]),
        row("Squirtle", 1, ["water"]),
      ],
      "fire",
    );

    expect(sorted[0].name).toBe("Charizard");
  });

  it("orders the chosen type by tier, best first", () => {
    const sorted = sortPoolByType(
      [
        row("Squirtle", 1, ["water"]),
        row("Charizard", 3, ["fire", "flying"]),
        row("Moltres", 2, ["fire", "flying"]),
      ],
      "fire",
    );

    // Squirtle is still here, after the fire group: this sorts, it does not filter.
    expect(sorted.map((entry) => entry.name)).toEqual([
      "Charizard",
      "Moltres",
      "Squirtle",
    ]);
  });

  it("keeps the non-matching rows rather than filtering them out", () => {
    // A sort that removed the other rows would quietly hide most of the pool.
    const sorted = sortPoolByType(
      [
        row("Charizard", 3, ["fire", "flying"]),
        row("Squirtle", 1, ["water"]),
        row("Pikachu", 2, ["electric"]),
      ],
      "fire",
    );

    expect(sorted).toHaveLength(3);
    expect(sorted.map((entry) => entry.name)).toContain("Squirtle");
    expect(sorted.map((entry) => entry.name)).toContain("Pikachu");
  });

  it("orders the non-matching rows by tier too", () => {
    const sorted = sortPoolByType(
      [
        row("Pikachu", 2, ["electric"]),
        row("Squirtle", 1, ["water"]),
        row("Charizard", 3, ["fire", "flying"]),
      ],
      "fire",
    );

    expect(sorted.map((entry) => entry.name)).toEqual([
      "Charizard",
      "Pikachu",
      "Squirtle",
    ]);
  });

  it("matches on either half of a dual type", () => {
    const sorted = sortPoolByType(
      [
        row("Squirtle", 1, ["water"]),
        row("Charizard", 3, ["fire", "flying"]),
        row("Moltres", 2, ["flying", "fire"]),
      ],
      "flying",
    );

    expect(sorted.map((entry) => entry.name)).toEqual([
      "Charizard",
      "Moltres",
      "Squirtle",
    ]);
  });

  it("sinks an unranked Pokemon below a ranked one", () => {
    // Tier 0 means unranked, not better than everything. A plain numeric sort
    // would float it to the top of the chosen group.
    const sorted = sortPoolByType(
      [
        row("Unranked", 0, ["fire", "flying"]),
        row("Charizard", 3, ["fire", "flying"]),
      ],
      "fire",
    );

    expect(sorted.map((entry) => entry.name)).toEqual([
      "Charizard",
      "Unranked",
    ]);
  });

  it("keeps unranked rows last in both groups", () => {
    const sorted = sortPoolByType(
      [
        row("Unranked", 0, ["water"]),
        row("Unranked Fire", 0, ["fire", "flying"]),
        row("Pikachu", 2, ["electric"]),
      ],
      "fire",
    );

    expect(sorted[0].name).toBe("Unranked Fire");
    expect(sorted[sorted.length - 1].name).toBe("Unranked");
  });

  it("breaks tier ties by name so the order is stable", () => {
    const sorted = sortPoolByType(
      [
        row("Zorua", 2, ["fire", "flying"]),
        row("Vulpix", 2, ["fire", "flying"]),
      ],
      "fire",
    );

    expect(sorted.map((entry) => entry.name)).toEqual(["Vulpix", "Zorua"]);
  });

  it("hands the order back untouched for the all-types value", () => {
    // With no type selected this helper deliberately does not sort: the page's
    // own column sort owns the order, and having this impose a second opinion
    // would make the dropdown and the column headers contradict each other.
    const rows = [
      row("Squirtle", 1, ["water"]),
      row("Charizard", 3, ["fire", "flying"]),
    ];

    expect(sortPoolByType(rows, ALL_POKEMON_TYPES).map((e) => e.name)).toEqual([
      "Squirtle",
      "Charizard",
    ]);
  });

  it("returns a new array for the all-types value", () => {
    const rows = [row("Squirtle", 1, ["water"])];

    expect(sortPoolByType(rows, ALL_POKEMON_TYPES)).not.toBe(rows);
  });

  it("treats an empty selection as no grouping", () => {
    const rows = [row("Squirtle", 1, ["water"]), row("Charizard", 3, ["fire"])];

    expect(sortPoolByType(rows, "")).toHaveLength(2);
  });

  it("matches the chosen type case-insensitively", () => {
    const sorted = sortPoolByType(
      [row("Squirtle", 1, ["water"]), row("Charizard", 3, ["fire"])],
      "FIRE",
    );

    expect(sorted[0].name).toBe("Charizard");
  });

  it("does not mutate the input array", () => {
    // The pool comes out of the loader and is filtered and sorted in place by
    // other paths on this page, so a helper that reordered it would corrupt the
    // Tiers tab's own grouping.
    const rows = [
      row("Squirtle", 1, ["water"]),
      row("Charizard", 3, ["fire", "flying"]),
    ];
    const before = rows.map((entry) => entry.name);

    sortPoolByType(rows, "fire");

    expect(rows.map((entry) => entry.name)).toEqual(before);
  });

  it("handles an empty pool", () => {
    expect(sortPoolByType([], "fire")).toEqual([]);
  });
});
