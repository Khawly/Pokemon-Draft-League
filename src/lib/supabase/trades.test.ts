/*
 * Tests for the trades page's pure logic.
 *
 * Targets the arithmetic the database also runs: the quorum rule and the two-sided
 * balance projection. Both are the kind of thing that looks right until a league
 * has three approvers and a member trades a tier 5 for nothing, which is exactly
 * where a wrong expectation would be expensive to discover in production.
 */
import { describe, expect, it } from "vitest";
import {
  approvalProgress,
  canVoteOnTrade,
  countOpenTrades,
  findTeamByOwner,
  formatTokenSwing,
  getTeamSalary,
  isTradeOpen,
  projectTradeBalance,
  requiredApprovals,
  totalTierValue,
  tradeOpponents,
  tradeSideLabels,
  tradeStatusLabel,
  tradeValueShift,
  type Trade,
  type TradePokemon,
  type TradeTeam,
  type TradesGoods,
} from "@/lib/supabase/trades";

/**
 * Builds a minimal trades payload for the salary and projection rules.
 *
 * The roster and ledger are supplied separately so a test can set up a team whose
 * roster tiers and whose ledger sum disagree, which is the state a completed trade
 * has to reconcile.
 */
function makeGoods({
  teams,
  spentByTeam,
  budget = 100,
  enableCosts = true,
  perTeamOverride,
}: {
  teams: Array<{ id: string; owner_user_id: string }>;
  spentByTeam: Record<string, number>;
  budget?: number;
  enableCosts?: boolean;
  perTeamOverride?: Record<string, number>;
}): TradesGoods {
  return {
    league: { id: "league-1", name: "Test League", owner_id: "owner-1" },
    season: {
      id: "season-1",
      season_number: 1,
      status: "draft_complete",
      name: null,
    },
    settings: {
      enable_pokemon_costs: enableCosts,
      total_token_salary: budget,
      allow_per_team_salary: perTeamOverride != null,
      admins_approve_trades: true,
      owners_admins_vote_on_trades: true,
    },
    teams: teams.map((team) => ({
      id: team.id,
      owner_user_id: team.owner_user_id,
      team_name: "Snapshot",
      owner_name: null,
      owner_avatar_url: null,
      draft_position: null,
      total_salary_override: perTeamOverride?.[team.id] ?? null,
      roster: [],
    })),
    myTeam: null,
    trades: [],
    dismissedTradeIds: new Set<string>(),
    spentByTeam: new Map(Object.entries(spentByTeam)),
    approverIds: [],
    currentUserId: "user-1",
    userRole: "member",
    canApprove: false,
  };
}

/** Builds a roster Pokémon with a tier value. */
function pokemon(pokemonId: string, tier: number): TradePokemon {
  return {
    pokemon_id: pokemonId,
    species_name: pokemonId,
    name: pokemonId,
    tier_value: tier,
    types: [],
    spriteId: 0,
    bst: null,
  };
}

/** Builds a trade with the given status and recorded votes. */
function makeTrade(
  overrides: Partial<Trade> & Pick<Trade, "status">,
): Trade {
  return {
    id: "trade-1",
    proposer_user_id: "user-1",
    recipient_user_id: "user-2",
    proposer_name: "Alice",
    recipient_name: "Bob",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    items: [],
    votes: [],
    ...overrides,
  };
}

/** Builds a vote row. */
function vote(
  voter: string,
  decision: "approved" | "rejected" = "approved",
  isOverride = false,
) {
  return {
    voter_user_id: voter,
    voter_name: voter,
    decision,
    is_override: isOverride,
    created_at: "2026-01-02T00:00:00.000Z",
  };
}

