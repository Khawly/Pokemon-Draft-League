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
  TRANSACTION_SOURCES,
  canAffordPickup,
  getPickupCost,
  getTeamSalary,
  poolTypeCounts,
  sortPoolByType,
  transactionNamesTeam,
  type PokemonGoods,
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

/**
 * Builds a minimal Pokémon page payload for the cost/salary helpers.
 *
 * @param overrides - Fields to replace on the default member-owned-team state.
 * @returns A payload that satisfies {@link PokemonGoods}.
 */
function goods(overrides: Partial<PokemonGoods> = {}): PokemonGoods {
  return {
    league: { id: "league-1", name: "Test League", owner_id: "owner-1" },
    season: {
      id: "season-1",
      season_number: 1,
      status: "draft_complete",
      name: null,
    },
    isCurrentSeason: true,
    settings: {
      enable_pokemon_costs: true,
      total_token_salary: 100,
      allow_per_team_salary: false,
      enable_transaction_costs: true,
      transaction_cost: 5,
    },
    pool: [],
    myTeam: {
      id: "team-a",
      team_name: "Team A",
      owner_name: "Alice",
      owner_name_color: null,
      total_salary_override: null,
    },
    teams: [
      {
        id: "team-a",
        team_name: "Team A",
        owner_name: "Alice",
        owner_name_color: null,
        total_salary_override: null,
      },
      {
        id: "team-b",
        team_name: "Team B",
        owner_name: "Bob",
        owner_name_color: null,
        total_salary_override: null,
      },
    ],
    rosterCount: 0,
    spent: 10,
    spentByTeam: new Map([
      ["team-a", 10],
      ["team-b", 95],
    ]),
    transactions: [],
    leagueActivity: [],
    currentUserId: "member-1",
    userRole: "member",
    ...overrides,
  };
}

describe("getPickupCost", () => {
  it("charges the tier plus the enabled transaction cost", () => {
    const cost = getPickupCost(goods(), row("Pikachu", 3));

    expect(cost).toEqual({ tierCost: 3, transactionCost: 5, total: 8 });
  });

  it("waives only the transaction cost", () => {
    // The waiver is a fee override, not a discount on the Pokémon's tier.
    const cost = getPickupCost(goods(), row("Pikachu", 3), {
      waiveTransactionCost: true,
    });

    expect(cost).toEqual({ tierCost: 3, transactionCost: 0, total: 3 });
  });

  it("leaves the cost unchanged when transaction costs are disabled", () => {
    const cost = getPickupCost(
      goods({
        settings: {
          enable_pokemon_costs: true,
          total_token_salary: 100,
          allow_per_team_salary: false,
          enable_transaction_costs: false,
          transaction_cost: 5,
        },
      }),
      row("Pikachu", 3),
      { waiveTransactionCost: true },
    );

    expect(cost.total).toBe(3);
    expect(cost.transactionCost).toBe(0);
  });

  it("charges nothing when Pokemon costs are disabled", () => {
    const cost = getPickupCost(
      goods({
        settings: {
          enable_pokemon_costs: false,
          total_token_salary: null,
          allow_per_team_salary: false,
          enable_transaction_costs: true,
          transaction_cost: 5,
        },
      }),
      row("Pikachu", 3),
    );

    // The fee still applies even without tier costs, which is the existing rule.
    expect(cost.total).toBe(5);
  });
});

