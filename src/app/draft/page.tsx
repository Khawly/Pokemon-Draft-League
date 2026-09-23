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
 * timer and audio/visual notifications, asks the database to resolve expired
 * or zero-token turns, and issues the pick/priority actions.
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
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DraftGoods,
  DraftTeam,
  DraftPoolRow,
  DraftStatus,
  DraftPick,
  computeDraftSlice,
  getPickDeadlineMs,
  getTeamSalary,
  isPokemonPicked,
  loadDraftData,
  resetDraft,
  resolveDraftTimeout,
  savePriorityList,
  setDraftPaused,
  setPriorityRoundFlags,
  submitDraftPick,
  DraftPriorityEntry,
} from "@/lib/supabase/draft";
import { AbilityTooltip } from "@/components/ability-tooltip";
import {
  getDexNumber,
  getPokemonDetailsBySlug,
  getSpriteUrl,
} from "@/lib/pokeapi";

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

/** Extracts just the generation number from a label like "Gen 1". */
function generationNumber(generation: string): string {
  const match = /\d+/.exec(generation);
  return match ? match[0] : generation;
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
};

/** Actions the arena page passes down to the priority panel. */
type PriorityActions = {
  /** Adds a pool Pokemon to a round of the current user's priority list. */
  onAddToRound: (pokemonId: string, roundNumber: number) => void;
  /** Moves an entry to an absolute position within a round via drag-and-drop. */
  onMoveEntry: (key: string, targetRound: number, targetIndex: number) => void;
  /** Requests a confirm dialog pick for a priority card (on your turn). */
  onPick: (pokemonId: string) => void;
  /** Sets the Auto-Pick / Skip-Pick flags for a round via the RPC. */
  onSetRoundFlags: (
    roundNumber: number,
    autoPick: boolean,
    skipPick: boolean,
  ) => void;
  /** Removes an entry dropped outside any round bucket. */
  onRemove: (key: string) => void;
  /** Removes every entry from the priority list. */
  onClear: () => void;
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
 * The on-draft header: league/season identity, a draft timer showing the pick
 * time limit from draft settings (paused while the draft has not started), the
 * season status pill, and live round/pick info.
 */

/**
 * Formats a millisecond duration as "m:ss" without a live deadline.
 *
 * @param ms - The duration in milliseconds.
 * @returns The formatted duration string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

/**
 * Renders the draft timer pinned top-right of the arena header.
 *
 * The timer is seeded with the pick time limit configured in draft settings and
 * counts down while a pick is on the clock; it sits paused at the full limit
 * until the draft starts, turns red/urgent inside the final minute, and is
 * frozen once the draft completes.
 *
 * @param props.limitMinutes - Pick time limit from draft settings.
 * @param props.status - The season's draft lifecycle status.
 * @param props.startedAt - When the current on-clock pick started (persisted).
 * @param props.pausedAt - When the owner paused the timer, or null when running.
 * @param props.now - Current wall-clock timestamp.
 * @returns The timer markup.
 */
function DraftTimer({
  limitMinutes,
  status,
  startedAt,
  pausedAt,
  now,
}: {
  limitMinutes: number | null;
  status: DraftStatus | null;
  startedAt: string | null;
  pausedAt: string | null;
  now: number;
}) {
  const limitMs = (limitMinutes && limitMinutes > 0 ? limitMinutes : 5) * 60_000;

  if (status === "draft_active" && startedAt) {
    const deadline = new Date(startedAt).getTime() + limitMs;

    if (pausedAt) {
      // The timer is frozen: show the remaining budget as of the pause instant.
      const pausedAtMs = new Date(pausedAt).getTime();
      return (
        <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-2.5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Draft Timer
            </p>
            <p className="font-mono text-xl font-bold tabular-nums text-slate-100">
              {formatCountdown(deadline, pausedAtMs)}
            </p>
          </div>
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">
            Paused
          </span>
        </div>
      );
    }

    const remaining = Math.max(0, deadline - now);
    const urgent = remaining <= URGENT_THRESHOLD_MS;
    return (
      <div
        className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 ${
          urgent
            ? "animate-pulse border-red-500/40 bg-red-500/10"
            : "border-slate-700 bg-slate-800/60"
        }`}
      >
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Draft Timer
          </p>
          <p className="font-mono text-xl font-bold tabular-nums text-slate-100">
            {formatCountdown(deadline, now)}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
            urgent
              ? "bg-red-500/15 text-red-300"
              : "bg-emerald-500/15 text-emerald-300"
          }`}
        >
          {urgent ? "Urgent" : "Running"}
        </span>
      </div>
    );
  }

  const finished = status === "draft_complete" || status === "archived";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-2.5">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          Draft Timer
        </p>
        <p className="font-mono text-xl font-bold tabular-nums text-slate-100">
          {finished ? "0:00" : formatDuration(limitMs)}
        </p>
      </div>
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
          finished
            ? "bg-slate-700 text-slate-300"
            : "bg-slate-700 text-amber-300"
        }`}
      >
        {finished ? "Complete" : "Paused"}
      </span>
    </div>
  );
}

/**
 * Renders the arena header with league identity, the draft timer, status, and
 * live round/pick info.
 *
 * @param props - {@link ArenaPanelProps}
 * @returns The header markup.
 */
function DraftHeader({
  goods,
  now,
  isOwner = false,
  onReset,
  resetting = false,
  onTogglePause,
  pausing = false,
}: ArenaPanelProps & {
  /** Whether the signed-in user owns the league (enables the reset action). */
  isOwner?: boolean;
  /** Invoked when the owner confirms a draft reset. */
  onReset?: () => void;
  /** True while the reset RPC is in flight. */
  resetting?: boolean;
  /** Invoked when the owner toggles the Pause/Play timer control. */
  onTogglePause?: () => void;
  /** True while the pause/resume RPC is in flight. */
  pausing?: boolean;
}) {
  const season = goods.season;
  const status = season?.status ?? "draft_pending";
  const slice = computeDraftSlice(goods);
  const isPaused = season?.draft_paused_at != null;
  const canTogglePause =
    !!isOwner && status === "draft_active" && !!onTogglePause;

  return (
    <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-slate-950/30">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{goods.league.name}</h1>
          <p className="mt-1 text-sm text-slate-400">
            Season {goods.season?.season_number ?? "—"}
            {" · "}
            {goods.settings?.total_rounds ?? "—"} rounds
            {goods.settings?.draft_format === "snake"
              ? " · Snake"
              : goods.settings?.draft_format === "set"
                ? " · Set"
                : ""}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <DraftTimer
            limitMinutes={goods.settings?.pick_time_limit_minutes ?? null}
            status={status}
            startedAt={season?.draft_pick_started_at ?? null}
            pausedAt={season?.draft_paused_at ?? null}
            now={now}
          />

          {canTogglePause && (
            <button
              type="button"
              onClick={onTogglePause}
              disabled={pausing}
              className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700/60 disabled:cursor-not-allowed disabled:opacity-40"
              title={isPaused ? "Resume the draft timer" : "Pause the draft timer"}
            >
              {pausing ? "..." : isPaused ? "Play" : "Pause"}
            </button>
          )}

          <span
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
              STATUS_STYLES[status] ?? STATUS_STYLES.draft_pending
            }`}
          >
            {STATUS_LABELS[status] ?? status}
          </span>

          {isOwner && onReset && season && (
            <button
              type="button"
              onClick={onReset}
              disabled={resetting || status === "draft_pending"}
              className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-950/70 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
              title="Return the draft to its pre-draft state"
            >
              {resetting ? "Resetting..." : "Reset Draft"}
            </button>
          )}
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
 * The pick board: a grid of player columns (in draft order) and round rows.
 * Each player's card sits in its own column; each round row holds that player's
 * Pokemon card once a pick lands, so the board shows the season's picks at a
 * glance. The on-clock column and current round are highlighted.
 */

