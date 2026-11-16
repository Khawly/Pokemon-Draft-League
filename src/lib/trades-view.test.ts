/*
 * Tests for the trades page's view logic.
 *
 * These cover the rules that used to live inside the page component: which
 * trades appear on which tab, what the tab badges count, and the confirmation
 * copy for each action. The copy is worth testing because a wrong rejection
 * message is what made the old single-rejection rule read like a veto.
 */
import { describe, expect, it } from "vitest";

import {
  buildTradesView,
  parseTokenAmount,
  tradeActionPrompt,
  type TradeActionContext,
} from "@/lib/trades-view";
import type { Trade, TradesGoods } from "@/lib/supabase/trades";

/** Builds a trade with only the fields the view logic reads. */
function trade(overrides: Partial<Trade> & Pick<Trade, "status">): Trade {
  return {
    id: "trade-1",
    proposer_user_id: "me",
    recipient_user_id: "them",
    proposer_name: "Alice",
    recipient_name: "Bob",
    proposer_name_color: null,
    recipient_name_color: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    proposerTokenAmount: 0,
    recipientTokenAmount: 0,
    items: [],
    votes: [],
    ...overrides,
  };
}

/** Builds a payload with empty defaults and the supplied overrides. */
function makeGoods(overrides: Partial<TradesGoods> = {}): TradesGoods {
  return {
    league: { id: "league-1", name: "Test League", owner_id: "owner-1" },
    season: null,
    isCurrentSeason: true,
    settings: null,
    teams: [],
    myTeam: null,
    trades: [],
    dismissedTradeIds: new Set<string>(),
    spentByTeam: new Map<string, number>(),
    approverIds: [],
    currentUserId: "me",
    userRole: "member",
    canApprove: false,
    ...overrides,
  };
}

/** Context for the confirmation copy tests. */
const CONTEXT: TradeActionContext = {
  other: "Bob",
  proposer: "Alice",
  recipient: "Bob",
  requiresApproval: true,
  approverRequired: 3,
};

describe("buildTradesView", () => {
  it("returns an empty view before the payload loads", () => {
    expect(buildTradesView(null)).toEqual({
      myTrades: [],
      pendingApprovals: [],
      history: [],
      tabs: [],
    });
  });

  it("groups trades by status and keeps history out of my trades", () => {
    const completed = trade({ id: "c", status: "completed" });
    const pending = trade({ id: "p", status: "pending_approval" });
    const incoming = trade({
      id: "i",
      status: "awaiting_response",
      proposer_user_id: "them",
      recipient_user_id: "me",
    });
    const someoneElses = trade({
      id: "x",
      status: "awaiting_response",
      proposer_user_id: "other-1",
      recipient_user_id: "other-2",
    });

    const view = buildTradesView(
      makeGoods({ trades: [completed, pending, incoming, someoneElses] }),
    );

    expect(view.myTrades.map((entry) => entry.id)).toEqual(["c", "p", "i"]);
    expect(view.pendingApprovals.map((entry) => entry.id)).toEqual(["p"]);
    expect(view.history.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("hides a trade the member cleared without hiding it from the other party", () => {
    const cleared = trade({ id: "cleared", status: "completed" });

    const view = buildTradesView(
      makeGoods({
        trades: [cleared],
        dismissedTradeIds: new Set(["cleared"]),
      }),
    );

    // A dismissal is per member: it leaves My Trades but not league history.
    expect(view.myTrades).toEqual([]);
    expect(view.history.map((entry) => entry.id)).toEqual(["cleared"]);
  });

  it("counts open trades and listed rows separately on the strip", () => {
    const view = buildTradesView(
      makeGoods({
        trades: [
          trade({ id: "open", status: "awaiting_response" }),
          trade({ id: "done", status: "completed" }),
        ],
      }),
    );

    const mine = view.tabs.find((entry) => entry.id === "mine");
    expect(mine).toMatchObject({ badge: 1, total: 2 });

    const history = view.tabs.find((entry) => entry.id === "history");
    expect(history).toMatchObject({ badge: 0, total: 1 });
  });

  it("omits the New Trade tab for a past season", () => {
    const view = buildTradesView(makeGoods({ isCurrentSeason: false }));

    expect(view.tabs.map((entry) => entry.id)).toEqual(["mine", "history"]);
  });

  it("only offers the Approvals tab to members who can approve", () => {
    expect(buildTradesView(makeGoods()).tabs.map((entry) => entry.id)).toEqual([
      "new",
      "mine",
      "history",
    ]);

    expect(
      buildTradesView(makeGoods({ canApprove: true })).tabs.map(
        (entry) => entry.id,
      ),
    ).toEqual(["new", "mine", "approvals", "history"]);
  });
});

describe("tradeActionPrompt", () => {
  it("states how many rejections the trade needs", () => {
    const prompt = tradeActionPrompt("reject", CONTEXT);

    expect(prompt.detail).toContain("3 rejections will reject it");
    expect(prompt.tone).toBe("danger");
    expect(prompt.confirmLabel).toBe("Reject");
  });

  it("uses the singular when the quorum is one", () => {
    const prompt = tradeActionPrompt("reject", {
      ...CONTEXT,
      approverRequired: 1,
    });

    expect(prompt.detail).toContain("1 rejection will reject it");
  });

  it("does not claim a quorum exists when there are no approvers", () => {
    const prompt = tradeActionPrompt("reject", {
      ...CONTEXT,
      approverRequired: 0,
    });

    expect(prompt.detail).toBe(
      "Your rejection is recorded against this trade. The other approvers can still weigh in.",
    );
  });

  it("explains whether acceptance moves the Pokemon immediately", () => {
    expect(
      tradeActionPrompt("accept", CONTEXT).detail,
    ).toContain("still needs the league's approval");

    expect(
      tradeActionPrompt("accept", { ...CONTEXT, requiresApproval: false })
        .detail,
    ).toContain("move as soon as you accept");
  });

  it("marks only the destructive actions as danger", () => {
    const tone = (action: Parameters<typeof tradeActionPrompt>[0]) =>
      tradeActionPrompt(action, CONTEXT).tone;

    expect(tone("accept")).toBe("default");
    expect(tone("approve")).toBe("default");
    expect(tone("clear")).toBe("default");
    expect(tone("withdraw")).toBe("danger");
    expect(tone("reject")).toBe("danger");
    expect(tone("reject-override")).toBe("danger");
  });
});

describe("parseTokenAmount", () => {
  it("reads a typed amount", () => {
    expect(parseTokenAmount("12")).toBe(12);
  });

  it("treats a blank, invalid, zero, or negative field as no amount", () => {
    expect(parseTokenAmount("")).toBe(0);
    expect(parseTokenAmount("abc")).toBe(0);
    expect(parseTokenAmount("0")).toBe(0);
    expect(parseTokenAmount("-5")).toBe(0);
  });

  it("collapses a fractional entry to its integer part", () => {
    expect(parseTokenAmount("12.9")).toBe(12);
  });
});