describe("findTeamByOwner", () => {
  const teams: TradeTeam[] = [
    {
      id: "team-1",
      owner_user_id: "user-1",
      team_name: "Ash",
      owner_name: "Ash",
      owner_avatar_url: null,
      draft_position: 1,
      total_salary_override: null,
      roster: [pokemon("pikachu", 3)],
    },
    {
      id: "team-2",
      owner_user_id: "user-2",
      team_name: "Misty",
      owner_name: "Misty",
      owner_avatar_url: null,
      draft_position: 2,
      total_salary_override: null,
      roster: [pokemon("staryu", 2)],
    },
  ];

  it("resolves a member from the user id the picker holds", () => {
    // The select stores `owner_user_id` and propose_trade takes a user id, so this is
    // the lookup that has to work for the recipient's roster to render at all.
    expect(findTeamByOwner(teams, "user-2")?.id).toBe("team-2");
    expect(findTeamByOwner(teams, "user-1")?.roster[0].name).toBe("pikachu");
  });

  it("does not match a team id against the owner column", () => {
    /*
     * The regression this pins: both ids are UUIDs, so comparing the selection
     * against `id` instead of `owner_user_id` found nothing and the receive-side
     * picker rendered empty with no error. Any lookup given a team id must miss.
     */
    expect(findTeamByOwner(teams, "team-2")).toBeNull();
    expect(findTeamByOwner(teams, "team-1")).toBeNull();
  });

  it("returns null for an empty or unknown id", () => {
    expect(findTeamByOwner(teams, "")).toBeNull();
    expect(findTeamByOwner(teams, "user-404")).toBeNull();
  });
});

describe("tradeOpponents", () => {
  const teams = [
    { id: "team-1", owner_user_id: "user-1" },
    { id: "team-2", owner_user_id: "user-2" },
    { id: "team-3", owner_user_id: "user-3" },
  ] as TradeTeam[];

  it("excludes the signed-in member", () => {
    const others = tradeOpponents(teams, "user-1");

    expect(others.map((team) => team.owner_user_id)).toEqual(["user-2", "user-3"]);
  });

  it("returns everyone else for a member not in the list", () => {
    expect(tradeOpponents(teams, "user-404")).toHaveLength(3);
  });
});

describe("tradeValueShift", () => {
  it("reports the token each side gains or loses", () => {
    /*
     * The scenario the trades page had to render: Khawly offers Charmander and
     * Spheal (3 tokens of tier between them) for Bam A's Azurill and Kabuto (2).
     * Khawly is relieved of 3 and charged 2, so his balance rises by 1; Bam A is
     * the mirror, because a trade conserves the league's total tier value.
     */
    const shift = tradeValueShift(
      [pokemon("charmander", 2), pokemon("spheal", 1)],
      [pokemon("azurill", 1), pokemon("kabuto", 1)],
      true,
    );

    expect(shift.proposerDelta).toBe(1);
    expect(shift.recipientDelta).toBe(-1);
    expect(shift.proposerDelta).toBe(-shift.recipientDelta);
  });

  it("reads a gift as a loss for the receiver", () => {
    // A one-sided trade hands value over, so the giver frees tokens and the
    // receiver pays for what they take on.
    const shift = tradeValueShift([], [pokemon("eevee", 4)], true);

    expect(shift.proposerDelta).toBe(-4);
    expect(shift.recipientDelta).toBe(4);
  });

  it("reports no change when both sides give up equal value", () => {
    const shift = tradeValueShift(
      [pokemon("garchomp", 8)],
      [pokemon("ditto", 8)],
      true,
    );

    expect(shift.proposerDelta).toBe(0);
    expect(shift.recipientDelta).toBe(0);
    // Plain zero, not -0: the two are equal under `===` but not under `Object.is`,
    // so a -0 would slip past a naive equality assertion and surprise a caller
    // comparing identities.
    expect(Object.is(shift.recipientDelta, 0)).toBe(true);
  });

  it("moves nothing when the league has costs switched off", () => {
    // No tier was ever charged, so there is no balance for a trade to move.
    const shift = tradeValueShift(
      [pokemon("garchomp", 8)],
      [pokemon("ditto", 1)],
      false,
    );

    expect(shift.proposerDelta).toBe(0);
    expect(Object.is(shift.proposerDelta, 0)).toBe(true);
    expect(Object.is(shift.recipientDelta, 0)).toBe(true);
  });

  it("agrees with projectTradeBalance for the same trade", () => {
    /*
     * The card and the proposal form quote the same trade on the same page, so they
     * must not be able to disagree about which side gains. Both derive from this one
     * function; this pins that they still do.
     */
    const goods = makeGoods({
      teams: [
        { id: "team-1", owner_user_id: "user-1" },
        { id: "team-2", owner_user_id: "user-2" },
      ],
      spentByTeam: { "team-1": 40, "team-2": 10 },
      budget: 100,
    });

    const outgoing = [pokemon("charmander", 2), pokemon("spheal", 1)];
    const incoming = [pokemon("azurill", 1), pokemon("kabuto", 1)];

    const shift = tradeValueShift(outgoing, incoming, true);
    const projection = projectTradeBalance(
      goods,
      "team-1",
      "team-2",
      outgoing,
      incoming,
    );

    expect(shift.proposerDelta).toBe(projection.proposerDelta);
    expect(shift.recipientDelta).toBe(projection.recipientDelta);
    // And the balances follow from those deltas, not from a second derivation.
    expect(projection.proposerRemaining).toBe(
      getTeamSalary(goods, "team-1").remaining + shift.proposerDelta,
    );
  });
});

