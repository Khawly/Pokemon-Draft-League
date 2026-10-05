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
 */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getSpriteUrl } from "@/lib/pokeapi";
import { useConfirm } from "@/components/confirm-dialog";
import { NavAlertBadge, TabNotification } from "@/components/nav-alert-badge";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { formatDateTimeInZone, formatTimeZoneLabel } from "@/lib/datetime";
import { useUserTimeZone } from "@/lib/user-timezone";
import { useRealtimeInvalidation } from "@/lib/use-realtime-invalidation";
import {
  approvalProgress,
  cancelTrade,
  canVoteOnTrade,
  countOpenTrades,
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

/** LocalStorage key used by the top nav to persist the selected league. */
const SELECTED_LEAGUE_STORAGE_KEY = "pokemon-draft-league:selected-league";

/** The four views the page offers. */
type TradesTab = "new" | "mine" | "approvals" | "history";

/** Type badge colors keyed by normalized type name (matches the Pokemon page). */
const TYPE_STYLES: Record<string, string> = {
  normal: "bg-slate-600 text-slate-100",
  fire: "bg-red-600 text-slate-50",
  water: "bg-blue-600 text-slate-50",
  electric: "bg-yellow-500 text-slate-900",
  grass: "bg-green-600 text-slate-50",
  ice: "bg-cyan-500 text-slate-900",
  fighting: "bg-orange-700 text-slate-50",
  poison: "bg-purple-600 text-slate-50",
  ground: "bg-amber-700 text-slate-50",
  flying: "bg-sky-500 text-slate-50",
  psychic: "bg-pink-600 text-slate-50",
  bug: "bg-lime-600 text-slate-50",
  rock: "bg-stone-600 text-slate-50",
  ghost: "bg-indigo-700 text-slate-50",
  dragon: "bg-violet-700 text-slate-50",
  dark: "bg-neutral-800 text-slate-100",
  steel: "bg-slate-500 text-slate-50",
  fairy: "bg-pink-400 text-slate-900",
};

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
 * Wraps the trades page in a Suspense boundary to satisfy Next.js's client-side
 * streaming requirement for `useSearchParams`.
 *
 * @returns The trades page with a loading fallback.
 */
export default function TradesPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading trades...
          </div>
        </main>
      }
    >
      <TradesPageRoute />
    </Suspense>
  );
}

/**
 * Bridge component that reads the search params inside the Suspense boundary.
 *
 * @returns The trades page content.
 */
function TradesPageRoute() {
  const searchParams = useSearchParams();
  return <TradesPageContent searchParams={searchParams} />;
}

/**
 * Renders a species sprite, or a placeholder when the id is unknown.
 *
 * @param props - Sprite id, alt text, and pixel size.
 * @returns The image or placeholder element.
 */