describe("getTeamSalary", () => {
  it("uses the league salary and the target team's ledger spend", () => {
    expect(getTeamSalary(goods(), "team-b")).toEqual({
      budget: 100,
      spent: 95,
      remaining: 5,
    });
  });

  it("prefers a per-team override when the league allows one", () => {
    const state = goods({
      settings: {
        enable_pokemon_costs: true,
        total_token_salary: 100,
        allow_per_team_salary: true,
        enable_transaction_costs: true,
        transaction_cost: 5,
      },
      teams: [
        {
          id: "team-a",
          team_name: "Team A",
          owner_name: "Alice",
          owner_name_color: null,
          total_salary_override: null,
        },
        {
          id: "team-b",
          team_name: "Team B",
          owner_name: "Bob",
          owner_name_color: null,
          total_salary_override: 40,
        },
      ],
    });

    expect(getTeamSalary(state, "team-b")).toEqual({
      budget: 40,
      spent: 95,
      remaining: -55,
    });
  });

  it("treats the salary as unlimited when costs are disabled", () => {
    const state = goods({
      settings: {
        enable_pokemon_costs: false,
        total_token_salary: null,
        allow_per_team_salary: false,
        enable_transaction_costs: false,
        transaction_cost: null,
      },
    });

    expect(getTeamSalary(state, "team-b").remaining).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("canAffordPickup", () => {
  it("checks the member's own team by default", () => {
    // Team A has 90 tokens left, so an 8-token pickup fits.
    expect(canAffordPickup(goods(), row("Pikachu", 3))).toBe(true);
  });

  it("checks the explicitly selected team instead of the member's own", () => {
    // Team B has 5 tokens left and the pickup would cost 8.
    expect(
      canAffordPickup(goods(), row("Pikachu", 3), { teamId: "team-b" }),
    ).toBe(false);
  });

  it("lets an owner make a pickup fit by waiving the fee", () => {
    expect(
      canAffordPickup(goods(), row("Pikachu", 3), {
        teamId: "team-b",
        waiveTransactionCost: true,
      }),
    ).toBe(true);
  });

  it("always fits when Pokemon costs are disabled", () => {
    const state = goods({
      settings: {
        enable_pokemon_costs: false,
        total_token_salary: null,
        allow_per_team_salary: false,
        enable_transaction_costs: false,
        transaction_cost: null,
      },
    });

    expect(
      canAffordPickup(state, row("Pikachu", 3), { teamId: "team-b" }),
    ).toBe(true);
  });
});

describe("transactionNamesTeam", () => {
  it("names the team when an owner adds to somebody else's roster", () => {
    expect(
      transactionNamesTeam({
        action: "added",
        userId: "owner-1",
        teamOwnerId: "member-1",
      }),
    ).toBe(true);
  });

  it("names the team when an owner releases from somebody else's roster", () => {
    expect(
      transactionNamesTeam({
        action: "dropped",
        userId: "owner-1",
        teamOwnerId: "member-1",
      }),
    ).toBe(true);
  });

  it("stays terse for a member acting on their own team", () => {
    // The feed already names the mover; repeating the same team adds noise.
    expect(
      transactionNamesTeam({
        action: "added",
        userId: "member-1",
        teamOwnerId: "member-1",
      }),
    ).toBe(false);
  });

  it("does not name a team for trades or token movements", () => {
    expect(
      transactionNamesTeam({
        action: "trade_in",
        userId: "member-1",
        teamOwnerId: "member-2",
      }),
    ).toBe(false);
    expect(
      transactionNamesTeam({
        action: "token_transfer",
        userId: "member-1",
        teamOwnerId: "member-2",
      }),
    ).toBe(false);
  });

  it("stays terse when the ledger row has no resolved team", () => {
    expect(
      transactionNamesTeam({
        action: "added",
        userId: "owner-1",
        teamOwnerId: null,
      }),
    ).toBe(false);
  });
});

describe("TRANSACTION_SOURCES", () => {
  it("lists exactly the values the ledger's check constraint allows", () => {
    // Mirrors transactions_source_check in
    // 20261033_transaction_source.sql. The feed filters on `draft_pick` with a
    // plain inequality, so a rename on either side would not throw; it would
    // quietly put every draft pick back into the panel. This is the one place
    // that mismatch would be visible from.
    expect([...TRANSACTION_SOURCES]).toEqual([
      "draft_pick",
      "free_agent_pickup",
      "trade",
      "release",
    ]);
  });

  it("names draft_pick, the one source the league feed excludes", () => {
    expect(TRANSACTION_SOURCES).toContain("draft_pick");
  });

  it("covers every post-draft move the panel is specified to show", () => {
    for (const source of ["free_agent_pickup", "release", "trade"]) {
      expect(TRANSACTION_SOURCES).toContain(source);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(TRANSACTION_SOURCES).size).toBe(TRANSACTION_SOURCES.length);
  });
});