/**
 * Resolves the dex id for a pick's pokemon id slug.
 */
function dexOf(pokemonId: string | null): number {
  return getDexNumber(pokemonId ?? "");
}

/**
 * Renders the player-pick board: one card per player (left to right in draft
 * order) with one row per round, Pokemon cards filling in as picks are made.
 * Players come from the league roster so the board renders before start.
 *
 * @param props - {@link ArenaPanelProps}
 * @returns The pick board markup.
 */
function PickBoardGrid({ goods, now }: ArenaPanelProps) {
  const slice = computeDraftSlice(goods);
  const totalRounds = goods.settings?.total_rounds ?? slice.totalRounds;
  const rounds = Array.from({ length: totalRounds }, (_, index) => index + 1);

  // Teams by owner so each player panel can show its drafted team name once the
  // season has started; players still render before start via their member row.
  const teamByOwner = useMemo(() => {
    const map = new Map<string, DraftTeam>();
    goods.teams.forEach((team) => {
      map.set(team.owner_user_id, team);
    });
    return map;
  }, [goods.teams]);

  // Order panels by the member's own draft slot, falling back to join order.
  const withPosition = goods.members.filter(
    (member) => member.draft_position !== null,
  );
  const ordered = (withPosition.length > 0 ? withPosition : goods.members).sort(
    (a, b) =>
      (a.draft_position ?? Number.MAX_SAFE_INTEGER) -
      (b.draft_position ?? Number.MAX_SAFE_INTEGER),
  );

  // Index picks by owner + round so each board slot resolves its card in O(1).
  const pickCellKey = (ownerUserId: string, round: number) =>
    `${ownerUserId}:${round}`;
  const pickByOwnerRound = useMemo(() => {
    const map = new Map<string, DraftPick>();
    goods.picks.forEach((pick) => {
      map.set(pickCellKey(pick.owner_user_id, pick.round_number), pick);
    });
    return map;
  }, [goods.picks]);

  // Index pool rows by pokemon slug so picked cards resolve the exact catalog
  // sprite id, typings, and tier the pool table uses (anniversary sprites etc.).
  const poolRowByPokemon = useMemo(() => {
    const map = new Map<string, DraftPoolRow>();
    goods.poolRows.forEach((row) => {
      map.set(row.pokemon_id, row);
    });
    return map;
  }, [goods.poolRows]);

  const onClockOwnerUserId = !slice.isOver
    ? slice.currentTeam?.owner_user_id ?? null
    : null;
  const mine = goods.members.find(
    (member) => member.user_id === goods.currentUserId,
  );

  // Overall pick number for a draft slot: snakes (reverse) every even round.
  const isSnake = (goods.settings?.draft_format ?? "snake") === "snake";
  const overallPickFor = (slot: number, round: number): number => {
    const numPlayers = Math.max(ordered.length, 1);
    const pickInRound =
      isSnake && round % 2 === 0 ? numPlayers - slot + 1 : slot;
    return (round - 1) * numPlayers + pickInRound;
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-slate-950/30">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
          Draft Board
        </h2>
        <span className="text-xs text-slate-500">
          {mine
            ? "You: " +
              (teamByOwner.get(mine.user_id)?.team_name ?? mine.display_name ?? "")
            : ""}
        </span>
      </div>

      {ordered.length === 0 ? (
        <div className="rounded-xl border border-slate-800 p-8 text-center text-sm text-slate-500">
          No players in this league yet.
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {ordered.map((member, index) => {
            const team = teamByOwner.get(member.user_id) ?? null;
            const isOnClock = onClockOwnerUserId === member.user_id;
            const currentRound = isOnClock ? slice.roundNumber : null;
            const panelName =
              team?.team_name ?? member.display_name ?? "Unnamed player";
            const salary =
              team && goods.settings?.enable_pokemon_costs
                ? getTeamSalary(goods, team.id)
                : null;

            return (
              <div
                key={member.user_id}
                className={`min-w-[13rem] flex-1 shrink-0 rounded-2xl border p-3 transition sm:min-w-[14rem] ${
                  isOnClock
                    ? "border-amber-400 bg-amber-500/10 shadow-lg shadow-amber-500/10"
                    : "border-slate-800 bg-slate-950/50"
                }`}
              >
                {/* Player card header */}
                <div className="flex items-center gap-2">
                  {member.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={member.avatar_url}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-full border border-slate-700 object-cover"
                    />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-amber-300">
                      {panelName.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-100">
                      {panelName}
                    </p>
                    <p className="truncate text-[10px] uppercase tracking-wider text-slate-500">
                      Pick #{member.draft_position ?? index + 1}
                      {member.user_id === goods.currentUserId ? " · You" : ""}
                    </p>
                    {salary && (
                      <p
                        className={`truncate font-mono text-xs font-semibold tabular-nums ${
                          salary.remaining < 0
                            ? "text-red-400"
                            : "text-emerald-300"
                        }`}
                      >
                        {salary.remaining}/{salary.budget} tokens
                      </p>
                    )}
                  </div>
                  {isOnClock && (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold uppercase text-amber-300">
                      On clock
                    </span>
                  )}
                </div>

                {/* One row per round; each holds the player's Pokemon card. */}
                <div className="mt-3 max-h-[22rem] space-y-1.5 overflow-y-auto pr-1">
                  {rounds.map((round) => {
                    const pick = pickByOwnerRound.get(
                      pickCellKey(member.user_id, round),
                    );
                    const isCurrentSlot = currentRound === round;
                    return (
                      <div
                        key={round}
                        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition ${
                          isCurrentSlot
                            ? "border-amber-400/70 bg-amber-500/10"
                            : pick
                              ? pick.is_pass
                                ? "border-slate-800 bg-slate-900/60"
                                : "border-slate-700 bg-slate-900"
                              : "border-slate-800/80 bg-slate-950/40"
                        }`}
                      >
                        <span className="w-7 shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          R{round}
                        </span>
                        {pick ? (
                          pick.is_pass ? (
                            <span className="text-xs font-medium text-slate-500">
                              Pass
                            </span>
                          ) : (
                            <>
                              <Sprite
                                spriteId={
                                  pick.pokemon_id
                                    ? (poolRowByPokemon.get(pick.pokemon_id)
                                        ?.spriteId ?? dexOf(pick.pokemon_id))
                                    : 0
                                }
                                name={pick.species_name ?? "Picked"}
                                size={28}
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium text-slate-100">
                                  {pick.species_name}
                                </p>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                                  {(
                                    [
                                      poolRowByPokemon.get(
                                        pick.pokemon_id ?? "",
                                      )?.type_primary,
                                      poolRowByPokemon.get(
                                        pick.pokemon_id ?? "",
                                      )?.type_secondary,
                                    ] as (string | null | undefined)[]
                                  )
                                    .filter(Boolean)
                                    .map((type) => (
                                      <span
                                        key={type}
                                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                          TYPE_STYLES[type ?? ""] ??
                                          "bg-slate-700 text-slate-200"
                                        }`}
                                      >
                                        {type}
                                      </span>
                                    ))}
                                  {pick.tier_value > 0 && (
                                    <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-bold text-slate-200">
                                      T{pick.tier_value}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </>
                          )
                        ) : (
                          <span className="text-[11px] font-medium text-slate-500">
                            Round {round} · Pick #
                            {overallPickFor(
                              member.draft_position ?? index + 1,
                              round,
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/*
 * NOTE: sprites in the board derive their dex id from the pick's pokemon_id
 * slug via the shared catalog helper; see the pool page for the same pattern.
 */

/*
 * The pool panel: a searchable/filterable/sortable table of the draftable pool,
 * mirroring the pool page. Each row offers a single action: draft the Pokemon
 * when it is the current user's turn (respecting the salary budget), or add it
 * to a chosen round of the priority list otherwise.
 */

type SortKey =
  | "dex"
  | "tier"
  | "bst"
  | "generation"
  | "hp"
  | "attack"
  | "defense"
  | "specialAttack"
  | "specialDefense"
  | "speed";
type SortDir = "asc" | "desc";

const SORT_LABELS: Record<SortKey, string> = {
  dex: "Dex",
  tier: "Tier",
  bst: "Total",
  generation: "Gen",
  hp: "HP",
  attack: "Atk",
  defense: "Def",
  specialAttack: "SpA",
  specialDefense: "SpD",
  speed: "Spe",
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
  const [sortKey, setSortKey] = useState<SortKey>("tier");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [tab, setTab] = useState<"table" | "tiers">("table");

  const typeOptions = useMemo(() => {
    const types = new Set<string>();
    goods.poolRows.forEach((row) => {
      if (row.type_primary) types.add(row.type_primary);
      if (row.type_secondary) types.add(row.type_secondary);
    });
    return [...types].sort();
  }, [goods.poolRows]);

  const picked = useMemo(
    () => new Set(goods.picks.map((pick) => pick.pokemon_id)),
    [goods.picks],
  );

  // Query and type-filtered rows shared by both the table and the tier list.
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return goods.poolRows.filter((row) => {
      if (q && !row.species_name.toLowerCase().includes(q)) return false;
      if (
        typeFilter &&
        ![row.type_primary, row.type_secondary].includes(typeFilter)
      )
        return false;
      return true;
    });
  }, [goods.poolRows, query, typeFilter]);

  const rows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      if (sortKey === "dex") return (a.dex - b.dex) * dir;
      if (sortKey === "tier") {
        const tierDelta = (a.tier_value - b.tier_value) * dir;
        if (tierDelta !== 0) return tierDelta;
        return (b.bst ?? 0) - (a.bst ?? 0);
      }
      if (sortKey === "bst") return ((a.bst ?? 0) - (b.bst ?? 0)) * dir;
      if (
        sortKey === "hp" ||
        sortKey === "attack" ||
        sortKey === "defense" ||
        sortKey === "specialAttack" ||
        sortKey === "specialDefense" ||
        sortKey === "speed"
      ) {
        const aStat = getPokemonDetailsBySlug(a.pokemon_id)?.stats?.[sortKey] ?? -1;
        const bStat = getPokemonDetailsBySlug(b.pokemon_id)?.stats?.[sortKey] ?? -1;
        return (aStat - bStat) * dir;
      }
      return (a.generation ?? "").localeCompare(b.generation ?? "") * dir;
    });
  }, [filteredRows, sortKey, sortDir]);

  // Groups the filtered rows into tier buckets (descending, unranked last) for
  // the Tier List tab, mirroring the draft pool page's tier list layout.
  const groupedByTier = useMemo(() => {
    const groups = new Map<number, DraftPoolRow[]>();
    filteredRows.forEach((row) => {
      const list = groups.get(row.tier_value) ?? [];
      list.push(row);
      groups.set(row.tier_value, list);
    });
    const tiers = [...groups.keys()].sort((a, b) =>
      a === 0 ? 1 : b === 0 ? -1 : b - a,
    );
    return tiers.map((tier) => ({
      tier,
      label: tier === 0 ? "Unranked" : `Tier ${tier}`,
      rows: groups.get(tier) ?? [],
    }));
  }, [filteredRows]);

  const mySalary = goods.myTeamId ? getTeamSalary(goods, goods.myTeamId) : null;
  // Set briefly true after a row drag ends, so a synthetic click after a drop
  // into the priority panel is not treated as a pick click.
  const rowDragEndedRecentlyRef = useRef(false);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // Whether this row can be drafted right now (must be the user's turn, the
  // Pokemon still in the pool, and affordable under the salary budget). Shared
  // by the table rows and the tier list cards.
  function canPickRow(row: DraftPoolRow): boolean {
    const isTaken = picked.has(row.pokemon_id);
    if (isTaken || goods.userRole === null) return false;
    if (!sliceOf(goods).isMyTurn) return false;
    return (
      mySalary?.remaining != null &&
      (mySalary.remaining >= row.tier_value ||
        !goods.settings?.enable_pokemon_costs)
    );
  }

  // Clicking a row/card while not freshly dragging requests a pick (the arena
  // validates turn/salary/picked state before showing the confirmation dialog).
  function handleRowClick(row: DraftPoolRow) {
    if (rowDragEndedRecentlyRef.current) return;
    if (canPickRow(row)) {
      actions.onPick(row.pokemon_id);
    }
  }

  // Seeds the drag payload so a pool row can be dropped into a priority round.
  // Picked Pokemon are still draggable (a no-op drop) since the row stays
  // visible for reference.
  function handlePoolDragStart(
    event: React.DragEvent<HTMLElement>,
    pokemonId: string,
  ) {
    event.dataTransfer.setData(DND_POKEMON, pokemonId);
    // copyMove so the target can pick either a copy (add) or move (reorder)
    // drop effect without the browser invalidating the drop.
    event.dataTransfer.effectAllowed = "copyMove";
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

      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3 text-sm">
        {(
          [
            { key: "table", label: "Table" },
            { key: "tiers", label: "Tiers" },
          ] as const
        ).map((tabItem) => (
          <button
            key={tabItem.key}
            type="button"
            onClick={() => setTab(tabItem.key)}
            className={`rounded-xl border px-4 py-2 font-medium transition ${
              tab === tabItem.key
                ? "border-amber-400 bg-amber-500/10 text-amber-200"
                : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600"
            }`}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      {tab === "table" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full divide-y divide-slate-800 text-center text-sm">
            <thead className="sticky top-0 z-10 bg-slate-900 text-slate-400">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Pokémon</th>
                <th className="px-4 py-3 text-center font-semibold">Type</th>
                <th className="px-4 py-3 text-center">
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
                <th className="px-4 py-3 text-center font-semibold">Abilities</th>
                <th className="px-2 py-3 text-center">
                  <button
                    type="button"
                    onClick={() => toggleSort("bst")}
                    className={`inline-flex items-center gap-1 font-semibold ${
                      sortKey === "bst" ? "text-amber-300" : ""
                    }`}
                  >
                    Total {sortKey === "bst" && (sortDir === "asc" ? "▲" : "▼")}
                  </button>
                </th>
                {(
                  [
                    { label: "HP", column: "hp" },
                    { label: "Atk", column: "attack" },
                    { label: "Def", column: "defense" },
                    { label: "SpA", column: "specialAttack" },
                    { label: "SpD", column: "specialDefense" },
                    { label: "Spe", column: "speed" },
                  ] as const
                ).map((stat) => (
                  <th key={stat.column} className="px-2 py-3 text-center">
                    <button
                      type="button"
                      onClick={() => toggleSort(stat.column as SortKey)}
                      className={`inline-flex items-center gap-1 font-semibold ${
                        sortKey === stat.column ? "text-amber-300" : ""
                      }`}
                    >
                      {stat.label}{" "}
                      {sortKey === stat.column && (sortDir === "asc" ? "▲" : "▼")}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 bg-slate-950/40">
              {rows.map((row) => {
                const isTaken = picked.has(row.pokemon_id);
                const canPick = canPickRow(row);
                const details = getPokemonDetailsBySlug(row.pokemon_id);
                const stats = details?.stats ?? null;
                return (
                  <tr
                    key={row.pokemon_id}
                    draggable
                    onDragStart={(event) =>
                      handlePoolDragStart(event, row.pokemon_id)
                    }
                    onDragEnd={() => {
                      rowDragEndedRecentlyRef.current = true;
                      window.setTimeout(() => {
                        rowDragEndedRecentlyRef.current = false;
                      }, 350);
                    }}
                    onClick={() => handleRowClick(row)}
                    className={`${
                      isTaken
                        ? "opacity-45"
                        : canPick
                          ? "cursor-pointer hover:bg-slate-800/50"
                          : "cursor-grab hover:bg-slate-800/50 active:cursor-grabbing"
                    }`}
                  >
                    <td className="px-4 py-2.5 text-left">
                      <div className="flex items-center justify-start gap-3">
                        <Sprite
                          spriteId={row.spriteId}
                          name={row.species_name}
                          size={40}
                        />
                        <span className="font-medium text-slate-100">
                          {row.species_name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap justify-center gap-1">
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
                      {row.tier_value > 0 ? row.tier_value : "—"}
                    </td>
                    <td className="max-w-[150px] px-2 py-2.5 text-slate-400">
                      {details && details.abilities.length > 0 ? (
                        <span className="flex flex-wrap items-center justify-center gap-1">
                          {details.abilities.map((ability) => (
                            <AbilityTooltip key={ability.name} slug={ability.name} />
                          ))}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-center tabular-nums text-slate-300">
                      {row.bst ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-center tabular-nums text-slate-300">
                      {stats?.hp ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-center tabular-nums text-slate-300">
                      {stats?.attack ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-center tabular-nums text-slate-300">
                      {stats?.defense ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-center tabular-nums text-slate-300">
                      {stats?.specialAttack ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-center tabular-nums text-slate-300">
                      {stats?.specialDefense ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-center tabular-nums text-slate-300">
                      {stats?.speed ?? "—"}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="px-4 py-10 text-center text-slate-500"
                  >
                    No Pokémon match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "tiers" && (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {groupedByTier.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center text-sm text-slate-400">
              No Pokémon match your filters.
            </div>
          ) : (
            <div className="space-y-6">
              {groupedByTier.map((group) => (
                <section
                  key={group.tier}
                  className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5"
                >
                  <h2 className="mb-4 text-lg font-semibold text-white">
                    {group.label}
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      {group.rows.length} Pokémon
                    </span>
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {group.rows.map((row) => {
                      const isTaken = picked.has(row.pokemon_id);
                      const canPick = canPickRow(row);
                      return (
                        <div
                          key={row.pokemon_id}
                          draggable
                          onDragStart={(event) =>
                            handlePoolDragStart(event, row.pokemon_id)
                          }
                          onDragEnd={() => {
                            rowDragEndedRecentlyRef.current = true;
                            window.setTimeout(() => {
                              rowDragEndedRecentlyRef.current = false;
                            }, 350);
                          }}
                          onClick={() => handleRowClick(row)}
                          className={`flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 transition ${
                            isTaken
                              ? "opacity-45"
                              : canPick
                                ? "cursor-pointer hover:border-amber-500/60 hover:bg-slate-900"
                                : "cursor-grab hover:border-slate-600 hover:bg-slate-900 active:cursor-grabbing"
                          }`}
                        >
                          <Sprite
                            spriteId={row.spriteId}
                            name={row.species_name}
                            size={44}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-100">
                              {row.species_name}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {[row.type_primary, row.type_secondary]
                                .filter(Boolean)
                                .map((type) => (
                                  <span
                                    key={type}
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                      TYPE_STYLES[type ?? ""] ??
                                      "bg-slate-700 text-slate-200"
                                    }`}
                                  >
                                    {type}
                                  </span>
                                ))}
                            </div>
                          </div>
                          <span className="shrink-0 text-xs font-semibold text-slate-400">
                            {row.bst != null ? `${row.bst} BST` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

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
 * The pick confirmation dialog: shown when a user clicks a pool row or priority
 * card while on the clock, asking them to confirm the draft pick before the
 * RPC runs. It resolves the candidate from the pool so sprites, typing, tier,
 * and BST always render from the same dataset the table uses.
 */

/**
 * Renders the confirmation overlay for a pending draft pick.
 *
 * @param props - The selected pool row, confirm/cancel callbacks, and a busy flag.
 * @returns The modal markup.
 */
function PickConfirm({
  row,
  isSaving,
  onConfirm,
  onCancel,
}: {
  /** The pool row the user wants to draft. */
  row: DraftPoolRow;
  /** True while the pick request is being submitted. */
  isSaving: boolean;
  /** Confirms the pick for the row's Pokemon. */
  onConfirm: () => void;
  /** Dismisses the dialog without picking. */
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl shadow-slate-950/60"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-white">Draft this Pokémon?</h2>
        <div className="mt-4 flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <Sprite spriteId={row.dex} name={row.species_name} size={56} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-slate-100">
              {row.species_name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {[row.type_primary, row.type_secondary]
                .filter(Boolean)
                .map((type) => (
                  <span
                    key={type}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      TYPE_STYLES[type ?? ""] ?? "bg-slate-700 text-slate-200"
                    }`}
                  >
                    {type}
                  </span>
                ))}
              {row.tier_value > 0 && (
                <span className="text-[10px] font-bold text-amber-300">
                  T{row.tier_value}
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">Total</p>
            <p className="font-mono text-lg font-bold text-slate-100">
              {row.bst ?? "—"}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            className="flex-1 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-bold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSaving}
            className="flex-1 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-40"
          >
            {isSaving ? "Picking..." : "Confirm draft"}
          </button>
        </div>
      </div>
    </div>
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
 * Renders the right priority panel: round buckets of the user's priority list.
 *
 * Cards are drag-and-drop surfaces: drag a pool Pokemon into any round to pin
 * it, drag a card within its round to reorder (topmost = highest priority),
 * drag a card to another round to move it, or drop a card on the panel's empty
 * space to remove it. Every change auto-saves to the user's account, and each
 * card shows the Pokemon's typing chips and tier.
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
  // Highlights the round/card under the cursor while a drag passes over, and
  // tracks an in-flight priority drag so the panel can hint at drag-out delete.
  const [overRound, setOverRound] = useState<number | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  const [draggingEntry, setDraggingEntry] = useState<string | null>(null);
  // The panel's DOM node, so a card released outside its bounds can be removed.
  const panelRef = useRef<HTMLElement | null>(null);
  // Set briefly true after a drag ends so a synthetic click fired by the
  // browser right after a drop isn't mistaken for a pick click.
  const dragEndedRecentlyRef = useRef(false);

  function handleCardDragStart(
    event: React.DragEvent<HTMLLIElement>,
    key: string,
  ) {
    event.dataTransfer.setData(DND_ENTRY, key);
    event.dataTransfer.effectAllowed = "move";
    setDraggingEntry(key);
  }

  // Called after the browser has resolved the drop: inside the panel the round
  // drop handlers already reordered/moved the card, and empty-panel drops were
  // already removed. This handles a release anywhere outside the panel bounds,
  // which plain HTML DnD has no drop target for.
  function handleCardDragEnd(event: React.DragEvent<HTMLLIElement>) {
    const { clientX, clientY } = event;
    const outside =
      clientX > 0 &&
      clientY > 0 &&
      panelRef.current != null &&
      !pointWithinRect(
        clientX,
        clientY,
        panelRef.current.getBoundingClientRect(),
      );
    if (outside && draggingEntry) {
      actions.onRemove(draggingEntry);
    }
    dragEndedRecentlyRef.current = true;
    window.setTimeout(() => {
      dragEndedRecentlyRef.current = false;
    }, 350);
    setDraggingEntry(null);
    setOverCard(null);
    setOverRound(null);
  }

  // Clicking a card while not dragging requests a pick (the arena validates
  // turn/salary/picked state before showing the confirmation dialog). A click
  // shortly after a drag is treated as the drag's synthetic cleanup rather
  // than a genuine pick intent.
  function handleCardClick(entry: DraftPriorityEntry) {
    if (dragEndedRecentlyRef.current) return;
    actions.onPick(entry.pokemon_id);
  }

  function handleRoundDragOver(
    event: React.DragEvent<HTMLDivElement>,
    round: number,
  ) {
    event.preventDefault();
    // Match the drop effect to the payload the target accepts so the browser
    // doesn't reject the drop (pool copies in, priority cards move).
    event.dataTransfer.dropEffect = isPoolDrag(event) ? "copy" : "move";
    setOverRound(round);
  }

  // A drop anywhere on a round bucket: a pool Pokemon gets appended to the
  // round, a dragged card is moved into the round (appended at the end).
  function handleRoundDrop(
    event: React.DragEvent<HTMLDivElement>,
    round: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setOverRound(null);
    setDraggingEntry(null);
    const entryKeyData = event.dataTransfer.getData(DND_ENTRY);
    if (entryKeyData) {
      const list = byRound.get(round) ?? [];
      actions.onMoveEntry(entryKeyData, round, list.length);
      return;
    }
    const pokemonId = event.dataTransfer.getData(DND_POKEMON);
    if (pokemonId) {
      actions.onAddToRound(pokemonId, round);
    }
  }

  // A drop on an individual card: reorder/move relative to that card's slot.
  function handleCardDrop(
    event: React.DragEvent<HTMLLIElement>,
    entry: DraftPriorityEntry,
    index: number,
    round: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setOverRound(null);
    setOverCard(null);
    setDraggingEntry(null);
    const entryKeyData = event.dataTransfer.getData(DND_ENTRY);
    if (entryKeyData) {
      // Account for the dragged card vacating its slot when it is above the
      // target in the same round (removal before insertion shifts indices).
      let targetIndex = index;
      const sourceRound = Number(entryKeyData.split(":")[0]);
      if (sourceRound === round) {
        const sourceList = byRound.get(round) ?? [];
        const sourceIndex = sourceList.findIndex(
          (candidate) => entryKey(candidate) === entryKeyData,
        );
        if (sourceIndex >= 0 && sourceIndex < index) {
          targetIndex -= 1;
        }
      }
      actions.onMoveEntry(entryKeyData, round, targetIndex);
      return;
    }
    const pokemonId = event.dataTransfer.getData(DND_POKEMON);
    if (pokemonId) {
      actions.onAddToRound(pokemonId, round);
    }
  }

  // A drop on the panel's empty space (outside every round) deletes the card.
  function handlePanelDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOverRound(null);
    setOverCard(null);
    setDraggingEntry(null);
    const entryKeyData = event.dataTransfer.getData(DND_ENTRY);
    if (entryKeyData) {
      actions.onRemove(entryKeyData);
    }
  }

  return (
    <section
      ref={panelRef}
      className="flex h-full min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl shadow-slate-950/30"
    >
      <div className="flex items-center justify-between border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
          Priority List
        </h2>
        <span className="text-xs text-slate-500">
          {draggingEntry
            ? "Drop on empty space to remove"
            : "Topmost = highest priority"}
        </span>
      </div>

      <div
        className="min-h-0 flex-1 space-y-6 overflow-auto p-4"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handlePanelDrop}
      >
        {rounds.map((round) => {
          const list = byRound.get(round) ?? [];
          return (
            <div
              key={round}
              onDragOver={(event) => handleRoundDragOver(event, round)}
              onDrop={(event) => handleRoundDrop(event, round)}
            >
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
                <div
                  onDragOver={(event) => handleRoundDragOver(event, round)}
                  onDrop={(event) => handleRoundDrop(event, round)}
                  className={`mt-2 rounded-xl border border-dashed p-3 text-xs text-slate-600 transition ${
                    overRound === round
                      ? "border-amber-400 bg-amber-500/10 text-amber-200"
                      : "border-slate-800"
                  }`}
                >
                  Empty — drag Pokémon from the pool into this round.
                </div>
              ) : (
                <ol className="mt-2 space-y-1.5">
                  {list.map((entry, index) => (
                    <li
                      key={entryKey(entry)}
                      draggable
                      onDragStart={(event) =>
                        handleCardDragStart(event, entryKey(entry))
                      }
                      onDragEnd={handleCardDragEnd}
                      onClick={() => handleCardClick(entry)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = isPoolDrag(event)
                          ? "copy"
                          : "move";
                        setOverCard(entryKey(entry));
                        setOverRound(round);
                      }}
                      onDrop={(event) =>
                        handleCardDrop(event, entry, index, round)
                      }
                      className={`flex cursor-grab items-center gap-2 rounded-xl border bg-slate-950/50 p-2 transition active:cursor-grabbing ${
                        overCard === entryKey(entry)
                          ? "border-amber-400 bg-amber-500/10"
                          : overRound === round
                            ? "border-slate-500"
                            : "border-slate-800 hover:border-slate-600"
                      }`}
                    >
                      <Sprite
                        spriteId={entry.spriteId}
                        name={entry.species_name}
                        size={36}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
                            {entry.species_name}
                          </p>
                          <div className="flex shrink-0 items-center gap-1">
                            {[entry.type_primary, entry.type_secondary]
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
                            {entry.tier_value > 0 && (
                              <span className="text-xs font-bold text-amber-300">
                                T{entry.tier_value}
                              </span>
                            )}
                            {entry.bst != null && (
                              <span className="text-xs font-semibold text-slate-400">
                                {entry.bst} BST
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
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
        <div className="flex flex-col items-center gap-3">
          {entries.length > 0 && (
            <button
              type="button"
              onClick={actions.onClear}
              className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-1.5 text-xs font-bold text-red-300 transition hover:bg-red-900/50"
            >
              Clear List
            </button>
          )}
          <p className="text-center text-xs text-slate-500">
            {isSaving
              ? "Saving…"
              : "Changes save automatically to your account."}
          </p>
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
  return left.every(
    (entry, index) => entryKey(entry) === entryKey(right[index]),
  );
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

/** Custom MIME type carrying a pool `pokemon_id` on the drag payload. */
const DND_POKEMON = "application/x-draft-pokemon-id";

/** Custom MIME type carrying a priority entry key on the drag payload. */
const DND_ENTRY = "application/x-draft-priority-key";

// Whether the in-flight drag carries a pool Pokemon (copy) rather than a
// priority card (move). Must match on the source's `effectAllowed`.
function isPoolDrag(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.items).some(
    (item) => item.kind === "string" && item.type === DND_POKEMON,
  );
}

// Whether a cursor point falls inside a CSS rect (used to detect drag-out
// deletes without dedicated drop targets).
function pointWithinRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
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
  const [busyReset, setBusyReset] = useState(false);
  const [busyPause, setBusyPause] = useState(false);
  // Pokemon id awaiting the pick confirmation dialog, or null when none.
  const [pendingPickId, setPendingPickId] = useState<string | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const prevDeadlineRef = useRef<number | null>(null);
  const warnedRef = useRef(false);
  // Overall pick number whose timer the client has already asked the engine to
  // resolve, so the one-second tick cannot re-fire resolve attempts for the
  // same turn while a refresh is in flight.
  const resolvingTurnRef = useRef<number | null>(null);
  // Mirror of the priority list so async callbacks (save/poll) never read a
  // stale closure, plus a flag tracking unsaved local edits so server polls
  // don't clobber in-progress add/remove/reorder work.
  const priorityEntriesRef = useRef<DraftPriorityEntry[]>([]);
  const priorityDirtyRef = useRef(false);
  // Serializes overlapping priority saves and lets only the newest one refresh
  // the panel after it completes.
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveVersionRef = useRef(0);

  // Adopts a freshly loaded server snapshot only when the user has no unsaved
  // local edits, so the 5s poll cannot undo in-progress changes.
  const applyServerState = useCallback(
    (state: {
      priority: DraftPriorityEntry[];
      roundFlags: Map<number, { autoPick: boolean; skipPick: boolean }>;
    }) => {
      if (priorityDirtyRef.current) return;
      priorityEntriesRef.current = state.priority;
      setPriorityEntries(state.priority);
      setRoundFlags(state.roundFlags);
    },
    [],
  );

  // Reloads the full draft state after a pick, timer resolution, or save, using
  // the same server-state adoption path as the poll.
  const refreshGoods = useCallback(async () => {
    const next = await loadDraftData(leagueId);
    setGoods(next);
    applyServerState({
      priority: next.priority,
      roundFlags: next.roundFlags,
    });
    setError(null);
  }, [leagueId, applyServerState]);

  const slice = useMemo(
    () => (goods ? computeDraftSlice(goods) : null),
    [goods],
  );

  // The on-turn player's remaining salary (unlimited when costs are disabled).
  const myRemaining = useMemo(() => {
    if (!goods?.myTeamId || !goods.settings?.enable_pokemon_costs) {
      return null;
    }
    return getTeamSalary(goods, goods.myTeamId).remaining;
  }, [goods]);

  // The pool row backing the pending pick confirmation dialog, if any.
  const pendingPickRow = useMemo(
    () =>
      goods && pendingPickId
        ? (goods.poolRows.find((row) => row.pokemon_id === pendingPickId) ??
          null)
        : null,
    [goods, pendingPickId],
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
        applyServerState({
          priority: next.priority,
          roundFlags: next.roundFlags,
        });
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
  }, [leagueId, applyServerState]);

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

  // Pick-flow driver: once the on-clock deadline passes (or the on-turn player
  // has no salary left with costs enabled), ask the database to resolve the
  // turn so the timer resets and the pick passes on. The engine handles the
  // auto-pick/pass decision, the zero-token skip, and completion, so this only
  // needs to fire once per turn; benign errors (another client advanced the
  // draft first) clear the guard and retry on the next tick. While the owner
  // has paused the timer no resolution fires at all.
  useEffect(() => {
    if (
      !goods ||
      goods.season?.status !== "draft_active" ||
      goods.season?.draft_paused_at != null ||
      !slice ||
      slice.isOver ||
      slice.overallPick === resolvingTurnRef.current
    ) {
      return;
    }

    const expired = deadline != null && now >= deadline;
    const outOfTokens =
      myRemaining != null &&
      slice.isMyTurn &&
      goods.settings?.enable_pokemon_costs &&
      myRemaining <= 0;

    // Round-level flags resolve immediately on my turn: skip-pick passes right
    // away, and auto-pick fires right away even when the round's priority list
    // is empty (the engine falls back to the best available pool Pokemon).
    const myRoundFlag = slice.isMyTurn
      ? (goods.roundFlags.get(slice.roundNumber) ?? null)
      : null;
    const flagImmediate =
      slice.isMyTurn &&
      myRoundFlag != null &&
      (myRoundFlag.skipPick || myRoundFlag.autoPick);

    if (!expired && !outOfTokens && !flagImmediate) {
      return;
    }

    // Guard against double-firing for the same turn. This effect re-runs every
    // tick (now is a dependency), so the guard — not a cleanup — is what keeps
    // a single in-flight resolve: a cleanup would cancel the just-issued RPC on
    // the next tick, stranding the guard and freezing the draft at 0:00 until a
    // manual refresh. Success/error paths release the guard, and a 4s watchdog
    // force-releases it even if the RPC never settles, so the next tick can
    // always retry.
    resolvingTurnRef.current = slice.overallPick;
    const run = resolveDraftTimeout(goods.league.id, false)
      .then(async (result) => {
        if (result.status === "not_due") {
          return;
        }
        await refreshGoods();
      })
      .catch(() => {
        // Transport/DB error: the guard watchdog clears it and the next tick
        // (or the server heartbeat) retries.
      });
    const watchdog = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 4000);
      timeout.unref?.();
    });
    void Promise.race([run, watchdog]).finally(() => {
      resolvingTurnRef.current = null;
    });
  }, [goods, slice, deadline, now, myRemaining, refreshGoods]);

  // Opens the confirmation dialog for a pending pick, guarded to only when the
  // Pokemon is a valid, unpicked, affordable choice on the user's turn.
  function requestPick(pokemonId: string | null) {
    if (!goods || busyPick || !pokemonId) return;
    const row = goods.poolRows.find(
      (candidate) => candidate.pokemon_id === pokemonId,
    );
    if (!row) return;
    const expensesOn = goods.settings?.enable_pokemon_costs;
    const salary = goods.myTeamId ? getTeamSalary(goods, goods.myTeamId) : null;
    const affordable =
      !expensesOn || (salary?.remaining ?? 0) >= row.tier_value;
    const slice = computeDraftSlice(goods);
    const alreadyPicked = goods.picks.some(
      (pick) => pick.pokemon_id === pokemonId,
    );
    if (
      !slice.isMyTurn ||
      slice.isOver ||
      alreadyPicked ||
      !affordable ||
      goods.userRole === null
    ) {
      return;
    }
    setPendingPickId(pokemonId);
  }

  async function handlePick(pokemonId: string | null) {
    if (!goods || busyPick) return;
    setBusyPick(true);
    setPendingPickId(null);
    try {
      await submitDraftPick(goods.league.id, pokemonId);
      await refreshGoods();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pick failed.");
    } finally {
      setBusyPick(false);
    }
  }

  async function handleResetDraft() {
    if (!goods || busyReset) return;
    const confirmed = window.confirm(
      "Reset the draft to its pre-draft state? This clears all picks, rosters, and the draft order for the current season.",
    );
    if (!confirmed) return;
    setBusyReset(true);
    setError(null);
    try {
      await resetDraft(goods.league.id);
      await refreshGoods();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reset the draft.");
    } finally {
      setBusyReset(false);
    }
  }

  async function handleTogglePause() {
    if (!goods || busyPause) return;
    setBusyPause(true);
    setError(null);
    try {
      const resuming = goods.season?.draft_paused_at != null;
      await setDraftPaused(goods.league.id, !resuming);
      await refreshGoods();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update the draft timer.");
    } finally {
      setBusyPause(false);
    }
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
        type_primary: poolRow?.type_primary ?? null,
        type_secondary: poolRow?.type_secondary ?? null,
        bst: poolRow?.bst ?? null,
        auto_pick: false,
        skip_pick: false,
        spriteId: poolRow?.spriteId ?? 0,
      },
    ];
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    priorityDirtyRef.current = true;
    void handleSave(next);
  }

  function handleMoveEntry(
    key: string,
    targetRound: number,
    targetIndex: number,
  ) {
    const current = priorityEntriesRef.current;
    const [sourceRoundText] = key.split(":");
    const sourceRound = Number(sourceRoundText);
    const group = current.filter((entry) => entry.round_number === sourceRound);
    const idx = group.findIndex((entry) => entryKey(entry) === key);
    if (idx < 0) return;

    // Build the target round's list (minus the moved entry), then splice the
    // moved entry into the target position (clamped to the list bounds).
    const moved = group[idx];
    const targetList = current.filter(
      (entry) => entry.round_number === targetRound && entryKey(entry) !== key,
    );
    targetList.splice(
      Math.max(0, Math.min(targetIndex, targetList.length)),
      0,
      {
        ...moved,
        round_number: targetRound,
      },
    );

    // Reassemble in round order so each round's cards stay contiguous and
    // ordered for the panel's grouping.
    const others = current.filter((entry) => entryKey(entry) !== key);
    const next = others
      .filter((entry) => entry.round_number !== targetRound)
      .concat(targetList);
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    priorityDirtyRef.current = true;
    void handleSave(next);
  }

  function handleRemove(key: string) {
    const next = priorityEntriesRef.current.filter(
      (entry) => entryKey(entry) !== key,
    );
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    priorityDirtyRef.current = true;
    void handleSave(next);
  }

  function handleClear() {
    const next: DraftPriorityEntry[] = [];
    priorityEntriesRef.current = next;
    setPriorityEntries(next);
    priorityDirtyRef.current = true;
    void handleSave(next);
  }

  async function handleSetRoundFlags(
    roundNumber: number,
    autoPick: boolean,
    skipPick: boolean,
  ) {
    try {
      await setPriorityRoundFlags(leagueId, roundNumber, autoPick, skipPick);
      setRoundFlags((current) => {
        const next = new Map(current);
        next.set(roundNumber, { autoPick, skipPick });
        return next;
      });
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
        .then(() =>
          savePriorityList(goods.league.id, payload).then(() => undefined),
        )
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
        <DraftHeader
          goods={goods}
          now={now}
          isOwner={goods.league.owner_id === goods.currentUserId}
          onReset={() => void handleResetDraft()}
          resetting={busyReset}
          onTogglePause={() => void handleTogglePause()}
          pausing={busyPause}
        />

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

        <PickBoardGrid goods={goods} now={now} />

        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[2.2fr_1fr]">
          <PoolPanel
            goods={goods}
            now={now}
            actions={{
              onPick: (pokemonId) => requestPick(pokemonId),
            }}
          />
          <div className="lg:sticky lg:top-0 lg:max-h-screen">
            <PriorityPanel
              goods={goods}
              now={now}
              entries={priorityEntries}
              error={priorityError}
              isSaving={isSaving}
              roundFlags={roundFlags}
              actions={{
                onAddToRound: (pokemonId, roundNumber) =>
                  handleAddToPriority(pokemonId, roundNumber),
                onMoveEntry: (key, targetRound, targetIndex) =>
                  handleMoveEntry(key, targetRound, targetIndex),
                onPick: (pokemonId) => requestPick(pokemonId),
                onSetRoundFlags: (roundNumber, autoPick, skipPick) =>
                  void handleSetRoundFlags(roundNumber, autoPick, skipPick),
                onRemove: (key) => handleRemove(key),
                onClear: () => handleClear(),
                onClearError: () => setPriorityError(null),
              }}
            />
          </div>
        </div>

        {pendingPickRow && (
          <PickConfirm
            row={pendingPickRow}
            isSaving={busyPick}
            onConfirm={() => void handlePick(pendingPickRow.pokemon_id)}
            onCancel={() => setPendingPickId(null)}
          />
        )}
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