function Sprite({
  spriteId,
  name,
  size = 32,
}: {
  /** Sprite id used to build the sprite URL. */
  spriteId: number;
  /** Alt text for the image. */
  name: string;
  /** Square pixel dimensions. */
  size?: number;
}) {
  if (spriteId <= 0) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs text-slate-500"
      >
        ?
      </div>
    );
  }

  return (
    <img
      src={getSpriteUrl(spriteId)}
      alt={name}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size }}
      className="shrink-0 object-contain"
    />
  );
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
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize ${
            TYPE_STYLES[type.toLowerCase()] ?? "bg-slate-700 text-slate-200"
          }`}
        >
          {type}
        </span>
      ))}
    </span>
  );
}

/**
 * Renders a tier value. There is no upper bound, so any positive tier reads as
 * "Tier N" and an untiered Pokémon reads as unranked rather than as tier zero.
 *
 * @param tier - The tier integer.
 * @returns The display label.
 */
function tierLabel(tier: number): string {
  return tier === 0 ? "Unranked" : `Tier ${tier}`;
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
  /** Whether the league charges for Pokémon at all. */
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
  /** The roster to choose from. */
  roster: TradePokemon[];
  /** Slugs currently chosen. */
  selected: string[];
  /** Adds or removes a slug. */
  onToggle: (pokemonId: string) => void;
  /** True when the league charges for Pokémon, which the tier column needs. */
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
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
          {title}
        </p>
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
                  <Sprite spriteId={row.spriteId} name={row.name} size={28} />
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
  /** The trade to render. */
  trade: Trade;
  /** The loaded page state, for names, approvers, and balances. */
  goods: TradesGoods;
  /** The reader's time zone, for every timestamp on the card. */
  timeZone: string;
  /** True while an action on this card is in flight. */
  busy: boolean;
  /** True when the reader can vote on this trade. */
  canVote: boolean;
  /** True when the reader is the league owner, who may override a vote. */
  isOwner: boolean;
  /** Runs the named action, which the card gates by role. */
  onAction: (action: TradeAction, trade: Trade) => void;
}

/** The actions a {@link TradeCard} can offer. */
type TradeAction = "accept" | "decline" | "withdraw" | "approve" | "reject" | "override" | "clear";

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
            {labels.proposer} <span className="text-slate-500">↔</span>{" "}
            {labels.recipient}
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
              readerIsProposer
                ? "You send"
                : `${trade.proposer_name} sends`
            }
            items={outgoing}
            costsEnabled={costsEnabled}
            tokenAmount={proposerTokens}
          />
          <TradeSidePanel
            heading={
              readerIsRecipient
                ? "You send"
                : `${trade.recipient_name} sends`
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
          <ValueSwingText delta={-proposerTokens} name={trade.proposer_name} />
          {" and "}
          <ValueSwingText delta={-recipientTokens} name={trade.recipient_name} />
        </p>
      )}

      {costsEnabled && showing > 0 && (
        <p className="mt-4 text-sm text-slate-300">
          Value Exchanged:{" "}
          <ValueSwingText delta={shift.proposerDelta} name={trade.proposer_name} />
          {" and "}
          <ValueSwingText
            delta={shift.recipientDelta}
            name={trade.recipient_name}
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
            {progress.rejections > 0 && (
              <span className="ml-2 text-rose-300">
                • {progress.rejections} rejection
                {progress.rejections === 1 ? "" : "s"}
              </span>
            )}
          </p>
          {trade.votes.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-slate-300">
              {trade.votes.map((vote) => (
                <li key={vote.voter_user_id}>
                  {vote.voter_name ?? "A member"} voted to{" "}
                  {vote.decision === "approved" ? "approve" : "reject"}
                  {vote.is_override && " (owner override)"} •{" "}
                  {formatDateTimeInZone(vote.created_at, timeZone)}
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
      <footer className="mt-5 flex flex-wrap gap-2 border-t border-slate-800 pt-4">
        {readerIsRecipient && trade.status === "awaiting_response" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("accept", trade)}
              className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("decline", trade)}
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-rose-800 hover:text-rose-200 disabled:opacity-50"
            >
              Decline
            </button>
          </>
        )}

        {readerIsProposer && trade.status === "awaiting_response" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("withdraw", trade)}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 disabled:opacity-50"
          >
            Withdraw
          </button>
        )}

        {canVote && trade.status === "pending_approval" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("approve", trade)}
              className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
            >
              Approve
            </button>
            {isOwner && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction("override", trade)}
                className="rounded-xl border border-amber-700 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
              >
                Approve (Override)
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("reject", trade)}
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-rose-800 hover:text-rose-200 disabled:opacity-50"
            >
              Reject
            </button>
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
    </article>
  );
}

/**
 * Props for the {@link ValueSwingText} component.
 */
interface ValueSwingTextProps {
  /** The signed change in this side's token balance. */
  delta: number;
  /** The member's display name, used to attribute the change. */
  name: string;
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
 * @param props - {@link ValueSwingTextProps}
 * @returns The formatted share.
 */
function ValueSwingText({ delta, name }: ValueSwingTextProps) {
  const tone =
    delta > 0
      ? "font-semibold text-emerald-300"
      : delta < 0
        ? "font-semibold text-rose-300"
        : "font-semibold text-slate-400";

  return (
    <>
      <span className={tone}>{formatTokenSwing(delta)}</span> for {name}
    </>
  );
}

/**
 * Props for the {@link TradeSidePanel} component.
 */
interface TradeSidePanelProps {
  /** The column heading, naming whose Pokémon these are. */
  heading: string;
  /** The Pokémon travelling from this side. */
  items: TradeItem[];
  /** Whether to show each Pokémon's tier value. */
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
              <Sprite spriteId={item.spriteId} name={item.name} size={32} />
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

/**
 * Props for the {@link ProposalBuilder} component.
 */
interface ProposalBuilderProps {
  /** The loaded page state. */
  goods: TradesGoods;
  /** True while a proposal is being submitted. */
  busy: boolean;
  /** Submits the proposal. */
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
  const parseTokens = (raw: string): number => {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  const proposerTokens = parseTokens(proposerTokensRaw);
  const recipientTokens = parseTokens(recipientTokensRaw);

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
  /* Whether anything at all is on the table, which is what earns a delta readout. */
  const hasValue =
    offer.length + request.length > 0 || proposerTokens > 0 || recipientTokens > 0;

  if (!goods.myTeam) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
        <p className="text-sm text-slate-400">
          You do not own a team in this season, so you cannot propose a trade.
        </p>
      </div>
    );
  }

  if (goods.season?.status !== "draft_complete") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
        <p className="text-sm text-slate-400">
          Trades unlock once the draft is complete. This season is still{" "}
          {goods.season?.status === "draft_active" ? "drafting" : "waiting to draft"}.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
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
                {team.owner_name?.trim() || team.team_name}
              </option>
            ))}
          </select>
        </label>
      </div>

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

      {/* Token inputs, mirroring the two Pokémon pickers above. */}
      {tokenTradesAllowed && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            Tokens
          </p>
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
        </div>
      )}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
          Projected balances
        </p>

        {!recipient ? (
          <p className="mt-3 text-sm text-slate-500">
            Choose a member to see what this trade would do for both of you.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">
              <p className="text-slate-400">You</p>
              <p className="mt-1">
                <BalanceText
                  remaining={projection?.proposerRemaining ?? 0}
                  costsEnabled={costsEnabled}
                />
              </p>
              {costsEnabled && hasValue && (
                <p
                  className={`mt-1 text-xs ${
                    (projection?.proposerDelta ?? 0) >= 0
                      ? "text-emerald-300"
                      : "text-rose-300"
                  }`}
                >
                  {(projection?.proposerDelta ?? 0) >= 0 ? "+" : ""}
                  {projection?.proposerDelta ?? 0} tokens
                </p>
              )}
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">
              <p className="text-slate-400">
                {recipient.owner_name?.trim() || recipient.team_name}
              </p>
              <p className="mt-1">
                <BalanceText
                  remaining={projection?.recipientRemaining ?? 0}
                  costsEnabled={costsEnabled}
                />
              </p>
              {costsEnabled && hasValue && (
                <p
                  className={`mt-1 text-xs ${
                    (projection?.recipientDelta ?? 0) >= 0
                      ? "text-emerald-300"
                      : "text-rose-300"
                  }`}
                >
                  {(projection?.recipientDelta ?? 0) >= 0 ? "+" : ""}
                  {projection?.recipientDelta ?? 0} tokens
                </p>
              )}
            </div>
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
      </div>
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

/**
 * The interactive trades page content.
 *
 * @param props - The URL search params used to resolve the selected league.
 * @returns The trade centre.
 */
function TradesPageContent({
  searchParams,
}: {
  /** Current URL search params used to select the league. */
  searchParams: URLSearchParams | null;
}) {
  const router = useRouter();
  const requestedLeagueId = searchParams?.get("leagueId") ?? null;
  const { confirm, confirmDialog } = useConfirm();
  /** Every timestamp on the page renders in the zone the member picked in settings. */
  const timeZone = useUserTimeZone();

  const [goods, setGoods] = useState<TradesGoods | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busyTradeId, setBusyTradeId] = useState<string | null>(null);
  const [tab, setTab] = useState<TradesTab>("new");

  const refresh = useCallback(async (leagueId: string): Promise<TradesGoods> => {
    const next = await loadTradesPageData(leagueId);
    setGoods(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadLeague() {
      try {
        setIsLoading(true);
        setError(null);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.replace("/");
          return;
        }

        let selectedLeagueId = requestedLeagueId;

        if (!selectedLeagueId) {
          try {
            selectedLeagueId =
              window.localStorage.getItem(SELECTED_LEAGUE_STORAGE_KEY) ?? null;
          } catch {
            selectedLeagueId = null;
          }
        }

        if (!selectedLeagueId) {
          const { data: memberships, error: membershipsError } = await supabase
            .from("league_members")
            .select("league_id")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("joined_at", { ascending: false })
            .limit(1);

          if (membershipsError || !memberships?.length) {
            setError("You are not a member of any active league.");
            return;
          }

          selectedLeagueId = memberships[0].league_id;
        }

        if (!selectedLeagueId) {
          setError("Select a league before opening the trade centre.");
          return;
        }

        const next = await loadTradesPageData(selectedLeagueId);
        if (!cancelled) {
          setGoods(next);
        }
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "The trade centre could not be loaded.";
        if (!cancelled) {
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadLeague();
    return () => {
      cancelled = true;
    };
  }, [router, requestedLeagueId]);

  const reload = useCallback(() => {
    if (goods) {
      void refresh(goods.league.id);
    }
  }, [goods, refresh]);

  /*
   * A refetch replaces the page's data, which would wipe a half-built proposal off
   * the screen. Pausing while the New Trade tab has a draft on it holds the event
   * instead of dropping it; `flush` applies it when the member moves to another tab.
   */
  const { flush } = useRealtimeInvalidation({
    leagueId: goods?.league.id ?? null,
    watchers: [{ table: "trades", onChange: reload }],
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
   * The three lists the tabs render, split here rather than inside each tab so the
   * counts on the tab buttons and the lists themselves cannot disagree.
   *
   * "My Trades" drops whatever the member has cleared for themselves. A dismissal
   * is per member, so this hides the card from the person who pressed Clear and not
   * from the other party, who still has it on their own list. "Trade History" keeps
   * every completed trade, because a completed trade is league business rather than
   * the reader's own to-do, and clearing it is not a way of erasing it.
   */
  const { myTrades, pendingApprovals, history } = useMemo(() => {
    if (!goods) {
      return { myTrades: [], pendingApprovals: [], history: [] as Trade[] };
    }

    const all = goods.trades;

    return {
      myTrades: all.filter(
        (trade) =>
          (isProposer(trade, goods.currentUserId) ||
            isRecipient(trade, goods.currentUserId)) &&
          !goods.dismissedTradeIds.has(trade.id),
      ),
      /*
       * Every trade awaiting a decision, including the reader's own.
       *
       * The Owner is always an approver, so an Owner who proposed a trade and had it
       * accepted is the person who has to settle it. Filtering party trades out of
       * this list -- as an earlier version did -- left exactly that trade invisible to
       * the only member who could act on it, so it sat in 'pending_approval' forever
       * with the Approvals tab looking empty. The tab is only rendered for members
       * who can approve at all, so no further gate is needed here.
       */
      pendingApprovals: all.filter(
        (trade) => trade.status === "pending_approval",
      ),
      history: all.filter((trade) => trade.status === "completed"),
    };
  }, [goods]);

  const requiresApproval = goods?.settings?.admins_approve_trades === true;
  const approverTotal = goods?.approverIds.length ?? 0;
  const approverRequired = requiredApprovals(approverTotal);

  /*
   * Every tab carries a notification marker, and both numbers come from the same
   * rule: the red bubble is for trades that are still in flight, the quiet count is
   * for what the tab merely holds. `countOpenTrades` answers "what is live"
   * identically for both tabs, so both members of a trade see the bubble while it
   * lives, not just the one whose turn it currently is.
   *
   * Nothing here is notification-derived or cleared on visit, deliberately. Reading a
   * tab does not settle a trade, so a bubble that emptied on arrival would understate
   * what is still open -- the tab would go quiet while the thing it was counting was
   * still sitting there unresolved.
   *
   * Declared below the `goods` null guard with the rest of the render, because it is
   * only used to draw the strip and every field it reads comes from the payload.
   */
  const tabsFor = (): Array<{
    id: TradesTab;
    label: string;
    /** Trades still in flight, drawn as the red bubble. */
    badge: number;
    /** Rows the tab holds, shown as a quiet count when nothing is live. */
    total: number;
    /** What the bubble's screen-reader label calls these. */
    subject: string;
  }> => {
    if (!goods) {
      return [];
    }

    return [
      { id: "new", label: "New Trade", badge: 0, total: 0, subject: "trade" },
      {
        id: "mine",
        label: "My Trades",
        badge: countOpenTrades(goods.trades, "my-trades", goods.currentUserId),
        total: myTrades.length,
        subject: "trade",
      },
      ...(goods.canApprove
        ? [
            {
              id: "approvals" as TradesTab,
              label: "Approvals",
              badge: countOpenTrades(
                goods.trades,
                "awaiting-approval",
                goods.currentUserId,
              ),
              total: pendingApprovals.length,
              subject: "approval",
            },
          ]
        : []),
      {
        id: "history",
        label: "Trade History",
        // A record, not a to-do: nothing in the history is ever still in flight.
        badge: 0,
        total: history.length,
        subject: "trade",
      },
    ];
  };

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

    const labels = tradeSideLabels(trade, goods.currentUserId);
    const other = labels.other;

    const confirmed = await confirm({
      title: {
        accept: "Accept this trade?",
        decline: "Decline this trade?",
        withdraw: "Withdraw this proposal?",
        approve: "Approve this trade?",
        reject: "Reject this trade?",
        override: "Override and complete this trade?",
        clear: "Clear this trade?",
      }[action],
      detail: {
        accept: `${other} will be told you accepted. ${
          requiresApproval
            ? "It still needs the league's approval before the Pokémon move."
            : "The Pokémon move as soon as you accept."
        }`,
        decline: `${other} will be told you declined.`,
        withdraw: `${other} will be told the proposal was withdrawn.`,
        approve: "Your approval is recorded against this trade.",
        reject: `${labels.proposer} and ${labels.recipient} will both be told the trade was rejected.`,
        override: "This completes the trade now, without waiting for the other approvers.",
        clear: "This removes the trade from your own list. It stays in league history.",
      }[action],
      confirmLabel: {
        accept: "Accept",
        decline: "Decline",
        withdraw: "Withdraw",
        approve: "Approve",
        reject: "Reject",
        override: "Approve (Override)",
        clear: "Clear",
      }[action],
      tone: action === "reject" || action === "withdraw" ? "danger" : "default",
    });

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
        case "reject": {
          await voteOnTrade(trade.id, false);
          setFeedback("Trade rejected. Both members have been told.");
          break;
        }
        case "clear": {
          await dismissTrade(trade.id);
          setFeedback("Trade cleared from your list.");
          break;
        }
      }

      await refresh(goods.league.id);
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
      await refresh(goods.league.id);
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
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading trades...
        </div>
      </main>
    );
  }

  if (error && !goods) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-red-800 bg-red-950/40 p-8 text-sm text-red-200 shadow-xl shadow-slate-950/40">
          {error}
        </div>
      </main>
    );
  }

  if (!goods) {
    return null;
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
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
                    {goods.myTeam.owner_name?.trim() || goods.myTeam.team_name}
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

          <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-700 pt-4">
            {tabsFor().map((entry) => (
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

        {tab === "new" && (
          <ProposalBuilder
            goods={goods}
            busy={Boolean(busyTradeId)}
            onSubmit={handlePropose}
          />
        )}

        {tab === "mine" && (
          <section className="space-y-4">
            {myTrades.length === 0 ? (
              <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
                You have no trades yet. Send a proposal from the New Trade tab.
              </p>
            ) : (
              myTrades.map((trade) => (
                <TradeCard
                  key={trade.id}
                  trade={trade}
                  goods={goods}
                  timeZone={timeZone}
                  busy={busyTradeId === trade.id}
                  /*
                   * Same rule as the Approvals tab, so a member looking at their own
                   * pending trade on this list gets the same controls they would get
                   * there. One rule, one place, whichever tab they happen to be on.
                   */
                  canVote={canVoteOnTrade(trade, goods.canApprove)}
                  isOwner={goods.userRole === "owner"}
                  onAction={handleAction}
                />
              ))
            )}
          </section>
        )}

        {tab === "approvals" && (
          <section className="space-y-4">
            {pendingApprovals.length === 0 ? (
              <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
                No trades are waiting on approval.
              </p>
            ) : (
              pendingApprovals.map((trade) => (
                <TradeCard
                  key={trade.id}
                  trade={trade}
                  goods={goods}
                  timeZone={timeZone}
                  busy={busyTradeId === trade.id}
                  canVote={canVoteOnTrade(trade, goods.canApprove)}
                  isOwner={goods.userRole === "owner"}
                  onAction={handleAction}
                />
              ))
            )}
          </section>
        )}

        {tab === "history" && (
          <section className="space-y-4">
            {history.length === 0 ? (
              <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
                No trades have completed in this season yet.
              </p>
            ) : (
              history.map((trade) => (
                <TradeCard
                  key={trade.id}
                  trade={trade}
                  goods={goods}
                  timeZone={timeZone}
                  busy={busyTradeId === trade.id}
                  canVote={false}
                  isOwner={false}
                  onAction={handleAction}
                />
              ))
            )}
          </section>
        )}
      </div>

      {confirmDialog}
    </main>
  );
}
