/*
 * Live draft arena for the Pokemon Draft League.
 *
 * A single-page orchestration of the season's draft: the pick-order strip on
 * top, the draftable Pokemon pool table on the left (matching the pool page's
 * search/filter/sort/sprite experience), and the current user's per-round
 * priority list on the right. The draft engine lives in the database (the
 * draft_picks ledger plus the make_draft_pick / resolve_draft_timeout /
 * save_priority_list RPCs in @/lib/supabase/draft); this page polls that
 * state, computes the current turn and pick deadline, drives the countdown
 * timer and audio/visual notifications, and issues the pick/priority actions.
 *
 * The page is split into a Suspense wrapper (to satisfy useSearchParams) and a
 * client content component that owns polling, the timer, and all mutations.
 */

/*
 * NOTE: This file was collapsed from an earlier multi-file draft-component
 * experiment. The repo convention (matching the pool and draftboard pages) is
 * a single self-contained client page, so all arena UI lives here instead of
 * under src/components/draft. Any stale files under that directory should be
 * removed; this page imports only from the shared draft data layer and pokeapi
 * helpers.
 */
"use client";

import Image from "next/image";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DraftGoods,
  computeDraftSlice,
  getPickDeadlineMs,
  getTeamSalary,
  isPokemonPicked,
  loadDraftData,
  resolveDraftTimeout,
  savePriorityList,
  setPriorityRoundFlags,
  submitDraftPick,
  DraftPriorityEntry,
} from "@/lib/supabase/draft";
import { getDexNumber, getSpriteUrl } from "@/lib/pokeapi";

/*
 * Small shared building blocks, mirroring the pool page's sprite/type/tier
 * conventions so the arena feels like the rest of the app.
 */

/** Tailwind chip classes keyed by normalized type name. */
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

/**
 * Renders a Pokemon sprite from the bundled sprite set, or a placeholder square
 * when the sprite id is unknown.
 *
 * @param props - Sprite id, alt text, and pixel size.
 * @returns The sprite image element.
 */
function Sprite({
  spriteId,
  name,
  size,
}: {
  /** Dex number (species) or 10001+ form id used to build the sprite URL. */
  spriteId: number;
  /** Alt text describing the sprite. */
  name: string;
  /** Square pixel dimensions. */
  size: number;
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
    <Image
      src={getSpriteUrl(spriteId)}
      alt={name}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="shrink-0 object-contain"
    />
  );
}

/** Formats a tier value as a display label ("Unranked" when zero). */
function tierLabel(tier: number): string {
  return tier === 0 ? "Unranked" : `Tier ${tier}`;
}

/**
 * Formats a remaining-duration string ("m:ss") from a deadline and a wall
 * clock timestamp.
 *
 * @param deadline - The deadline timestamp (may be null when no timer runs).
 * @param now - The current timestamp.
 * @returns The countdown string, or null when no deadline exists.
 */