describe("formatTokenSwing", () => {
  it("renders a gain with a plus and no extra unit", () => {
    expect(formatTokenSwing(1)).toBe("+1 Token");
    expect(formatTokenSwing(4)).toBe("+4 Tokens");
  });

  it("renders a loss with a minus", () => {
    expect(formatTokenSwing(-1)).toBe("-1 Token");
    expect(formatTokenSwing(-12)).toBe("-12 Tokens");
  });

  it("states a no-change trade rather than printing a signed zero", () => {
    expect(formatTokenSwing(0)).toBe("0 Tokens");
  });

  it("builds the sentence the card shows", () => {
    // The full line for the scenario above, as a member reads it.
    const shift = tradeValueShift(
      [pokemon("charmander", 2), pokemon("spheal", 1)],
      [pokemon("azurill", 1), pokemon("kabuto", 1)],
      true,
    );

    expect(
      `Value Exchanged: ${formatTokenSwing(shift.proposerDelta)} for Khawly and ` +
        `${formatTokenSwing(shift.recipientDelta)} for Bam A`,
    ).toBe("Value Exchanged: +1 Token for Khawly and -1 Token for Bam A");
  });
});

describe("countOpenTrades", () => {
  const me = "user-1";

  it("counts a proposal the member sent and is waiting on", () => {
    /*
     * Corrected from the opposite expectation. The bubble means "a trade of mine is
     * still in flight", not "it is my turn": the member can only Withdraw this one,
     * but they hold it and it has not settled, so it counts. Excluding it made the
     * two sides of one trade render differently, which read as a per-account bug.
     */
    const trades = [
      makeTrade({
        status: "awaiting_response",
        proposer_user_id: "user-1",
        recipient_user_id: "user-2",
      }),
    ];

    expect(countOpenTrades(trades, "my-trades", me)).toBe(1);
  });

  it("counts a proposal the member was asked to answer", () => {
    const trades = [
      makeTrade({
        status: "awaiting_response",
        proposer_user_id: "user-2",
        recipient_user_id: "user-1",
      }),
    ];

    expect(countOpenTrades(trades, "my-trades", me)).toBe(1);
  });

  it("counts a pending trade for a member who cannot approve it", () => {
    /*
     * The other side of the same fix. Bam A accepted and is waiting on an approver,
     * but the trade is still live and still theirs, so it counts. Gating this on
     * approval rights is what left a member with an open trade and no bubble.
     */
    const trades = [
      makeTrade({
        status: "pending_approval",
        proposer_user_id: "user-2",
        recipient_user_id: "user-1",
      }),
    ];

    expect(countOpenTrades(trades, "my-trades", me)).toBe(1);
  });

  it("ignores trades the member is not party to", () => {
    const trades = [
      makeTrade({
        status: "awaiting_response",
        proposer_user_id: "user-8",
        recipient_user_id: "user-9",
      }),
      makeTrade({
        status: "pending_approval",
        proposer_user_id: "user-8",
        recipient_user_id: "user-9",
      }),
    ];

    expect(countOpenTrades(trades, "my-trades", me)).toBe(0);
  });

  it("ignores the member's own trades that have settled", () => {
    const trades = [
      makeTrade({ status: "completed", proposer_user_id: "user-1" }),
      makeTrade({ status: "rejected", proposer_user_id: "user-1" }),
      makeTrade({ status: "cancelled", proposer_user_id: "user-1" }),
    ];

    expect(countOpenTrades(trades, "my-trades", me)).toBe(0);
  });

  it("counts every pending trade in the approvals scope", () => {
    const trades = [
      makeTrade({ status: "pending_approval", proposer_user_id: "user-1" }),
      makeTrade({ status: "pending_approval", proposer_user_id: "user-7" }),
      makeTrade({
        status: "awaiting_response",
        proposer_user_id: "user-8",
        recipient_user_id: "user-9",
      }),
    ];

    // Scope is not the member's own, so this counts the third trade's absence by
    // status only: awaiting_response trades are not awaiting a vote.
    expect(countOpenTrades(trades, "awaiting-approval", me)).toBe(2);
  });

  it("never lets the bubble exceed what the tab it sits on holds", () => {
    /*
     * The badge and the list are the same set, so a bubble can never claim more
     * items than the tab actually shows.
     */
    const trades = [
      makeTrade({ status: "awaiting_response", proposer_user_id: "user-1" }),
      makeTrade({
        status: "pending_approval",
        proposer_user_id: "user-1",
        recipient_user_id: "user-2",
      }),
      makeTrade({ status: "completed", proposer_user_id: "user-1" }),
    ];

    const mineHolds = trades.filter(
      (trade) =>
        trade.proposer_user_id === me || trade.recipient_user_id === me,
    ).length;

    expect(countOpenTrades(trades, "my-trades", me)).toBeLessThanOrEqual(
      mineHolds,
    );
  });

  it("gives both members of one trade the same live count", () => {
    /*
     * The symmetry that prompted the change: the two people on either side of a
     * trade are both told it is in flight, so the tab never renders red for one and
     * grey for the other.
     */
    const trades = [
      makeTrade({
        status: "pending_approval",
        proposer_user_id: "user-1",
        recipient_user_id: "user-2",
      }),
    ];

    expect(countOpenTrades(trades, "my-trades", "user-1")).toBe(
      countOpenTrades(trades, "my-trades", "user-2"),
    );
  });
});

