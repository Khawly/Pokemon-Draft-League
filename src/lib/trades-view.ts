/*
 * View logic for the trades page.
 *
 * The page needs four derived answers that have nothing to do with rendering:
 * which trades belong on each tab, what the tab strip says, which confirmation
 * copy an action uses, and what a token field means. Keeping them here makes the
 * page a layout component and lets the rules - especially the dismissal and
 * quorum copy - be unit tested without a browser.
 */
import {
  countOpenTrades,
  isProposer,
  isRecipient,
  type Trade,
  type TradesGoods,
} from "@/lib/supabase/trades";

/** The four views the trades page offers. */
export type TradesTab = "new" | "mine" | "approvals" | "history";

/** One entry on the tab strip. */
interface TradeTabEntry {
  id: TradesTab;
  label: string;
  /** Trades still in flight, drawn as the red bubble. */
  badge: number;
  /** Rows the tab holds, shown as a quiet count when nothing is live. */
  total: number;
  /** What the bubble's screen-reader label calls these. */
  subject: string;
}

/** Everything the page derives from its payload in one pass. */
export interface TradesView {
  /** Trades the reader is party to and has not cleared. */
  myTrades: Trade[];
  pendingApprovals: Trade[];
  /** Completed trades, which are league record rather than a to-do. */
  history: Trade[];
  /** Tab strip entries, in display order. */
  tabs: TradeTabEntry[];
}

/** Actions the trade cards and confirmation dialogs know about. */
export type TradeAction =
  | "accept"
  | "decline"
  | "withdraw"
  | "approve"
  | "reject"
  | "override"
  | "reject-override"
  | "clear";

/** Content for the confirmation dialog raised by a {@link TradeAction}. */
export interface TradeActionPrompt {
  title: string;
  /** What the action will do, in the reader's terms. */
  detail: string;
  confirmLabel: string;
  /** `danger` styles actions that cannot be taken back. */
  tone: "default" | "danger";
}

/** Per-trade facts the confirmation copy needs. */
export interface TradeActionContext {
  /** The counterparty's display name. */
  other: string;
  /** The proposer's display name. */
  proposer: string;
  /** The recipient's display name. */
  recipient: string;
  /** Whether accepted trades still need the league's approval. */
  requiresApproval: boolean;
  /** Approval votes the league's quorum needs. */
  approverRequired: number;
}

/** Empty view, used before the payload has loaded. */
const EMPTY_VIEW: TradesView = {
  myTrades: [],
  pendingApprovals: [],
  history: [],
  tabs: [],
};

/**
 * Splits the payload into the three lists and builds the tab strip.
 *
 * The lists and the counts are produced together so a tab's bubble cannot
 * disagree with the rows it sits above. A past season also loses its New Trade
 * tab: there is nothing to propose into, and a new trade would be filed against
 * the current season rather than the one being read.
 *
 * @param goods - The loaded page payload, or null before it arrives.
 * @returns The lists and tab entries, all empty when there is no payload.
 */
export function buildTradesView(goods: TradesGoods | null): TradesView {
  if (!goods) {
    return EMPTY_VIEW;
  }

  const myTrades = goods.trades.filter(
    (trade) =>
      (isProposer(trade, goods.currentUserId) ||
        isRecipient(trade, goods.currentUserId)) &&
      !goods.dismissedTradeIds.has(trade.id),
  );

  /*
   * Every trade awaiting a decision, including the reader's own. The Owner is
   * always an approver, so an Owner who proposed a trade has to be able to settle
   * it from this tab; filtering party trades out left exactly that trade invisible
   * to the only member who could act on it.
   */
  const pendingApprovals = goods.trades.filter(
    (trade) => trade.status === "pending_approval",
  );

  const history = goods.trades.filter((trade) => trade.status === "completed");

  const tabs: TradeTabEntry[] = [];

  if (goods.isCurrentSeason) {
    tabs.push({
      id: "new",
      label: "New Trade",
      badge: 0,
      total: 0,
      subject: "trade",
    });
  }

  tabs.push({
    id: "mine",
    label: "My Trades",
    badge: countOpenTrades(goods.trades, "my-trades", goods.currentUserId),
    total: myTrades.length,
    subject: "trade",
  });

  if (goods.canApprove) {
    tabs.push({
      id: "approvals",
      label: "Approvals",
      badge: countOpenTrades(
        goods.trades,
        "awaiting-approval",
        goods.currentUserId,
      ),
      total: pendingApprovals.length,
      subject: "approval",
    });
  }

  tabs.push({
    id: "history",
    label: "Trade History",
    // A record, not a to-do: nothing in the history is ever still in flight.
    badge: 0,
    total: history.length,
    subject: "trade",
  });

  return { myTrades, pendingApprovals, history, tabs };
}

/**
 * Builds the confirmation dialog copy for a trade action.
 *
 * A plain rejection is a vote rather than a verdict, so its copy states how many
 * rejections the trade actually needs instead of implying the trade is settled.
 *
 * @param action - The action being confirmed.
 * @param context - Names and quorum facts for the trade.
 * @returns The dialog's title, detail, confirm label, and tone.
 */
export function tradeActionPrompt(
  action: TradeAction,
  context: TradeActionContext,
): TradeActionPrompt {
  const { other, proposer, recipient, requiresApproval, approverRequired } =
    context;

  const rejectPlural = approverRequired === 1 ? "" : "s";
  const rejectDetail = `Your rejection is recorded against this trade. ${
    approverRequired > 0
      ? `${approverRequired} rejection${rejectPlural} will reject it, and the other approvers can still weigh in until then.`
      : "The other approvers can still weigh in."
  }`;

  const titles: Record<TradeAction, string> = {
    accept: "Accept this trade?",
    decline: "Decline this trade?",
    withdraw: "Withdraw this proposal?",
    approve: "Approve this trade?",
    reject: "Vote to reject this trade?",
    override: "Override and complete this trade?",
    "reject-override": "Override and reject this trade?",
    clear: "Clear this trade?",
  };

  const details: Record<TradeAction, string> = {
    accept: `${other} will be told you accepted. ${
      requiresApproval
        ? "It still needs the league's approval before the Pokémon move."
        : "The Pokémon move as soon as you accept."
    }`,
    decline: `${other} will be told you declined.`,
    withdraw: `${other} will be told the proposal was withdrawn.`,
    approve: "Your approval is recorded against this trade.",
    reject: rejectDetail,
    override:
      "This completes the trade now, without waiting for the other approvers.",
    "reject-override": `This rejects the trade now, without waiting for the other approvers. ${proposer} and ${recipient} will both be told.`,
    clear:
      "This removes the trade from your own list. It stays in league history.",
  };

  const confirmLabels: Record<TradeAction, string> = {
    accept: "Accept",
    decline: "Decline",
    withdraw: "Withdraw",
    approve: "Approve",
    reject: "Reject",
    override: "Approve (Override)",
    "reject-override": "Reject (Override)",
    clear: "Clear",
  };

  return {
    title: titles[action],
    detail: details[action],
    confirmLabel: confirmLabels[action],
    tone:
      action === "reject" ||
      action === "reject-override" ||
      action === "withdraw"
        ? "danger"
        : "default",
  };
}

/**
 * Parses a token amount field.
 *
 * The field holds a raw string while the member types, so an empty box or a
 * partial entry has to resolve to zero rather than NaN. Negative and fractional
 * values collapse to zero because `propose_trade` only accepts a non-negative
 * integer.
 *
 * @param raw - The field's raw contents.
 * @returns The amount to send, or zero when the field is blank or unusable.
 */
export function parseTokenAmount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