function formatCountdown(deadline: number | null, now: number): string | null {
  if (deadline == null) {
    return null;
  }
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

/**
 * Maps a season status to its header pill styles.
 */
const STATUS_STYLES: Record<string, string> = {
  draft_pending: "bg-slate-800 text-slate-300",
  draft_active: "bg-amber-500/15 text-amber-300",
  draft_complete: "bg-emerald-500/15 text-emerald-300",
  archived: "bg-slate-700 text-slate-400",
};

/** Human-readable season status labels. */
const STATUS_LABELS: Record<string, string> = {
  draft_pending: "Not started",
  draft_active: "Live",
  draft_complete: "Complete",
  archived: "Archived",
};

/*
 * Props shared by the arena panels. Each panel gets the loaded draft state and
 * a small slice of act-sheet actions it is allowed to trigger, plus the timer's
 * current wall-clock timestamp for countdown rendering.
 */

/** Actions the arena page passes down to the pool panel. */
type PoolActions = {
  /** Submits a draft pick (null pokemon = pass) for the on-clock team. */
  onPick: (pokemonId: string | null) => void;
  /** Adds a pool Pokemon to a round of the current user's priority list. */
  onAddToPriority: (pokemonId: string, roundNumber: number) => void;
};

/** Actions the arena page passes down to the priority panel. */
type PriorityActions = {
  /** Reorders an entry within its round (delta -1 = move up/leftward). */
  onMoveWithinRound: (key: string, delta: number) => void;
  /** Moves an entry to a different round (keeps its position in that list). */
  onMoveToRound: (key: string, targetRound: number) => void;
  /** Sets the Auto-Pick / Skip-Pick flags for a round via the RPC. */
  onSetRoundFlags: (
    roundNumber: number,
    autoPick: boolean,
    skipPick: boolean,
  ) => void;
  /** Removes an entry from the priority list. */
  onRemove: (key: string) => void;
  /** Persists the current list via the save_priority_list RPC. */
  onSave: () => void;
  /** Clears any list-level error shown by the panel. */
  onClearError: () => void;
};

/** Shared arena panel props for all three panels. */
type ArenaPanelProps = {
  /** The complete loaded draft state. */
  goods: DraftGoods;
  /** Current wall-clock timestamp for countdown rendering. */
  now: number;
};

/*
 * The on-draft header: league/season identity, status pill, live round/pick
 * info, and a countdown toward the current pick deadline.
 */

/**
 * Renders the arena header with league identity, status, and the live pick
 * countdown.
 *
 * @param props - {@link ArenaPanelProps}
 * @returns The header markup.
 */
function DraftHeader({ goods, now }: ArenaPanelProps) {
  const season = goods.season;
  const status = season?.status ?? "draft_pending";
  const slice = computeDraftSlice(goods);
  const deadline = getPickDeadlineMs(goods);
  const countdown = formatCountdown(deadline, now);
  const isUrgent = deadline != null && deadline - now <= 60_000;

  return (
    <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-slate-950/30">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{goods.league.name}</h1>
          <p className="mt-1 text-sm text-slate-400">
            Season {goods.season?.season_number ?? "—"}{" "}
            {goods.settings?.total_rounds ?? "—"} rounds
            {goods.settings?.draft_format === "snake"
              ? " · Snake"
              : goods.settings?.draft_format === "set"
                ? " · Set"
                : ""}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!slice.isOver && deadline != null && (
            <div
              className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 ${
                isUrgent
                  ? "animate-pulse border-red-500/40 bg-red-500/10"
                  : "border-slate-700 bg-slate-800/60"
              }`}
            >
              <span className="font-mono text-xl font-bold tabular-nums text-slate-100">
                {countdown}
              </span>
              <span className="text-xs text-slate-400">on the clock</span>
            </div>
          )}

          <span
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
              STATUS_STYLES[status] ?? STATUS_STYLES.draft_pending
            }`}
          >
            {STATUS_LABELS[status] ?? status}
          </span>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-slate-800 pt-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-slate-400">Round</span>
          <span className="font-semibold text-slate-100">
            {slice.isOver ? "—" : slice.roundNumber}
          </span>
          <span className="text-slate-600">/</span>
          <span className="text-slate-400">{slice.totalRounds}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-400">Pick</span>
          <span className="font-semibold text-slate-100">
            {slice.isOver ? "—" : slice.pickInRound}
          </span>
          <span className="text-slate-600">/</span>
          <span className="text-slate-400">
            {goods.teams.length > 0 ? `${goods.teams.length}` : "—"}
          </span>
        </div>
        {slice.isSnakeReversal && !slice.isOver && (
          <span className="text-amber-400">Snake reversal</span>
        )}
        {slice.isOver && (
          <span className="font-semibold text-emerald-300">Complete</span>
        )}
      </div>
    </header>
  );
}

/*
 * The players strip: each team's card in draft position order, showing the team
 * name, its owner, a compact row of its most recent captured sprites, and
 * emphasis (amber ring) when that team is on the clock.
 */

/**
 * Renders the horizontal strip of team cards in draft pick order.
 *
 * @param props - {@link ArenaPanelProps}
 * @returns The strip markup.
 */
function PlayersStrip({ goods, now }: ArenaPanelProps) {
  const slice = computeDraftSlice(goods);
  const ordered = [...goods.teams].sort((a, b) => {
    const pa = a.draft_position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.draft_position ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-slate-950/30">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
          Pick order
        </h2>
        <span className="text-xs text-slate-500">
          {goods.myTeamId
            ? "You: " +
              (ordered.find((team) => team.id === goods.myTeamId)?.team_name ??
                "")
            : ""}
        </span>
      </div>

      <ol className="flex flex-wrap gap-3">
        {ordered.map((team, index) => {
          const onClock = slice.currentTeam?.id === team.id && !slice.isOver;
          const picks = goods.picks.filter(
            (pick) => pick.team_id === team.id && !pick.is_pass,
          );
          const recent = [...picks]
            .sort((a, b) => b.overall_pick - a.overall_pick)
            .slice(0, 3);

          return (
            <li
              key={team.id}
              className={`min-w-[10rem] flex-1 rounded-xl border p-4 transition ${
                onClock
                  ? "border-amber-400 bg-amber-500/10 shadow-lg shadow-amber-500/10"
                  : "border-slate-800 bg-slate-950/50"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  #{index + 1}
                </span>
                {onClock && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                    On clock
                  </span>
                )}
              </div>
              <p className="mt-2 truncate text-sm font-semibold text-slate-100">
                {team.team_name}
              </p>
              <div className="mt-2 flex h-10 items-center gap-1">
                {recent.length === 0 ? (
                  <span className="text-xs text-slate-600">No picks yet</span>
                ) : (
                  recent.map((pick) => (
                    <Sprite
                      key={pick.id}
                      spriteId={pick.species_name ? dexOf(pick.pokemon_id) : 0}
                      name={pick.species_name ?? "Picked"}
                      size={36}
                    />
                  ))
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/*
 * NOTE: sprites in the strip derive their dex id from the pick's pokemon_id
 * slug via the shared catalog helper; see the pool page for the same pattern.
 */

/** Resolves the dex id for a pick's pokemon id slug. */
function dexOf(pokemonId: string | null): number {
  return getDexNumber(pokemonId ?? "");
}

/*
 * The pool panel: a searchable/filterable/sortable table of the draftable pool,
 * mirroring the pool page. Each row offers a single action: draft the Pokemon
 * when it is the current user's turn (respecting the salary budget), or add it
 * to a chosen round of the priority list otherwise.
 */

type SortKey = "dex" | "tier" | "bst" | "generation";
type SortDir = "asc" | "desc";

const SORT_LABELS: Record<SortKey, string> = {
  dex: "Dex",
  tier: "Tier",
  bst: "BST",
  generation: "Gen",
};

/**
 * Renders the left pool panel: search box, type filter, sort controls, and the
 * draftable Pokemon table.
 *
 * @param props - {@link ArenaPanelProps} plus {@link PoolActions}.
 * @returns The pool panel markup.
 */
function PoolPanel({
  goods,
  now,
  actions,
}: ArenaPanelProps & { actions: PoolActions }) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("dex");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const typeOptions = useMemo(() => {
    const types = new Set<string>();
    goods.poolRows.forEach((row) => {
      if (row.type_primary) types.add(row.type_primary);
    });
    return [...types].sort();
  }, [goods.poolRows]);

  const picked = useMemo(
    () => new Set(goods.picks.map((pick) => pick.pokemon_id)),
    [goods.picks],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = goods.poolRows.filter((row) => {
      if (q && !row.species_name.toLowerCase().includes(q)) return false;
      if (typeFilter && row.type_primary !== typeFilter) return false;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "dex") return (a.dex - b.dex) * dir;
      if (sortKey === "tier") return (a.tier_value - b.tier_value) * dir;
      if (sortKey === "bst") return ((a.bst ?? 0) - (b.bst ?? 0)) * dir;
      return (a.generation ?? "").localeCompare(b.generation ?? "") * dir;
    });
  }, [goods.poolRows, query, typeFilter, sortKey, sortDir]);

  const mySalary = goods.myTeamId ? getTeamSalary(goods, goods.myTeamId) : null;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl shadow-slate-950/30">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 p-4">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Enter Pokemon Name"
          aria-label="Search the draft pool"
          className="w-56 rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-amber-400"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTypeFilter(null)}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              typeFilter == null
                ? "bg-amber-500/15 text-amber-300"
                : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            }`}
          >
            All
          </button>
          {typeOptions.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() =>
                setTypeFilter((current) => (current === type ? null : type))
              }
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                typeFilter === type
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full divide-y divide-slate-800 text-sm">
          <thead className="sticky top-0 z-10 bg-slate-900 text-slate-400">
            <tr>
              <th className="px-4 py-3 text-left">
                <button
                  type="button"
                  onClick={() => toggleSort("dex")}
                  className={`inline-flex items-center gap-1 font-semibold ${
                    sortKey === "dex" ? "text-amber-300" : ""
                  }`}
                >
                  Dex {sortKey === "dex" && (sortDir === "asc" ? "▲" : "▼")}
                </button>
              </th>
              <th className="px-4 py-3 text-left font-semibold">Pokémon</th>
              <th className="px-4 py-3 text-left font-semibold">Type</th>
              <th className="px-4 py-3 text-left">
                <button
                  type="button"
                  onClick={() => toggleSort("tier")}
                  className={`inline-flex items-center gap-1 font-semibold ${
                    sortKey === "tier" ? "text-amber-300" : ""
                  }`}
                >
                  Tier {sortKey === "tier" && (sortDir === "asc" ? "▲" : "▼")}
                </button>
              </th>
              <th className="px-4 py-3 text-right">
                <button
                  type="button"
                  onClick={() => toggleSort("bst")}
                  className={`inline-flex items-center gap-1 font-semibold ${
                    sortKey === "bst" ? "text-amber-300" : ""
                  }`}
                >
                  BST {sortKey === "bst" && (sortDir === "asc" ? "▲" : "▼")}
                </button>
              </th>
              <th className="px-4 py-3 text-left">
                <button
                  type="button"
                  onClick={() => toggleSort("generation")}
                  className={`inline-flex items-center gap-1 font-semibold ${
                    sortKey === "generation" ? "text-amber-300" : ""
                  }`}
                >
                  Gen{" "}
                  {sortKey === "generation" && (sortDir === "asc" ? "▲" : "▼")}
                </button>
              </th>
              <th className="px-4 py-3 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 bg-slate-950/40">
            {rows.map((row) => {
              const isTaken = picked.has(row.pokemon_id);
              const canPick =
                !isTaken &&
                goods.userRole !== null &&
                (sliceOf(goods).isMyTurn
                  ? mySalary?.remaining != null &&
                    (mySalary.remaining >= row.tier_value ||
                      !goods.settings?.enable_pokemon_costs)
                  : false);
              return (
                <tr
                  key={row.pokemon_id}
                  className={isTaken ? "opacity-45" : "hover:bg-slate-800/50"}
                >
                  <td className="px-4 py-2.5 text-slate-500">
                    {row.dex > 0 ? `#${row.dex}` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Sprite
                        spriteId={row.dex}
                        name={row.species_name}
                        size={40}
                      />
                      <span className="font-medium text-slate-100">
                        {row.species_name}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {[row.type_primary, row.type_secondary]
                        .filter(Boolean)
                        .map((type) => (
                          <span
                            key={type}
                            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                              TYPE_STYLES[type ?? ""] ??
                              "bg-slate-700 text-slate-200"
                            }`}
                          >
                            {type}
                          </span>
                        ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-300">
                    {tierLabel(row.tier_value)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                    {row.bst ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">
                    {row.generation ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {isTaken ? (
                      <span className="text-xs font-bold text-emerald-400">
                        Drafted
                      </span>
                    ) : sliceOf(goods).isMyTurn ? (
                      <button
                        type="button"
                        onClick={() => actions.onPick(row.pokemon_id)}
                        disabled={!canPick}
                        className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Pick
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          actions.onAddToPriority(
                            row.pokemon_id,
                            sliceOf(goods).roundNumber || 1,
                          )
                        }
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-bold text-slate-200 transition hover:border-amber-400 hover:text-amber-300"
                      >
                        Add to round {sliceOf(goods).roundNumber || 1}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-slate-500"
                >
                  No Pokémon match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-4 py-3 text-xs text-slate-400">
        <span>
          {rows.length} of {goods.poolRows.length} in the pool
        </span>
        {sliceOf(goods).isMyTurn && mySalary && (
          <span className="font-medium text-slate-300">
            Salary: {mySalary.remaining.toLocaleString()} remaining
          </span>
        )}
      </div>
    </section>
  );
}

/*
 * The priority panel: the current user's per-round priority listsestr. Circular
 * lists are stored by round_number; entries within a round are order-sensitive
 * (leftmost = highest priority). Reordering stays client-side until Save.
 */

/**
 * Computes the current-turn slice (cached per goods reference).
 *
 * @param goods - The loaded draft state.
 * @returns The derived {@link computeDraftSlice} result.
 */
function sliceOf(goods: DraftGoods) {
  return computeDraftSlice(goods);
}

/**
 * Renders the right priority panel: round buckets of the user's priority list
 * with reorder/remove controls and a Save action.
 *
 * @param props - {@link ArenaPanelProps} plus {@link PriorityActions}.
 * @returns The priority panel markup.
 */

/** Key used to address a single priority entry across panels. */
export type PriorityKey = string;

/**
 * Renders the right priority panel.
 *
 * @param props - {@link ArenaPanelProps} plus {@link PriorityActions}.
 * @returns The priority panel markup.
 */
function PriorityPanel({
  goods,
  now,
  actions,
  entries,
  error,
  isSaving,
  roundFlags,
}: ArenaPanelProps & {
  actions: PriorityActions;
  /** The current user's ordered priority entries. */
  entries: DraftPriorityEntry[];
  /** List-level error text, or null when none. */
  error: string | null;
  /** True while a save is in flight. */
  isSaving: boolean;
  /** Per-round Auto-Pick / Skip-Pick flag state (round number key). */
  roundFlags: Map<number, { autoPick: boolean; skipPick: boolean }>;
}) {
  const byRound = useMemo(() => {
    const map = new Map<number, DraftPriorityEntry[]>();
    entries.forEach((entry) => {
      const list = map.get(entry.round_number) ?? [];
      list.push(entry);
      map.set(entry.round_number, list);
    });
    return map;
  }, [entries]);

  const totalRounds = goods.settings?.total_rounds ?? 1;
  const rounds = Array.from({ length: totalRounds }, (_, index) => index + 1);

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl shadow-slate-950/30">
      <div className="flex items-center justify-between border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
          My priority
        </h2>
        <span className="text-xs text-slate-500">
          Leftmost = highest priority
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
        {rounds.map((round) => {
          const list = byRound.get(round) ?? [];
          return (
            <div key={round}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-slate-100">
                  Round {round}
                </p>
                <div className="flex items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={roundFlags.get(round)?.autoPick ?? false}
                      onChange={(event) =>
                        actions.onSetRoundFlags(
                          round,
                          event.target.checked,
                          false,
                        )
                      }
                      className="h-3.5 w-3.5 rounded accent-amber-500"
                    />
                    Auto Pick
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={roundFlags.get(round)?.skipPick ?? false}
                      onChange={(event) =>
                        actions.onSetRoundFlags(
                          round,
                          false,
                          event.target.checked,
                        )
                      }
                      className="h-3.5 w-3.5 rounded accent-amber-500"
                    />
                    Skip Pick
                  </label>
                  <span className="text-xs text-slate-500">
                    {list.length} Pokémon
                  </span>
                </div>
              </div>

              {list.length === 0 ? (
                <p className="mt-2 rounded-xl border border-dashed border-slate-800 p-3 text-xs text-slate-600">
                  Empty — add Pokémon from the pool to this round.
                </p>
              ) : (
                <ol className="mt-2 space-y-1.5">
                  {list.map((entry, index) => (
                    <li
                      key={entryKey(entry)}
                      className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-2"
                    >
                      <span className="w-6 text-center text-xs font-bold text-slate-500">
                        {index + 1}
                      </span>
                      <Sprite
                        spriteId={dexOf(entry.pokemon_id)}
                        name={entry.species_name}
                        size={36}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
                        {entry.species_name}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          actions.onMoveWithinRound(entryKey(entry), -1)
                        }
                        disabled={index === 0}
                        aria-label={`Move ${entry.species_name} left in round ${round}`}
                        className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-30"
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          actions.onMoveWithinRound(entryKey(entry), 1)
                        }
                        disabled={index === list.length - 1}
                        aria-label={`Move ${entry.species_name} right in round ${round}`}
                        className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-30"
                      >
                        →
                      </button>
                      <button
                        type="button"
                        onClick={() => actions.onRemove(entryKey(entry))}
                        aria-label={`Remove ${entry.species_name}`}
                        className="rounded-lg border border-red-800 px-2 py-1 text-xs font-bold text-red-300 transition hover:bg-red-900/40"
                      >
                        X
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-800 p-4">
        {error && (
          <p className="mb-3 text-xs font-semibold text-red-300">{error}</p>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={actions.onSave}
            disabled={isSaving}
            className="w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-40"
          >
            {isSaving ? "Saving" : "Save priority list"}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Builds a stable key for a priority entry. */
function entryKey(entry: DraftPriorityEntry): string {
  return `${entry.round_number}:${entry.pokemon_id}`;
}

/**
 * Compares two priority lists by their ordered round/pokemon keys.
 *
 * @param left - The first priority list.
 * @param right - The second priority list.
 * @returns True when both lists hold the same entries in the same order.
 */
function sameEntries(
  left: DraftPriorityEntry[],
  right: DraftPriorityEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entryKey(entry) === entryKey(right[index]));
}

/**
 * Derives the per-round Auto-Pick / Skip-Pick flag map from loaded entries.
 *
 * @param entries - The priority entries (each row carries the round flags).
 * @returns A map from round number to its flag pair.
 */
function roundFlagsFromEntries(
  entries: DraftPriorityEntry[],
): Map<number, { autoPick: boolean; skipPick: boolean }> {
  const flags = new Map<number, { autoPick: boolean; skipPick: boolean }>();
  entries.forEach((entry) => {
    flags.set(entry.round_number, {
      autoPick: entry.auto_pick,
      skipPick: entry.skip_pick,
    });
  });
  return flags;
}

/**
 * Renders a compact empty-draft state when no season exists yet.
 *
 * @param props - The league name for context.
 * @returns The empty-state markup.
 */
function EmptyDraft({ leagueName }: { leagueName: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-10 text-center">
      <p className="text-sm font-medium text-slate-400">
        {leagueName} has no draft season yet.
      </p>
      <p className="mt-2 text-sm text-slate-500">
        Start the draft from the draft board to open the arena.
      </p>
    </div>
  );
}

/*
 * The arena orchestrator: loads draft state, polls it on an interval, drives
 * the pick deadline timer and audio/visual notifications, and wires the panel
 * actions (pick, priority add/reorder/save) to the draft RPCs.
 */

/** Polling interval for draft state refreshes, in milliseconds. */
const POLL_INTERVAL_MS = 5000;
/** Timer tick cadence, in milliseconds. */
const TICK_INTERVAL_MS = 1000;
/** Milliseconds below which the countdown turns urgent. */
const URGENT_THRESHOLD_MS = 60_000;

/**
 * Main arena content: owns polling, the countdown timer, notifications, and the
 * pick/priority mutations.
 *
 * @param props - The league id whose draft to render.
 * @returns The arena markup.
 */
function DraftArena({ leagueId }: { leagueId: string }) {
  const router = useRouter();
  const [goods, setGoods] = useState<DraftGoods | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [priorityEntries, setPriorityEntries] = useState<DraftPriorityEntry[]>(
    [],
  );
  const [isSaving, setIsSaving] = useState(false);
  const [priorityError, setPriorityError] = useState<string | null>(null);
  const [roundFlags, setRoundFlags] = useState<
    Map<number, { autoPick: boolean; skipPick: boolean }>
  >(new Map());
  const [busyPick, setBusyPick] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const prevDeadlineRef = useRef<number | null>(null);
  const warnedRef = useRef(false);
  // Mirror of the priority list so async callbacks (save/poll) never read a
  // stale closure, plus a flag tracking unsaved local edits so server polls
  // don't clobber in-progress add/remove/reorder work.
  const priorityEntriesRef = useRef<DraftPriorityEntry[]>([]);
  const priorityDirtyRef = useRef(false);
  // Serializes overlapping priority saves and lets only the newest one refresh
  // the panel after it completes.
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveVersionRef = useRef(0);

  const slice = useMemo(
    () => (goods ? computeDraftSlice(goods) : null),
    [goods],
  );

  // Refresh draft state on the poll interval, and tick the wall clock.
  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (cancelled) return;
      try {
        const next = await loadDraftData(leagueId);
        if (cancelled) return;
        setGoods(next);
        applyServerPriority(next.priority);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Draft load failed.");
      }
    }

    void refresh();
    const pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const tickTimer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(tickTimer);
    };
  }, [leagueId]);

  // Seeding of local priority entries happens in the load callbacks alongside
  // setGoods, so the entries stay in sync without a separate sync-in-effect pass.

  // Notification: when the on-clock deadline appears (turn changes) and when it
  // crosses the one-minute mark, play a short tone and mark the banner urgent.
  const deadline = useMemo(() => {
    return goods ? getPickDeadlineMs(goods) : null;
  }, [goods]);

  useEffect(() => {
    if (deadline == null) {
      warnedRef.current = false;
      return;
    }

    if (prevDeadlineRef.current == null) {
      // A new deadline (turn started): play the "on the clock" tone.
      playTone(audioRef, 880, 0.12);
      warnedRef.current = false;
    } else if (deadline !== prevDeadlineRef.current) {
      // A fresh pick after resolving the previous timer.
      playTone(audioRef, 880, 0.12);
      warnedRef.current = false;
    }
    prevDeadlineRef.current = deadline;

    // One-minute warning.
    if (deadline - now <= URGENT_THRESHOLD_MS && !warnedRef.current) {
      playTone(audioRef, 440, 0.35);
      warnedRef.current = true;
    }
  }, [deadline, now]);

  async function handlePick(pokemonId: string | null) {
    if (!goods || busyPick) return;
    setBusyPick(true);
    try {
      await submitDraftPick(goods.league.id, pokemonId);
      await refreshGoods();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pick failed.");
    } finally {
      setBusyPick(false);
    }
  }

  async function refreshGoods() {
    const next = await loadDraftData(leagueId);
    setGoods(next);
    applyServerPriority(next.priority);
    setError(null);
  }

  // Adopts a freshly loaded server priority snapshot only when the user has no
  // unsaved local edits, so the 5s poll cannot undo in-progress changes.
  function applyServerPriority(next: DraftPriorityEntry[]) {
    if (priorityDirtyRef.current) return;
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    setRoundFlags(roundFlagsFromEntries(next));
  }

  function handleAddToPriority(pokemonId: string, roundNumber: number) {
    const key = `${roundNumber}:${pokemonId}`;
    const current = priorityEntriesRef.current;
    if (current.some((entry) => entryKey(entry) === key)) {
      return;
    }
    const poolRow = goods?.poolRows.find((row) => row.pokemon_id === pokemonId);
    const next = [
      ...current,
      {
        round_number: roundNumber,
        pokemon_id: pokemonId,
        species_name: poolRow?.species_name ?? pokemonId,
        tier_value: poolRow?.tier_value ?? 0,
        auto_pick: false,
        skip_pick: false,
      },
    ];
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    priorityDirtyRef.current = true;
    void handleSave(next);
  }


  function handleMoveWithinRound(key: string, delta: number) {
    const current = priorityEntriesRef.current;
    const [roundNumber, pokemonId] = key.split(":");
    const round = Number(roundNumber);
    const group = current.filter((entry) => entry.round_number === round);
    const idx = group.findIndex((entry) => entry.pokemon_id === pokemonId);
    if (idx < 0) return;
    const to = idx + delta;
    if (to < 0 || to >= group.length) return;
    const moved = group[idx];
    group.splice(idx, 1);
    group.splice(to, 0, moved);
    const others = current.filter((entry) => entry.round_number !== round);
    const next = [...others, ...group];
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    priorityDirtyRef.current = true;
  }

  function handleRemove(key: string) {
    const next = priorityEntriesRef.current.filter(
      (entry) => entryKey(entry) !== key,
    );
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    priorityDirtyRef.current = true;
  }

  async function handleSetRoundFlags(
    roundNumber: number,
    autoPick: boolean,
    skipPick: boolean,
  ) {
    try {
      await setPriorityRoundFlags(leagueId, roundNumber, autoPick, skipPick);
      setRoundFlags((current) => ({
        ...current,
        [roundNumber]: { autoPick, skipPick },
      }));
      setPriorityError(null);
    } catch (cause) {
      setPriorityError(
        cause instanceof Error ? cause.message : "Flag update failed.",
      );
    }
  }

  async function handleSave(entries?: DraftPriorityEntry[]) {
    if (!goods) return;
    const toSave = entries ?? priorityEntriesRef.current;
    const payload = toSave.map((entry) => ({
      round_number: entry.round_number,
      pokemon_id: entry.pokemon_id,
    }));
    // Each save writes a full snapshot, and rapid edits issue overlapping
    // requests. Track a version so only the most recent save refreshes the
    // panel; earlier writes still land in order but never overwrite newer UI.
    const version = saveVersionRef.current + 1;
    saveVersionRef.current = version;

    setIsSaving(true);
    setPriorityError(null);
    let saveError: unknown = null;
    try {
      saveQueueRef.current = saveQueueRef.current
        .then(() => savePriorityList(goods.league.id, payload).then(() => undefined))
        .catch((cause: unknown) => {
          if (version !== saveVersionRef.current) return;
          saveError = cause;
        });
      await saveQueueRef.current;
    } catch (cause) {
      if (version === saveVersionRef.current) saveError = cause;
    }

    if (version !== saveVersionRef.current) return;
    try {
      if (saveError !== null) {
        setPriorityError(
          saveError instanceof Error
            ? saveError.message
            : "Priority save failed.",
        );
        return;
      }
      if (!sameEntries(toSave, priorityEntriesRef.current)) {
        // The user edited the list after this save's snapshot was taken, so
        // the written list is already stale. Leave the fresher local edits
        // pending instead of letting the refetch overwrite them.
        return;
      }
      priorityEntriesRef.current = toSave;
      priorityDirtyRef.current = false;
      await refreshGoods();
    } catch (cause) {
      setPriorityError(
        cause instanceof Error ? cause.message : "Priority save failed.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (!goods) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
            {error ? error : "Loading draft..."}
          </div>
        </div>
      </main>
    );
  }

  if (!goods.season) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-7xl">
          <EmptyDraft leagueName={goods.league.name} />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <DraftHeader goods={goods} now={now} />

        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950/50 px-4 py-3 text-sm font-medium text-red-300">
            {error}
          </div>
        )}

        {slice?.isMyTurn && !slice.isOver && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-4">
            <div>
              <p className="font-semibold text-amber-200">
                You&apos;re on the clock!
              </p>
              <p className="mt-0.5 text-sm text-amber-200/70">
                Pick a Pokémon from the pool, or use the bottom-right action to
                adjust your priority list.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handlePick(null)}
              disabled={busyPick}
              className="rounded-xl border border-amber-500/50 px-4 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-500/15 disabled:opacity-40"
            >
              Pass
            </button>
          </div>
        )}

        <PlayersStrip goods={goods} now={now} />

        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
          <PoolPanel
            goods={goods}
            now={now}
            actions={{
              onPick: (pokemonId) => void handlePick(pokemonId),
              onAddToPriority: (pokemonId, roundNumber) =>
                handleAddToPriority(pokemonId, roundNumber),
            }}
          />
          <PriorityPanel
            goods={goods}
            now={now}
            entries={priorityEntries}
            error={priorityError}
            isSaving={isSaving}
            roundFlags={roundFlags}
            actions={{
              onMoveWithinRound: (key, delta) =>
                handleMoveWithinRound(key, delta),
              onMoveToRound: () => {},
              onSetRoundFlags: (roundNumber, autoPick, skipPick) =>
                void handleSetRoundFlags(roundNumber, autoPick, skipPick),
              onRemove: (key) => handleRemove(key),
              onSave: () => void handleSave(),
              onClearError: () => setPriorityError(null),
            }}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * Parses and wires the route query string to the arena content inside a
 * Suspense boundary (required by Next.js for `useSearchParams`).
 *
 * @returns The draft page with its loading fallback.
 */
export default function DraftPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-7xl rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
            Loading draft arena...
          </div>
        </main>
      }
    >
      <DraftPageContent />
    </Suspense>
  );
}

/**
 * Reads the league id from the query string and renders the live arena.
 *
 * @returns The arena content.
 */
function DraftPageContent() {
  const searchParams = useSearchParams();
  const leagueId = searchParams.get("leagueId");

  if (!leagueId) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center text-sm text-slate-400">
          <p className="font-semibold text-slate-200">
            No league selected for the draft.
          </p>
          <p className="mt-2">
            Open a league from the dashboard and choose ΓÇ£Draft BoardΓ· to
            start the arena.
          </p>
        </div>
      </main>
    );
  }

  return <DraftArena leagueId={leagueId} />;
}

/*
 * Small audio helper: plays a short beep through the Web Audio API, creating
 * the AudioContext lazily on first user interaction.
 */

/**
 * Plays a short notification tone.
 *
 * @param audioRef - A ref holding the lazily-created AudioContext (or null).
 * @param frequency - The tone frequency in hertz.
 * @param duration - The tone duration in seconds.
 */
function playTone(
  audioRef: React.RefObject<AudioContext | null>,
  frequency: number,
  duration: number,
) {
  const windowRef = window;
  if (!windowRef) return;

  const AudioCtor = windowRef.AudioContext;
  if (!AudioCtor) return;

  if (!audioRef.current) {
    audioRef.current = new AudioCtor();
  }

  const context = audioRef.current;
  if (context.state === "suspended") {
    void context.resume();
  }

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    context.currentTime + duration,
  );
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration + 0.05);
}

// The helpers above intentionally avoid a global client store; everything the
// arena needs flows from the single loadDraftData payload the page polls.