describe("canVoteOnTrade", () => {
  it("lets the owner approve a trade they proposed themselves", () => {
    /*
     * The regression. The Owner is always an approver, so an Owner whose own
     * proposal was accepted is the person who has to settle it. An earlier version
     * excluded party trades from the Approvals tab, which left this trade stuck in
     * 'pending_approval' with nobody able to see or advance it.
     */
    const trade = makeTrade({
      status: "pending_approval",
      proposer_user_id: "owner-1",
    });

    expect(canVoteOnTrade(trade, true)).toBe(true);
  });

  it("lets the owner approve a trade they were sent", () => {
    const trade = makeTrade({
      status: "pending_approval",
      proposer_user_id: "user-1",
      recipient_user_id: "owner-1",
    });

    expect(canVoteOnTrade(trade, true)).toBe(true);
  });

  it("is true for an admin who happens to be a party", () => {
    const trade = makeTrade({ status: "pending_approval" });

    expect(canVoteOnTrade(trade, true)).toBe(true);
  });

  it("is false for a member who cannot approve at all", () => {
    // The badge-bearing rule must not hand vote controls to an ordinary member.
    expect(canVoteOnTrade(makeTrade({ status: "pending_approval" }), false)).toBe(
      false,
    );
  });

  it("is false once the trade is no longer awaiting approval", () => {
    for (const status of [
      "awaiting_response",
      "approved",
      "completed",
      "rejected",
      "cancelled",
    ] as const) {
      expect(canVoteOnTrade(makeTrade({ status }), true)).toBe(false);
    }
  });
});

