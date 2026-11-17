/*
 * Trades page for the Pokemon Draft League.
 *
 * Implements spec section 12 across four tabs. **New Trade** builds a proposal:
 * pick a member, choose the Pokémon to send and to receive, and both sides'
 * projected token balances are shown before anything is submitted. **My Trades**
 * lists every trade the member is party to, with Accept/Decline on an incoming
 * proposal and Withdraw on one they sent. **Approvals** is the owner and admins'
 * vote on trades awaiting approval, recording the tally the spec's quorum rule
 * needs. **Trade History** is the league-wide record of completed trades, each with
 * the timestamp it settled at.
 *
 * Every action here is a confirmation and every action is an RPC: the browser never
 * writes to `trades`, `trade_items`, or `trade_votes`, so the state machine, the
 * quorum, and the roster swap are all enforced in the database rather than by this
 * page. The buttons are gated on the member's role for the interface's sake only --
 * hiding one that the database would refuse is courtesy, not the control.
 *
 * Member display names are rendered through `MemberName`, so a member who has picked
 * a colour from the settings palette is credited to that colour everywhere their
 * name appears on a card -- proposer, recipient, or the voter on a recorded decision.
 * Copy that cannot hold an element (the `<option>` list, and the confirm and notice
 * strings, which are plain text by nature) stays uncoloured by design.
 */
"use client";

import { useMemo, useState, type ReactNode } from "react";
import { getSelectedSeason } from "@/lib/season-selection";
import { useConfirm } from "@/components/confirm-dialog";
import { MemberName } from "@/components/member-name";
import { PokemonSprite } from "@/components/pokemon-sprite";
import { TabNotification } from "@/components/nav-alert-badge";
import { useShellLeague } from "@/components/league-shell-context";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { formatDateTimeInZone, formatTimeZoneLabel } from "@/lib/datetime";
import { useUserTimeZone } from "@/lib/user-timezone";
import { isDeadlinePassed } from "@/lib/deadlines";
import { useRealtimeInvalidation } from "@/lib/use-realtime-invalidation";
import { useLeaguePageData } from "@/lib/use-league-page-data";
import { typeStyle } from "@/lib/type-styles";
import { PageShell, PageShellError, PageShellLoading } from "@/components/page-shell";
import {
  buildTradesView,
  parseTokenAmount,
  tradeActionPrompt,
  type TradeAction,
  type TradesTab,
} from "@/lib/trades-view";
import {
  approvalProgress,
  cancelTrade,
  canVoteOnTrade,
  dismissTrade,
  findTeamByOwner,
  formatTokenSwing,
  getTeamSalary,
  isProposer,
  isRecipient,
  isTradeOpen,
  loadTradesPageData,
  projectTradeBalance,
  proposeTrade,
  respondToTrade,
  requiredApprovals,
  totalTierValue,
  tradeSideLabels,
  tradeStatusLabel,
  tradeOpponents,
  tradeValueShift,
  voteOnTrade,
  type Trade,
  type TradeItem,
  type TradePokemon,
  type TradesGoods,
} from "@/lib/supabase/trades";
import { Card } from "@/components/card";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/button";

/** Pill styling per status, so a trade's state is legible without reading the text. */
const STATUS_STYLES: Record<Trade["status"], string> = {
  awaiting_response: "bg-amber-500/15 text-amber-300",
  pending_approval: "bg-violet-500/15 text-violet-300",
  approved: "bg-cyan-500/15 text-cyan-300",
  rejected: "bg-rose-500/15 text-rose-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-slate-700 text-slate-300",
};

/**
 * The trade centre.
 *
 * The league and season come from the shell provider, so this page no longer
 * reads search params and needs no Suspense boundary of its own.
 *
 * @returns The trades page.
 */
export default function TradesPage() {
  return <TradesPageContent />;
}

/**
 * Renders a Pokémon's typing as badges.
 *
 * @param props - The PokeAPI type names to render.
 * @returns A row of type badges, or nothing when the species is untyped.
 */