describe("requiredApprovals", () => {
  it("needs every approver when there are one or two", () => {
    // "More than half" of 2 is 3, so one approval out of two cannot carry it.
    expect(requiredApprovals(1)).toBe(1);
    expect(requiredApprovals(2)).toBe(2);
  });

  it("needs a bare majority from three up", () => {
    expect(requiredApprovals(3)).toBe(2);
    expect(requiredApprovals(4)).toBe(3);
    expect(requiredApprovals(5)).toBe(3);
    expect(requiredApprovals(6)).toBe(4);
    expect(requiredApprovals(7)).toBe(4);
  });

  it("requires nothing when nobody can vote", () => {
    expect(requiredApprovals(0)).toBe(0);
    expect(requiredApprovals(-1)).toBe(0);
  });
});

describe("approvalProgress", () => {
  const approvers = ["owner-1", "admin-1", "admin-2"];

  it("counts approvals against the majority of three", () => {
    const one = approvalProgress(
      makeTrade({ status: "pending_approval", votes: [vote("owner-1")] }),
      approvers,
    );
    expect(one.approvals).toBe(1);
    expect(one.required).toBe(2);
    expect(one.quorumMet).toBe(false);

    const two = approvalProgress(
      makeTrade({
        status: "pending_approval",
        votes: [vote("owner-1"), vote("admin-1")],
      }),
      approvers,
    );
    expect(two.approvals).toBe(2);
    expect(two.quorumMet).toBe(true);
  });

  it("lets the owner alone carry it when admins do not vote", () => {
    // Owner-only is the default: one approver needs one approval.
    const progress = approvalProgress(
      makeTrade({ status: "pending_approval", votes: [vote("owner-1")] }),
      ["owner-1"],
    );
    expect(progress.required).toBe(1);
    expect(progress.quorumMet).toBe(true);
  });

  it("ignores a vote from someone who is no longer an approver", () => {
    // A demoted admin's earlier approval must not carry a trade. Counting it would
    // let a trade complete on a voice that no longer has standing.
    const progress = approvalProgress(
      makeTrade({
        status: "pending_approval",
        votes: [vote("admin-1"), vote("admin-2")],
      }),
      ["owner-1"],
    );
    expect(progress.approvals).toBe(0);
    expect(progress.quorumMet).toBe(false);
  });

  it("reports rejections separately from approvals", () => {
    const progress = approvalProgress(
      makeTrade({
        status: "pending_approval",
        votes: [vote("owner-1"), vote("admin-1", "rejected")],
      }),
      approvers,
    );
    expect(progress.approvals).toBe(1);
    expect(progress.rejections).toBe(1);
  });

  it("flags a trade the owner settled by override", () => {
    const progress = approvalProgress(
      makeTrade({
        status: "completed",
        votes: [vote("owner-1", "approved", true)],
      }),
      approvers,
    );
    expect(progress.overridden).toBe(true);
  });

  it("never reports a quorum when there is nobody to vote", () => {
    // A zero denominator must not read as "0 of 0, done": that would let a trade
    // complete with nobody having agreed to it.
    const progress = approvalProgress(
      makeTrade({ status: "pending_approval", votes: [] }),
      [],
    );
    expect(progress.required).toBe(0);
    expect(progress.quorumMet).toBe(false);
  });
});

describe("getTeamSalary", () => {
  it("subtracts the ledger sum from the league budget", () => {
    const goods = makeGoods({
      teams: [{ id: "team-1", owner_user_id: "user-1" }],
      spentByTeam: { "team-1": 30 },
      budget: 100,
    });

    expect(getTeamSalary(goods, "team-1")).toEqual({
      budget: 100,
      spent: 30,
      remaining: 70,
    });
  });

  it("prefers a per-team override only when the league allows one", () => {
    const withOverride = makeGoods({
      teams: [{ id: "team-1", owner_user_id: "user-1" }],
      spentByTeam: { "team-1": 30 },
      budget: 100,
      perTeamOverride: { "team-1": 50 },
    });
    expect(getTeamSalary(withOverride, "team-1").budget).toBe(50);

    const ignored = makeGoods({
      teams: [{ id: "team-1", owner_user_id: "user-1" }],
      spentByTeam: { "team-1": 30 },
      budget: 100,
    });
    // The same override value with allow_per_team_salary off must fall back to the
    // league budget rather than being honoured.
    ignored.settings!.allow_per_team_salary = false;
    ignored.teams[0].total_salary_override = 50;
    expect(getTeamSalary(ignored, "team-1").budget).toBe(100);
  });

  it("treats the balance as unlimited when costs are off", () => {
    const goods = makeGoods({
      teams: [{ id: "team-1", owner_user_id: "user-1" }],
      spentByTeam: { "team-1": 30 },
      enableCosts: false,
    });

    const salary = getTeamSalary(goods, "team-1");
    expect(salary.remaining).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("projectTradeBalance", () => {
  it("moves each side's balance by the tier value it gains or gives", () => {
    const goods = makeGoods({
      teams: [
        { id: "team-1", owner_user_id: "user-1" },
        { id: "team-2", owner_user_id: "user-2" },
      ],
      spentByTeam: { "team-1": 40, "team-2": 10 },
      budget: 100,
    });

    const projection = projectTradeBalance(
      goods,
      "team-1",
      "team-2",
      [pokemon("garchomp", 8)],
      [pokemon("ditto", 2)],
    );

    // Alice gives a tier 8 and receives a tier 2, so she frees up 6 tokens.
    expect(projection.proposerDelta).toBe(6);
    expect(projection.proposerRemaining).toBe(66);
    // Bob is the mirror of it, because the exchange conserves total tier value.
    expect(projection.recipientDelta).toBe(-6);
    expect(projection.recipientRemaining).toBe(84);
    expect(projection.affordable).toBe(true);
  });

  it("refuses a trade that would leave a side below zero", () => {
    const goods = makeGoods({
      teams: [
        { id: "team-1", owner_user_id: "user-1" },
        { id: "team-2", owner_user_id: "user-2" },
      ],
      // Bob has 5 tokens left and would be handed a tier 10 he cannot afford.
      spentByTeam: { "team-1": 20, "team-2": 95 },
      budget: 100,
    });

    const projection = projectTradeBalance(
      goods,
      "team-1",
      "team-2",
      [pokemon("mewtwo", 10)],
      [],
    );

    // The tier travels with the Pokémon, so receiving it is what costs Bob.
    expect(projection.proposerDelta).toBe(10);
    expect(projection.proposerRemaining).toBe(90);
    expect(projection.recipientDelta).toBe(-10);
    expect(projection.recipientRemaining).toBe(-5);
    expect(projection.affordable).toBe(false);
  });

  it("allows a one-sided trade, which is a gift rather than an exchange", () => {
    const goods = makeGoods({
      teams: [
        { id: "team-1", owner_user_id: "user-1" },
        { id: "team-2", owner_user_id: "user-2" },
      ],
      spentByTeam: { "team-1": 90, "team-2": 90 },
      budget: 100,
    });

    // Bob sends an Eevee and asks for nothing back.
    const projection = projectTradeBalance(
      goods,
      "team-1",
      "team-2",
      [],
      [pokemon("eevee", 1)],
    );

    // Alice pays the tier for what she takes on; Bob is credited for giving it up.
    expect(projection.proposerRemaining).toBe(9);
    expect(projection.recipientRemaining).toBe(11);
    expect(projection.affordable).toBe(true);
  });

  it("ignores tier values entirely when the league has costs switched off", () => {
    const goods = makeGoods({
      teams: [
        { id: "team-1", owner_user_id: "user-1" },
        { id: "team-2", owner_user_id: "user-2" },
      ],
      spentByTeam: { "team-1": 0, "team-2": 0 },
      enableCosts: false,
    });

    const projection = projectTradeBalance(
      goods,
      "team-1",
      "team-2",
      [pokemon("garchomp", 8)],
      [pokemon("mewtwo", 10)],
    );

    // No tier was ever charged, so nothing moves and nothing is unaffordable.
    expect(projection.proposerDelta).toBe(0);
    expect(projection.proposerRemaining).toBe(Number.POSITIVE_INFINITY);
    expect(projection.affordable).toBe(true);
  });

  it("is affordable for a zero-for-zero proposal", () => {
    const goods = makeGoods({
      teams: [
        { id: "team-1", owner_user_id: "user-1" },
        { id: "team-2", owner_user_id: "user-2" },
      ],
      spentByTeam: { "team-1": 100, "team-2": 100 },
      budget: 100,
    });

    const projection = projectTradeBalance(goods, "team-1", "team-2", [], []);
    expect(projection.affordable).toBe(true);
    expect(projection.proposerRemaining).toBe(0);
  });
});

describe("totalTierValue", () => {
  it("sums the tiers of everything moving", () => {
    expect(
      totalTierValue([pokemon("a", 3), pokemon("b", 0), pokemon("c", 4)]),
    ).toBe(7);
  });

  it("is zero for an empty side", () => {
    expect(totalTierValue([])).toBe(0);
  });
});

describe("tradeStatusLabel", () => {
  it("labels every status the schema can produce", () => {
    expect(tradeStatusLabel("awaiting_response")).toBe("Awaiting Response");
    expect(tradeStatusLabel("pending_approval")).toBe("Pending Approval");
    expect(tradeStatusLabel("completed")).toBe("Completed");
    expect(tradeStatusLabel("rejected")).toBe("Trade Rejected");
    expect(tradeStatusLabel("cancelled")).toBe("Cancelled");
  });
});

describe("isTradeOpen", () => {
  it("is open only while something can still happen to it", () => {
    expect(isTradeOpen("awaiting_response")).toBe(true);
    expect(isTradeOpen("pending_approval")).toBe(true);
    expect(isTradeOpen("approved")).toBe(true);
    expect(isTradeOpen("completed")).toBe(false);
    expect(isTradeOpen("rejected")).toBe(false);
    expect(isTradeOpen("cancelled")).toBe(false);
  });
});

describe("tradeSideLabels", () => {
  it("reads the proposer's own card as You and Them", () => {
    const trade = makeTrade({ status: "awaiting_response" });
    const labels = tradeSideLabels(trade, "user-1");

    expect(labels.proposer).toBe("You");
    expect(labels.recipient).toBe("Bob");
    expect(labels.other).toBe("Bob");
  });

  it("reads the recipient's own card the other way round", () => {
    const trade = makeTrade({ status: "awaiting_response" });
    const labels = tradeSideLabels(trade, "user-2");

    expect(labels.proposer).toBe("Alice");
    expect(labels.recipient).toBe("You");
    expect(labels.other).toBe("Alice");
  });

  it("names both sides for a member who is neither", () => {
    const trade = makeTrade({ status: "completed" });
    const labels = tradeSideLabels(trade, "user-3");

    expect(labels.proposer).toBe("Alice");
    expect(labels.recipient).toBe("Bob");
  });
});