function TypeBadges({ types }: { types: string[] }) {
  if (types.length === 0) {
    return null;
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      {types.map((type) => (
        <span
          key={type}
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize ${typeStyle(type)}`}
        >
          {type}
        </span>
      ))}
    </span>
  );
}

/**
 * Renders a tier value. There is no upper bound, so any positive tier reads as
 * "Tier N" and an untiered Pokémon reads as "0" rather than as tier zero.
 *
 * @param tier - The tier integer.
 * @returns The display label.
 */
function tierLabel(tier: number): string {
  return tier === 0 ? "0" : `Tier ${tier}`;
}

/**
 * Renders a token balance, or a plain statement when the league has costs off.
 *
 * @param props - The remaining balance and whether costs are enabled at all.
 * @returns The balance text.
 */
function BalanceText({
  remaining,
  costsEnabled,
}: {
  /** Tokens left, or infinite when the league has costs switched off. */
  remaining: number;
  costsEnabled: boolean;
}) {
  if (!costsEnabled) {
    return <span className="text-slate-400">Costs are off for this league</span>;
  }

  return (
    <span>
      <span
        className={`font-semibold ${
          remaining < 0 ? "text-rose-300" : "text-slate-100"
        }`}
      >
        {remaining}
      </span>{" "}
      <span className="text-slate-400">tokens left</span>
    </span>
  );
}

/**
 * Props for the {@link PokemonPicker} component.
 */
interface PokemonPickerProps {
  /** The label above the list, e.g. "You send". */
  title: string;
  roster: TradePokemon[];
  selected: string[];
  onToggle: (pokemonId: string) => void;
  costsEnabled: boolean;
  /** Disables the whole picker, e.g. before a recipient is chosen. */
  disabled?: boolean;
}

/**
 * A searchable, multi-select list of roster Pokémon.
 *
 * Selection is a set of slugs rather than a checkbox grid so the parent can price
 * the trade on every toggle without the list owning any trade state.
 *
 * @param props - {@link PokemonPickerProps}
 * @returns The picker panel.
 */
function PokemonPicker({
  title,
  roster,
  selected,
  onToggle,
  costsEnabled,
  disabled = false,
}: PokemonPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return roster;
    }
    return roster.filter((row) =>
      `${row.name} ${row.species_name} ${row.pokemon_id} ${row.types.join(" ")}`
        .toLowerCase()
        .includes(query),
    );
  }, [roster, search]);

  const selectedTier = useMemo(
    () =>
      totalTierValue(roster.filter((row) => selected.includes(row.pokemon_id))),
    [roster, selected],
  );

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>
          {title}
        </SectionLabel>
        {costsEnabled && selected.length > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300">
            {selectedTier} tokens
          </span>
        )}
      </div>

      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Find Pokemon"
        aria-label={`Search the Pokemon to ${title.toLowerCase()}`}
        disabled={disabled}
        className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-400 disabled:opacity-50"
      />

      {roster.length === 0 ? (
        <p className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-500">
          No roster to choose from.
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No Pokémon match that search.</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {filtered.map((row) => {
            const isSelected = selected.includes(row.pokemon_id);

            return (
              <li key={row.pokemon_id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggle(row.pokemon_id)}
                  aria-pressed={isSelected}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    isSelected
                      ? "border-amber-500 bg-amber-500/10"
                      : "border-slate-800 bg-slate-950/40 hover:border-slate-600"
                  }`}
                >
                  <PokemonSprite spriteId={row.spriteId} name={row.name} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-100">
                      {row.name}
                    </span>
                    <TypeBadges types={row.types} />
                  </span>
                  {costsEnabled && (
                    <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                      {tierLabel(row.tier_value)}
                    </span>
                  )}
                  <span
                    aria-hidden="true"
                    className={`shrink-0 text-lg font-bold ${
                      isSelected ? "text-amber-400" : "text-slate-600"
                    }`}
                  >
                    {isSelected ? "−" : "+"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Props for the {@link TradeCard} component.
 */
interface TradeCardProps {
  trade: Trade;
  goods: TradesGoods;
  timeZone: string;
  busy: boolean;
  canVote: boolean;
  isOwner: boolean;
  onAction: (action: TradeAction, trade: Trade) => void;
  /**
   * When true, the card shows the trade but offers no controls.
   *
   * Set while a past season is on screen: the trade is history there, and an action
   * would be applied to the current season rather than the one being read.
   */
  readOnly?: boolean;
  /**
   * True once the season's trade deadline has passed. Accepting, approving, and
   * overriding are disabled; declining and withdrawing remain available so a
   * member can clear a stale card.
   */
  deadlinePassed?: boolean;
}

/**
 * Renders one trade: both sides' Pokémon, the state, the approval tally, and the
 * actions the reader is entitled to.
 *
 * Every control is shown only to the role that can use it, but the real gate is the
 * database -- each of these buttons calls an RPC that re-checks the caller's role and
 * the trade's status, so a stale card cannot cause an illegal mutation.
 *
 * @param props - {@link TradeCardProps}
 * @returns The trade card.
 */
function TradeCard({
  trade,
  goods,
  timeZone,
  busy,
  canVote,
  isOwner,
  onAction,
  readOnly = false,
  deadlinePassed = false,
}: TradeCardProps) {
  const labels = tradeSideLabels(trade, goods.currentUserId);
  const readerIsProposer = isProposer(trade, goods.currentUserId);
  const readerIsRecipient = isRecipient(trade, goods.currentUserId);
  const progress = approvalProgress(trade, goods.approverIds);

  const outgoing = trade.items.filter((item) => item.side === "proposer");
  const incoming = trade.items.filter((item) => item.side === "recipient");
  const costsEnabled = goods.settings?.enable_pokemon_costs === true;

  const showing = outgoing.length + incoming.length;

  /*
   * How each side's balance moves. Computed from the items on the card rather than
   * from the member's current teams, because a proposal can sit unanswered for a
   * while and by the time it is answered either side's balance may have moved; this
   * states what this trade itself is worth, which is what the card is about.
   */
  const shift = tradeValueShift(
    outgoing,
    incoming,
    costsEnabled,
    trade.proposerTokenAmount,
    trade.recipientTokenAmount,
  );

  /*
   * A trade can move tokens without moving a single Pokémon, so the card says so
   * in its own right. Without this a recipient asked to hand over 20 tokens would
   * see two empty side panels and a value line derived from nothing.
   */
  const proposerTokens = trade.proposerTokenAmount;
  const recipientTokens = trade.recipientTokenAmount;
  const movesTokens = proposerTokens > 0 || recipientTokens > 0;

  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg shadow-slate-950/30">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-white">
            {/*
              Each side wears its own colour, but the reader's own side stays the
              word "You" that `tradeSideLabels` resolved it to -- it is not a name
              and there is nothing to colour.
            */}
            {labels.proposer === "You" ? (
              "You"
            ) : (
              <MemberName
                name={labels.proposer}
                color={trade.proposer_name_color}
                fallback="Unnamed"
              />
            )}{" "}
            <span className="text-slate-500">↔</span>{" "}
            {labels.recipient === "You" ? (
              "You"
            ) : (
              <MemberName
                name={labels.recipient}
                color={trade.recipient_name_color}
                fallback="Unnamed"
              />
            )}
          </h3>
          <p className="mt-1 text-sm text-slate-400">
            Proposed {formatDateTimeInZone(trade.created_at, timeZone)}
            {trade.completed_at
              ? ` • Completed ${formatDateTimeInZone(trade.completed_at, timeZone)}`
              : ""}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            STATUS_STYLES[trade.status]
          }`}
        >
          {tradeStatusLabel(trade.status)}
        </span>
      </header>

      {showing === 0 ? (
        <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-500">
          This trade has no Pokémon on it.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {/*
            The verb has to agree with its subject. `tradeSideLabels` resolves the
            reader's own side to "You", and "You sends" is not English, so the
            heading is built from the two facts separately rather than by
            interpolating a label into a fixed word.
          */}
          <TradeSidePanel
            heading={
              readerIsProposer ? (
                "You send"
              ) : (
                <>
                  <MemberName
                    name={trade.proposer_name}
                    color={trade.proposer_name_color}
                    fallback="Unnamed"
                  />{" "}
                  sends
                </>
              )
            }
            items={outgoing}
            costsEnabled={costsEnabled}
            tokenAmount={proposerTokens}
          />
          <TradeSidePanel
            heading={
              readerIsRecipient ? (
                "You send"
              ) : (
                <>
                  <MemberName
                    name={trade.recipient_name}
                    color={trade.recipient_name_color}
                    fallback="Unnamed"
                  />{" "}
                  sends
                </>
              )
            }
            items={incoming}
            costsEnabled={costsEnabled}
            tokenAmount={recipientTokens}
          />
        </div>
      )}

      {/*
          Negated to read as a balance swing rather than an amount handed over,
          matching the "Value Exchanged" line below and complete_trade's ledger:
          sending tokens costs the sender budget and credits the receiver.
        */}
      {costsEnabled && movesTokens && (
        <p className="mt-4 text-sm text-slate-300">
          Tokens Exchanged:{" "}
          <ValueSwingText
            delta={-proposerTokens}
            name={trade.proposer_name}
            color={trade.proposer_name_color}
          />
          {" and "}
          <ValueSwingText
            delta={-recipientTokens}
            name={trade.recipient_name}
            color={trade.recipient_name_color}
          />
        </p>
      )}

      {costsEnabled && showing > 0 && (
        <p className="mt-4 text-sm text-slate-300">
          Value Exchanged:{" "}
          <ValueSwingText
            delta={shift.proposerDelta}
            name={trade.proposer_name}
            color={trade.proposer_name_color}
          />
          {" and "}
          <ValueSwingText
            delta={shift.recipientDelta}
            name={trade.recipient_name}
            color={trade.recipient_name_color}
          />
        </p>
      )}

      {/*
        The approval tally is only meaningful once a trade is actually waiting on a
        vote. Showing "0 of 1" on a proposal nobody has answered yet would be noise,
        and the denominator is the league's current approver set rather than whoever
        happened to be around when the trade was proposed.
      */}
      {trade.status === "pending_approval" && (
        <div className="mt-4 rounded-xl border border-violet-900 bg-violet-950/30 p-3 text-sm">
          <p className="font-semibold text-violet-200">
            {progress.approvals} of {progress.required} approval
            {progress.required === 1 ? "" : "s"} recorded
          </p>
          {/*
            Rejections are counted against the same quorum, so the count is shown on
            its own line with the target. Writing it inline next to the approvals as
            a bare total made one recorded rejection look like a settled trade.
          */}
          {progress.rejections > 0 && (
            <p
              className={`mt-1 ${
                progress.rejectionQuorumMet ? "text-rose-300" : "text-slate-300"
              }`}
            >
              {progress.rejections} of {progress.required} rejection
              {progress.required === 1 ? "" : "s"} recorded
              {progress.rejectionQuorumMet
                ? " • enough to reject"
                : " • not enough to reject yet"}
            </p>
          )}
          {trade.votes.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-slate-300">
              {trade.votes.map((vote) => (
                <li key={vote.voter_user_id}>
                  {/*
                    The voter is credited in their own colour, so the span exists
                    to carry the sentence as one run of text with the name able
                    to opt out of the surrounding slate.
                  */}
                  <span>
                    <MemberName
                      name={vote.voter_name}
                      color={vote.voter_name_color}
                      fallback="A member"
                    />{" "}
                    voted to{" "}
                    {vote.decision === "approved" ? "approve" : "reject"}
                    {vote.is_override && " (owner override)"} •{" "}
                    {formatDateTimeInZone(vote.created_at, timeZone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/*
        The recipient cannot answer their own proposal, and the proposer cannot
        answer theirs, so each control appears only where it does something. The
        "Clear" control is the spec's action on a settled or refused card.
      */}
      {!readOnly && (
      <footer className="mt-5 flex flex-wrap gap-2 border-t border-slate-800 pt-4">
        {readerIsRecipient && trade.status === "awaiting_response" && (
          <>
            <Button
              type="button"
              disabled={busy || deadlinePassed}
              onClick={() => onAction("accept", trade)}
              variant="primary"
            >
              Accept
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => onAction("decline", trade)}
              variant="danger-outline"
            >
              Decline
            </Button>
          </>
        )}

        {readerIsProposer && trade.status === "awaiting_response" && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => onAction("withdraw", trade)}
            variant="secondary"
          >
            Withdraw
          </Button>
        )}

        {canVote && trade.status === "pending_approval" && (
          <>
            <Button
              type="button"
              disabled={busy || deadlinePassed}
              onClick={() => onAction("approve", trade)}
              variant="primary"
            >
              Approve
            </Button>
            {isOwner && (
              <Button
                type="button"
                disabled={busy || deadlinePassed}
                onClick={() => onAction("override", trade)}
                variant="warning"
              >
                Approve (Override)
              </Button>
            )}
            <Button
              type="button"
              disabled={busy}
              onClick={() => onAction("reject", trade)}
              variant="danger-outline"
            >
              Reject
            </Button>
            {/*
              Rejecting is a vote like any other, so a single one no longer settles
              the trade -- it needs the same quorum an approval does. The Owner keeps
              an immediate path, split out from the ordinary Reject so a rejection
              that is only a vote is never mistaken for one that ends the trade.
            */}
            {isOwner && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => onAction("reject-override", trade)}
                variant="danger"
              >
                Reject (Override)
              </Button>
            )}
          </>
        )}

        {!isTradeOpen(trade.status) && (readerIsProposer || readerIsRecipient) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("clear", trade)}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </footer>
      )}
    </article>
  );
}

/**
 * Props for the {@link ValueSwingText} component.
 */
interface ValueSwingTextProps {
  /** The signed change in this side's token balance. */
  delta: number;
  name: string;
  /** The member's chosen display colour, or null when they have not picked one. */
  color?: string | null;
}

/**
 * Renders one side's share of a trade's value, e.g. `+1 Token for Khawly`.
 *
 * Stated as a change to a named player's balance rather than as "N better for
 * someone", because the thing a member needs to know is which direction their own
 * balance moves and by how much. The name is the real display name even for a
 * member reading their own card, so the line reads identically to an owner judging
 * the trade on the Approvals tab.
 *
 * The attributed name is rendered through `MemberName`, so it carries the member's
 * chosen colour while the surrounding "for" and the signed figure stay in the
 * parent's slate.
 *
 * @param props - {@link ValueSwingTextProps}
 * @returns The formatted share.
 */
function ValueSwingText({ delta, name, color }: ValueSwingTextProps) {
  const tone =
    delta > 0
      ? "font-semibold text-emerald-300"
      : delta < 0
        ? "font-semibold text-rose-300"
        : "font-semibold text-slate-400";

  return (
    <>
      <span className={tone}>{formatTokenSwing(delta)}</span> for{" "}
      <MemberName name={name} color={color} fallback="Unnamed" />
    </>
  );
}

/**
 * Props for the {@link TradeSidePanel} component.
 */
interface TradeSidePanelProps {
  /**
   * The column heading, naming whose Pokémon these are.
   *
   * A node rather than a string so the name inside it can be a `MemberName` and
   * carry the owner's colour; the surrounding "sends" is ordinary text.
   */
  heading: ReactNode;
  items: TradeItem[];
  costsEnabled: boolean;
  /** Tokens this side is sending. Zero for none. */
  tokenAmount: number;
}

/**
 * Renders one side of a trade: the Pokémon it sends, and the tokens it attaches.
 *
 * The tokens are listed alongside the Pokémon rather than only in the exchange
 * summary below, because this is the panel a member reads to answer "what am I
 * giving up?" and an amount of tokens is part of that answer.
 *
 * @param props - {@link TradeSidePanelProps}
 * @returns The list panel.
 */
function TradeSidePanel({
  heading,
  items,
  costsEnabled,
  tokenAmount,
}: TradeSidePanelProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
        {heading}
      </p>
      {costsEnabled && tokenAmount > 0 && (
        <p className="mt-2 rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm font-semibold text-emerald-200">
          {tokenAmount} {tokenAmount === 1 ? "token" : "tokens"}
        </p>
      )}
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          {costsEnabled && tokenAmount > 0 ? "No Pokémon" : "Nothing"}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((item) => (
            <li key={item.pokemon_id} className="flex items-center gap-3">
              <PokemonSprite spriteId={item.spriteId} name={item.name} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-100">
                  {item.name}
                </span>
                <TypeBadges types={item.types} />
              </span>
              {costsEnabled && (
                <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300">
                  {tierLabel(item.tier_value)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Props for the {@link BalanceBreakdown} component. */
interface BalanceBreakdownProps {
  label: string;
  /**
   * The label member's chosen display colour, or null when they have not picked
   * one. Omitted for the reader's own column, whose label is "You".
   */
  color?: string | null;
  /** Tokens the member holds before the trade settles. */
  current: number;
  delta: number;
  /** Tokens the member holds once the trade settles. */
  projected: number;
  costsEnabled: boolean;
  /**
   * Whether anything is actually on the table. With nothing selected the delta is
   * always zero, so the middle row is dropped rather than shown as a flat "+0".
   */
  hasValue: boolean;
}

/**
 * One member's side of the projection: where they are now, what the trade moves,
 * and where they land.
 *
 * The three figures sit together because the middle one only means something beside
 * its endpoints. "+6 tokens" tells a member nothing until they can see it sitting on
 * the balance it moves, and the panel used to lead with the post-trade figure alone,
 * so a trade that cost someone 40 tokens read as a modest change in a number they
 * had no anchor for.
 *
 * The heading names the member and, when they have picked one, wears their colour.
 *
 * @param props - {@link BalanceBreakdownProps}
 * @returns The three-row balance breakdown for one member.
 */
function BalanceBreakdown({
  label,
  color,
  current,
  delta,
  projected,
  costsEnabled,
  hasValue,
}: BalanceBreakdownProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">
      <p className="text-slate-400">
        <MemberName name={label} color={color} fallback="Unnamed" />
      </p>

      {!costsEnabled ? (
        <p className="mt-1 text-slate-400">Costs are off for this league</p>
      ) : (
        <dl className="mt-2 space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-slate-500">Current balance</dt>
            <dd className="font-semibold text-slate-100">
              {current}
              <span className="ml-1 font-normal text-slate-400">tokens</span>
            </dd>
          </div>

          {hasValue && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-slate-500">
                {delta >= 0 ? "Tokens gained" : "Tokens lost"}
              </dt>
              <dd
                className={`font-semibold ${
                  delta >= 0 ? "text-emerald-300" : "text-rose-300"
                }`}
              >
                {delta >= 0 ? "+" : ""}
                {delta}
              </dd>
            </div>
          )}

          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-slate-500">Projected balance</dt>
            <dd
              className={`font-semibold ${
                projected < 0 ? "text-rose-300" : "text-slate-100"
              }`}
            >
              {projected}
              <span className="ml-1 font-normal text-slate-400">tokens</span>
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

/**
 * Props for the {@link ProposalBuilder} component.
 */
interface ProposalBuilderProps {
  goods: TradesGoods;
  busy: boolean;
  onSubmit: (
    recipientUserId: string,
    offer: string[],
    request: string[],
    proposerTokens: number,
    recipientTokens: number,
  ) => void;
}

/**
 * The proposal form: choose a member, then choose what goes each way.
 *
 * Both sides' projected balances are shown live as the selection changes, because
 * the spec asks the UI to update them and because a member about to give up a tier 8
 * deserves to see that before sending rather than after. The Submit control stays
 * disabled until there is at least one Pokémon moving and the exchange is one both
 * sides can afford.
 *
 * @param props - {@link ProposalBuilderProps}
 * @returns The proposal form.
 */
function ProposalBuilder({
  goods,
  busy,
  onSubmit,
}: ProposalBuilderProps) {
  const [recipientId, setRecipientId] = useState<string>("");
  const [offer, setOffer] = useState<string[]>([]);
  const [request, setRequest] = useState<string[]>([]);
  /*
   * Token amounts are held as strings because a number input's value is a string
   * until it is parsed, and parsing on every keystroke would fight the member: an
   * empty box is NaN, and treating that as 0 while they type "12" one digit at a
   * time makes the projection jump. Clamped to a non-negative integer when read,
   * which is also the only shape propose_trade accepts.
   */
  const [proposerTokensRaw, setProposerTokensRaw] = useState<string>("");
  const [recipientTokensRaw, setRecipientTokensRaw] = useState<string>("");

  /** Parses a token field into the non-negative integer the RPC expects. */
  const proposerTokens = parseTokenAmount(proposerTokensRaw);
  const recipientTokens = parseTokenAmount(recipientTokensRaw);

  const opponents = useMemo(
    () => tradeOpponents(goods.teams, goods.currentUserId),
    [goods.teams, goods.currentUserId],
  );

  /*
   * `recipientId` is the member's *user* id, which is what the select stores and what
   * propose_trade takes. Resolving it through findTeamByOwner keeps that mapping in
   * one place; matching it against `team.id` here instead would silently find nothing,
   * and the receive-side picker would render empty with no error anywhere.
   */
  const recipient = useMemo(
    () => findTeamByOwner(opponents, recipientId),
    [opponents, recipientId],
  );

  /*
   * Changing who is being traded with has to clear the request side, because those
   * slugs were chosen from the previous member's roster and proposing them again
   * would be refused. Keeping them would also mis-price the projection, since the
   * tiers belong to a roster that is no longer on the other end of the trade.
   */
  function handleRecipientChange(nextId: string) {
    setRecipientId(nextId);
    setRequest([]);
  }

  const toggle = (
    list: string[],
    setList: (next: string[]) => void,
  ): ((pokemonId: string) => void) => {
    return (pokemonId) => {
      setList(
        list.includes(pokemonId)
          ? list.filter((id) => id !== pokemonId)
          : [...list, pokemonId],
      );
    };
  };

  const offerPokemon = useMemo(
    () => goods.myTeam?.roster.filter((row) => offer.includes(row.pokemon_id)) ?? [],
    [goods.myTeam, offer],
  );
  const requestPokemon = useMemo(
    () => recipient?.roster.filter((row) => request.includes(row.pokemon_id)) ?? [],
    [recipient, request],
  );

  const projection =
    goods.myTeam && recipient
      ? projectTradeBalance(
          goods,
          goods.myTeam.id,
          recipient.id,
          offerPokemon,
          requestPokemon,
          proposerTokens,
          recipientTokens,
        )
      : null;

  const costsEnabled = goods.settings?.enable_pokemon_costs === true;
  /*
   * Tokens are opt-in on two levels, matching what the server accepts: the league
   * has to have costs running for a token amount to mean anything, and the owner
   * has to have enabled token trades. Either being off hides the inputs entirely,
   * so a member is never offered a field that would be refused on submit.
   */
  const tokenTradesAllowed =
    costsEnabled && goods.settings?.allow_token_trades === true;
  const nothingSelected =
    offer.length + request.length === 0 &&
    !(tokenTradesAllowed && (proposerTokens > 0 || recipientTokens > 0));
  const blocked = busy || nothingSelected || !goods.myTeam || !recipient;
  const canSubmit = !blocked && (projection?.affordable ?? false);
  const hasValue =
    offer.length + request.length > 0 || proposerTokens > 0 || recipientTokens > 0;

  if (!goods.myTeam) {
    return (
      <Card className="p-6">
        <p className="text-sm text-slate-400">
          You do not own a team in this season, so you cannot propose a trade.
        </p>
      </Card>
    );
  }

  if (goods.season?.status !== "draft_complete") {
    return (
      <Card className="p-6">
        <p className="text-sm text-slate-400">
          Trades unlock once the draft is complete. This season is still{" "}
          {goods.season?.status === "draft_active" ? "drafting" : "waiting to draft"}.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card className="p-4 shadow-lg sm:p-6 shadow-slate-950/30">
        <label className="block">
          <span className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            Trade with
          </span>
          <select
            value={recipientId}
            onChange={(event) => handleRecipientChange(event.target.value)}
            className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-amber-400 sm:max-w-sm"
          >
            <option value="">Choose a member</option>
            {opponents.map((team) => (
              <option key={team.id} value={team.owner_user_id}>
                {/*
                  Deliberately plain text. An <option> may only hold text, so a
                  MemberName span here would be invalid and would not render the
                  colour anyway. The same member's name is coloured on the balance
                  breakdown below as soon as they are chosen.
                */}
                {team.owner_name?.trim() || team.team_name}
              </option>
            ))}
          </select>
        </label>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <PokemonPicker
          title="You send"
          roster={goods.myTeam.roster}
          selected={offer}
          onToggle={toggle(offer, setOffer)}
          costsEnabled={costsEnabled}
        />
        <PokemonPicker
          title="You receive"
          roster={recipient?.roster ?? []}
          selected={request}
          onToggle={toggle(request, setRequest)}
          costsEnabled={costsEnabled}
          disabled={!recipient}
        />
      </div>
      {tokenTradesAllowed && (
        <Card className="p-4 shadow-lg sm:p-6 shadow-slate-950/30">
          <SectionLabel>
            Tokens
          </SectionLabel>
          <p className="mt-1 text-sm text-slate-400">
            Tokens you send come out of your budget; tokens you receive go onto
            theirs. Leave both blank to trade Pokémon only.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <TokenAmountField
              label="You send"
              value={proposerTokensRaw}
              disabled={busy}
              onChange={setProposerTokensRaw}
            />
            <TokenAmountField
              label="You receive"
              value={recipientTokensRaw}
              disabled={busy || !recipient}
              onChange={setRecipientTokensRaw}
            />
          </div>
        </Card>
      )}

      <Card className="p-4 shadow-lg sm:p-6 shadow-slate-950/30">
        <SectionLabel>
          Projected balances
        </SectionLabel>

        {!recipient ? (
          <p className="mt-3 text-sm text-slate-500">
            Choose a member to see what this trade would do for both of you.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <BalanceBreakdown
              label="You"
              current={projection?.proposerCurrent ?? 0}
              delta={projection?.proposerDelta ?? 0}
              projected={projection?.proposerRemaining ?? 0}
              costsEnabled={costsEnabled}
              hasValue={hasValue}
            />
            <BalanceBreakdown
              label={recipient.owner_name?.trim() || recipient.team_name}
              color={recipient.owner_name_color}
              current={projection?.recipientCurrent ?? 0}
              delta={projection?.recipientDelta ?? 0}
              projected={projection?.recipientRemaining ?? 0}
              costsEnabled={costsEnabled}
              hasValue={hasValue}
            />
          </div>
        )}

        {projection && !projection.affordable && (
          <p className="mt-3 rounded-xl border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">
            This trade would leave a team below 0 tokens, so it cannot be sent.
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit(recipientId, offer, request, proposerTokens, recipientTokens)
            }
            className="rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Sending..." : "Send proposal"}
          </button>
          {(offer.length > 0 || request.length > 0 || proposerTokens > 0 || recipientTokens > 0) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOffer([]);
                setRequest([]);
                setProposerTokensRaw("");
                setRecipientTokensRaw("");
              }}
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:border-slate-500 disabled:opacity-50"
            >
              Reset
            </button>
          )}
          {nothingSelected && (
            <span className="text-sm text-slate-500">
              Choose at least one Pokémon or some tokens to send.
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}

/**
 * One optional token amount in a proposal.
 *
 * Held as a raw string so a partially typed or cleared box never resolves to NaN in
 * the balance projection. `type="number"` gives the stepper and numeric keypad for
 * free while the parent does the parsing, so the field itself has no opinion about
 * what counts as a legal amount.
 *
 * @param props.label - Which side of the trade the amount belongs to.
 * @param props.value - The raw field contents.
 * @param props.disabled - True while the proposal is submitting or unusable.
 * @param props.onChange - Receives the raw field contents on every keystroke.
 * @returns The labelled number input.
 */
function TokenAmountField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
        {label}
      </span>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value}
          disabled={disabled}
          placeholder="0"
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="shrink-0 text-sm text-slate-500">tokens</span>
      </div>
    </label>
  );
}

/** Props for the {@link TradeList} component. */
interface TradeListProps {
  trades: Trade[];
  emptyMessage: string;
  goods: TradesGoods;
  timeZone: string;
  busyTradeId: string | null;
  onAction: (action: TradeAction, trade: Trade) => void;
  deadlinePassed: boolean;
  allowVoting: boolean;
}

/**
 * Renders one tab's trades, or its empty state.
 *
 * The three trade tabs differ only in which list they show, so they share this
 * component. The vote rule is applied once here rather than at each call site,
 * which is what keeps a member's own pending trade on "My Trades" offering the
 * same controls it would on "Approvals".
 *
 * @param props - {@link TradeListProps}
 * @returns The list of cards, or the empty-state message.
 */
function TradeList({
  trades,
  emptyMessage,
  goods,
  timeZone,
  busyTradeId,
  onAction,
  deadlinePassed,
  allowVoting,
}: TradeListProps) {
  if (trades.length === 0) {
    return (
      <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
        {emptyMessage}
      </p>
    );
  }

  return (
    <section className="space-y-4">
      {trades.map((trade) => (
        <TradeCard
          key={trade.id}
          trade={trade}
          goods={goods}
          timeZone={timeZone}
          busy={busyTradeId === trade.id}
          canVote={allowVoting && canVoteOnTrade(trade, goods.canApprove)}
          isOwner={allowVoting && goods.userRole === "owner"}
          onAction={onAction}
          readOnly={!goods.isCurrentSeason}
          deadlinePassed={deadlinePassed}
        />
      ))}
    </section>
  );
}

/**
 * The interactive trades page content.
 *
 * @returns The trade centre.
 */
function TradesPageContent() {
  const { confirm, confirmDialog } = useConfirm();
  /** Every timestamp on the page renders in the zone the member picked in settings. */
  const timeZone = useUserTimeZone();
  const shellLeague = useShellLeague();

  const {
    data: goods,
    isLoading,
    error,
    setError,
    reload,
  } = useLeaguePageData({
    ...shellLeague,
    load: (leagueId) =>
      loadTradesPageData(leagueId, getSelectedSeason(leagueId)),
    emptyLeagueMessage: "Select a league before opening the trade centre.",
    fallbackErrorMessage: "The trade centre could not be loaded.",
  });

  const [feedback, setFeedback] = useState<string | null>(null);
  const [busyTradeId, setBusyTradeId] = useState<string | null>(null);
  const [tab, setTab] = useState<TradesTab>("new");

  /*
   * A refetch replaces the page's data, which would wipe a half-built proposal off
   * the screen. Pausing while the New Trade tab has a draft on it holds the event
   * instead of dropping it; `flush` applies it when the member moves to another tab.
   */
  const { flush } = useRealtimeInvalidation({
    leagueId: goods?.league.id ?? null,
    watchers: [{ table: "trades", onChange: () => void reload() }],
    isPaused: () => tab === "new",
  });

  /**
   * Switches tabs.
   *
   * Only the tab choice and the deferred-realtime flush happen here. The bubbles on
   * the strip are derived from the trades themselves rather than from unread
   * notifications, so opening a tab deliberately does not clear them: a trade the
   * member still has to answer is still unanswered, and the bubble has to keep
   * saying so until they actually answer it.
   *
   * @param next - The tab to open.
   */
  function handleTabChange(next: TradesTab) {
    setTab(next);

    // A change held while the proposal form was on screen is applied now, rather
    // than waiting for the next event to arrive.
    flush();
  }

  const mySalary = useMemo(
    () => (goods?.myTeam ? getTeamSalary(goods, goods.myTeam.id) : null),
    [goods],
  );

  /*
   * The tab lists and the strip are produced together so a tab's bubble cannot
   * disagree with the rows it sits above. "My Trades" drops whatever the member
   * has cleared for themselves; a dismissal is per member, so the other party
   * still has the card, and history keeps every completed trade because clearing
   * one is not a way of erasing it. See `buildTradesView` for the grouping rules.
   */
  const { myTrades, pendingApprovals, history, tabs } = useMemo(
    () => buildTradesView(goods),
    [goods],
  );

  const requiresApproval = goods?.settings?.admins_approve_trades === true;
  const tradeDeadlinePassed = isDeadlinePassed(
    goods?.settings?.trade_deadline_at,
  );
  const approverTotal = goods?.approverIds.length ?? 0;
  const approverRequired = requiredApprovals(approverTotal);

  /**
   * Runs one action on a trade, behind a confirmation.
   *
   * Every action that changes a roster, a status, or the member's own list is
   * confirmed and irreversible from their side of it, so each gets the shared
   * dialog. Rejections and withdrawals that only clear something off the reader's
   * own screen are confirmed too: the copy names what is lost, and `tone: "danger"`
   * marks the ones that cannot be taken back.
   *
   * @param action - Which action to run.
   * @param trade - The trade it applies to.
   */
  async function handleAction(action: TradeAction, trade: Trade) {
    if (!goods) {
      return;
    }

    if (
      tradeDeadlinePassed &&
      (action === "accept" || action === "approve" || action === "override")
    ) {
      setError("The trade deadline has passed. Trading is closed.");
      return;
    }

    const labels = tradeSideLabels(trade, goods.currentUserId);
    /*
     * The counterparty's name stays plain text in everything from here on: the
     * confirm dialog takes strings and the outcome banner is set as a string, so
     * neither can hold an element to colour. The card this dialog was raised from
     * shows the same name in its chosen colour.
     */
    const other = labels.other;

    const prompt = tradeActionPrompt(action, {
      other,
      proposer: labels.proposer,
      recipient: labels.recipient,
      requiresApproval,
      approverRequired,
    });

    const confirmed = await confirm(prompt);

    if (!confirmed) {
      return;
    }

    setBusyTradeId(trade.id);
    setError(null);
    setFeedback(null);

    try {
      switch (action) {
        case "accept": {
          const status = await respondToTrade(trade.id, true);
          setFeedback(
            status === "completed"
              ? `Trade with ${other} completed. The Pokémon have changed rosters.`
              : `Trade with ${other} accepted and sent for approval.`,
          );
          break;
        }
        case "decline": {
          await respondToTrade(trade.id, false);
          setFeedback(`Trade with ${other} declined.`);
          break;
        }
        case "withdraw": {
          await cancelTrade(trade.id);
          setFeedback(`Proposal to ${other} withdrawn.`);
          break;
        }
        case "approve":
        case "override": {
          const status = await voteOnTrade(trade.id, true, action === "override");
          setFeedback(
            status === "completed"
              ? `Trade between ${trade.proposer_name} and ${trade.recipient_name} completed.`
              : "Your approval has been recorded.",
          );
          break;
        }
        case "reject":
        case "reject-override": {
          /*
           * The returned status is the difference between a vote that was recorded
           * and a trade that was actually settled. Reading it is the whole point: a
           * rejection below the quorum leaves the trade pending, and telling the
           * approver it was rejected is what made the old single-rejection rule feel
           * like a veto.
           */
          const status = await voteOnTrade(
            trade.id,
            false,
            action === "reject-override",
          );
          setFeedback(
            status === "rejected"
              ? `Trade between ${trade.proposer_name} and ${trade.recipient_name} rejected. Both members have been told.`
              : `Your rejection has been recorded. ${approverRequired} rejection${
                  approverRequired === 1 ? "" : "s"
                } are needed to reject this trade.`,
          );
          break;
        }
        case "clear": {
          await dismissTrade(trade.id);
          setFeedback("Trade cleared from your list.");
          break;
        }
      }

      await reload();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "That action could not be completed.",
      );
    } finally {
      setBusyTradeId(null);
    }
  }

  /**
   * Submits the proposal built by the form.
   *
   * @param recipientUserId - The member being asked.
   * @param offer - Pokémon slugs the proposer sends.
   * @param request - Pokémon slugs the proposer wants to receive.
   */
  async function handlePropose(
    recipientUserId: string,
    offer: string[],
    request: string[],
    proposerTokens: number,
    recipientTokens: number,
  ) {
    if (!goods) {
      return;
    }

    if (tradeDeadlinePassed) {
      setError("The trade deadline has passed. Trading is closed.");
      return;
    }

    const recipient = findTeamByOwner(goods.teams, recipientUserId);
    const other = recipient?.owner_name?.trim() || recipient?.team_name || "them";

    const confirmed = await confirm({
      title: "Send this proposal?",
      detail: `${other} will be asked to accept or decline it. You can withdraw it until they answer.`,
      confirmLabel: "Send proposal",
    });

    if (!confirmed) {
      return;
    }

    setError(null);
    setFeedback(null);

    try {
      await proposeTrade(
        goods.league.id,
        recipientUserId,
        offer,
        request,
        proposerTokens,
        recipientTokens,
      );
      await reload();
      setFeedback(`Proposal sent to ${other}.`);
      // Routed through the tab handler rather than setTab directly, so arriving at
      // My Trades clears the badge exactly as clicking it would.
      await handleTabChange("mine");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "That trade could not be sent.",
      );
    }
  }

  if (isLoading && !goods) {
    return <PageShellLoading label="Loading trades" />;
  }

  if (error && !goods) {
    return <PageShellError>{error}</PageShellError>;
  }

  if (!goods) {
    return null;
  }

  return (
    <PageShell>
      <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-2xl sm:p-6 shadow-slate-950/40">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-3xl font-bold text-white">{goods.league.name}</h2>
              <p className="mt-1 text-sm text-slate-400">
                {formatSeasonLabel(goods.season)} • Trades
              </p>
            </div>

            <div className="rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
              {goods.myTeam ? (
                <p>
                  Team:{" "}
                  <span className="font-medium text-slate-100">
                    {/*
                      The team name is the fallback here, not "Unnamed", so a member
                      whose profile has no display name is still labelled by the
                      snapshot the league drafted them under.
                    */}
                    <MemberName
                      name={goods.myTeam.owner_name}
                      color={goods.myTeam.owner_name_color}
                      fallback={goods.myTeam.team_name}
                    />
                  </span>
                </p>
              ) : (
                <p>You are not on a team this season.</p>
              )}
              {mySalary && (
                <p className="mt-1">
                  <BalanceText
                    remaining={mySalary.remaining}
                    costsEnabled={goods.settings?.enable_pokemon_costs === true}
                  />
                </p>
              )}
            </div>
          </div>

          {/*
            What happens after an acceptance is stated up front rather than
            discovered afterwards. A member who accepts a trade expecting it to
            happen immediately, in a league that requires approval, has been misled
            by the absence of this line.
          */}
          <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
            {requiresApproval
              ? goods.settings?.owners_admins_vote_on_trades
                ? `Accepted trades need ${approverRequired} of ${approverTotal} approvals from the owner and admins.`
                : "Accepted trades need the league owner to approve them."
              : "Accepted trades complete immediately — this league does not require approval."}
          </p>

          {goods.settings?.trade_deadline_at && (
            <p
              className={`mt-3 rounded-xl border px-4 py-3 text-sm ${
                tradeDeadlinePassed
                  ? "border-rose-800 bg-rose-950/40 text-rose-200"
                  : "border-amber-800 bg-amber-950/40 text-amber-200"
              }`}
            >
              {tradeDeadlinePassed ? (
                <>
                  The trade deadline passed on{" "}
                  {formatDateTimeInZone(
                    goods.settings.trade_deadline_at,
                    timeZone,
                  )}
                  . Trades can no longer be proposed, accepted, or approved.
                </>
              ) : (
                <>
                  Trades close on{" "}
                  {formatDateTimeInZone(
                    goods.settings.trade_deadline_at,
                    timeZone,
                  )}
                  .
                </>
              )}
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-700 pt-4">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => void handleTabChange(entry.id)}
                className={`relative rounded-full px-3.5 py-2 text-sm font-medium transition ${
                  tab === entry.id
                    ? "bg-amber-500 text-slate-950"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {entry.label}

                {/*
                  The app-wide convention for a number on a nav entry: the red
                  bubble when something is waiting on the member, a quiet count when
                  the tab merely has contents. Both counts are supplied per tab above
                  so no page has to choose a treatment by hand.
                */}
                <TabNotification
                  badge={entry.badge}
                  total={entry.total}
                  subject={entry.subject}
                />
            </button>
          ))}
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Times shown in {formatTimeZoneLabel(timeZone)}.
          </p>
        </header>

        {feedback && (
          <div className="rounded-2xl border border-emerald-700 bg-emerald-950/40 p-4 text-sm text-emerald-200">
            {feedback}
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {tab === "new" && goods.isCurrentSeason && !tradeDeadlinePassed && (
          <ProposalBuilder
            goods={goods}
            busy={Boolean(busyTradeId)}
            onSubmit={handlePropose}
          />
        )}

        {tab === "new" && goods.isCurrentSeason && tradeDeadlinePassed && (
          <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
            The trade deadline has passed, so no new proposals can be sent.
          </p>
        )}

        {tab === "new" && !goods.isCurrentSeason && (
          <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
            This is a past season, so its trades are read-only. Switch to the
            current season from the dashboard to propose a trade.
          </p>
        )}

        {tab !== "new" && (
          <TradeList
            trades={
              tab === "mine"
                ? myTrades
                : tab === "approvals"
                  ? pendingApprovals
                  : history
            }
            emptyMessage={
              tab === "mine"
                ? "You have no trades yet. Send a proposal from the New Trade tab."
                : tab === "approvals"
                  ? "No trades are waiting on approval."
                  : "No trades have completed in this season yet."
            }
            goods={goods}
            timeZone={timeZone}
            busyTradeId={busyTradeId}
            onAction={handleAction}
            deadlinePassed={tradeDeadlinePassed}
            // History is a record, so its cards offer no vote or override.
            allowVoting={tab !== "history"}
          />
        )}

      {confirmDialog}
    </PageShell>
  );
}
