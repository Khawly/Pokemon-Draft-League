/*
 * Pokémon page for the Pokemon Draft League.
 *
 * Implements spec section 11. Lists every free agent (each Pokémon in the
 * season's draft pool that is not currently on any team) with a Table/Tiers
 * tab, a "Find Pokemon" search box, and a per-row pickup control: `+` starts a
 * pending add that confirms the Pokémon's cost (tier plus transaction cost when
 * enabled) and the projected balance after the purchase before the
 * `pickup_roster_pokemon` RPC claims it; `-` cancels the pending add. The right
 * column shows the user's team transaction history in stack order (newest
 * first). Pickup is only available once the draft is complete and the user owns
 * a team.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { supabase } from "@/lib/supabase/client";
import { AbilityTooltip } from "@/components/ability-tooltip";
import { getSpriteUrl } from "@/lib/pokeapi";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import {
  getPickupCost,
  canAffordPickup,
  getPokemonSalary,
  loadPokemonPageData,
  pickupRosterPokemon,
  type PokemonGoods,
  type PokemonPoolRow,
} from "@/lib/supabase/pokemon";

/** LocalStorage key used by the top nav to persist the selected league. */
const SELECTED_LEAGUE_STORAGE_KEY = "pokemon-draft-league:selected-league";

/** Type badge colors keyed by normalized type name (matches the team page). */
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
 * Wraps the Pokémon page in a Suspense boundary to satisfy Next.js's
 * client-side streaming requirement for `useSearchParams`.
 *
 * @returns The Pokémon page with a loading fallback.
 */
export default function PokemonPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading free agents...
          </div>
        </main>
      }
    >
      <PokemonPageRoute />
    </Suspense>
  );
}

/**
 * Bridge component that reads the search params inside the Suspense boundary.
 *
 * @returns The Pokémon page content.
 */
function PokemonPageRoute() {
  const searchParams = useSearchParams();
  return <PokemonPageContent searchParams={searchParams} />;
}

/**
 * Renders a species/forme sprite, or a placeholder when the id is unknown.
 *
 * @param props - Sprite id, alt text, and pixel size.
 * @returns The image or placeholder element.
 */
function Sprite({
  spriteId,
  name,
  size,
}: {
  /** Sprite id used to build the sprite URL (dex or 10001+ form id). */
  spriteId: number;
  /** Alt text for the image. */
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

/** Renders a type badge for a PokeAPI type name. */
function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
        TYPE_STYLES[type] ?? "bg-slate-700 text-slate-100"
      }`}
    >
      {type}
    </span>
  );
}

/**
 * Labels a tier value for display; there is no upper bound, so any positive
 * tier renders as "Tier N" and untiered as "Unranked".
 *
 * @param tier - The tier integer.
 * @returns The display label.
 */
function tierLabel(tier: number): string {
  return tier === 0 ? "Unranked" : `Tier ${tier}`;
}

/**
 * Formats a nullable timestamp for the transaction history rows.
 *
 * @param value - The ISO timestamp, or null.
 * @returns A readable local date/time string, or "—" when null.
 */
function formatDateTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Maps a ledger action to a short display label.
 *
 * @param action - The transaction action.
 * @returns A human-readable label.
 */
function actionLabel(
  action: "added" | "dropped" | "trade_in" | "trade_out",
): string {
  switch (action) {
    case "added":
      return "Added";
    case "dropped":
      return "Released";
    case "trade_in":
      return "Trade in";
    case "trade_out":
      return "Trade out";
  }
}

/** Sort keys supported by the free-agent table. */
type PokemonSortKey =
  | "name"
  | "type"
  | "tier"
  | "abilities"
  | "bst"
  | "hp"
  | "attack"
  | "defense"
  | "specialAttack"
  | "specialDefense"
  | "speed";

/** Default direction for a freshly selected column (text asc, numeric desc). */
const DEFAULT_SORT_DIR: Record<PokemonSortKey, "asc" | "desc"> = {
  name: "asc",
  type: "asc",
  abilities: "asc",
  tier: "desc",
  bst: "desc",
  hp: "desc",
  attack: "desc",
  defense: "desc",
  specialAttack: "desc",
  specialDefense: "desc",
  speed: "desc",
};

/**
 * Compares two free-agent rows for a sort key.
 *
 * Numeric columns compare by value (missing stats treat as 0); text columns
 * compare by their visible content, with type and abilities joined for the
 * comparison. Applies the sort direction and relies on a stable name
 * tiebreaker in the caller.
 *
 * @param a - The first row.
 * @param b - The second row.
 * @param key - The column being sorted.
 * @param dir - The sort direction.
 * @returns Negative when a sorts first, positive when b sorts first, else 0.
 */
function compareRows(
  a: PokemonPoolRow,
  b: PokemonPoolRow,
  key: PokemonSortKey,
  dir: "asc" | "desc",
): number {
  let base: number;
  switch (key) {
    case "name":
      base = a.name.localeCompare(b.name);
      break;
    case "type":
      base = a.types.join(" ").localeCompare(b.types.join(" "));
      break;
    case "abilities": {
      const left = a.abilities ?? [];
      const right = b.abilities ?? [];
      base =
        left.length - right.length ||
        left
          .map((ability) => ability.name)
          .join(" ")
          .localeCompare(right.map((ability) => ability.name).join(" "));
      break;
    }
    case "tier":
      base = a.tier_value - b.tier_value;
      break;
    case "bst":
      base = (a.bst ?? 0) - (b.bst ?? 0);
      break;
    case "hp":
      base = (a.stats?.hp ?? 0) - (b.stats?.hp ?? 0);
      break;
    case "attack":
      base = (a.stats?.attack ?? 0) - (b.stats?.attack ?? 0);
      break;
    case "defense":
      base = (a.stats?.defense ?? 0) - (b.stats?.defense ?? 0);
      break;
    case "specialAttack":
      base = (a.stats?.specialAttack ?? 0) - (b.stats?.specialAttack ?? 0);
      break;
    case "specialDefense":
      base = (a.stats?.specialDefense ?? 0) - (b.stats?.specialDefense ?? 0);
      break;
    case "speed":
      base = (a.stats?.speed ?? 0) - (b.stats?.speed ?? 0);
      break;
  }
  return dir === "asc" ? base : -base;
}

/**
 * Renders a clickable column header that toggles the free-agent table sort.
 *
 * Clicking the active column flips its direction; clicking a new column selects
 * it with {@link DEFAULT_SORT_DIR}'s direction for that column.
 *
 * @param props - The label, active sort state, this column's sort key, the
 *   click handler, and a text alignment override.
 * @returns The sortable header cell.
 */
function SortableTh({
  label,
  sortKey,
  sortDir,
  column,
  onSort,
  align = "center",
}: {
  /** Visible header label. */
  label: string;
  /** Currently active sort key. */
  sortKey: PokemonSortKey;
  /** Current sort direction. */
  sortDir: "asc" | "desc";
  /** The sort key this header controls. */
  column: PokemonSortKey;
  /** Called with the column key when the header is clicked. */
  onSort: (column: PokemonSortKey) => void;
  /** Text alignment for this header. */
  align?: "left" | "center";
}) {
  const active = sortKey === column;
  const alignClass = align === "left" ? "text-left" : "text-center";
  return (
    <th scope="col" className={`px-3 py-3 font-semibold ${alignClass}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`select-none whitespace-nowrap hover:text-slate-100 ${
          active ? "text-amber-300" : ""
        }`}
        title={`Sort by ${label}`}
      >
        {label}
        <span className="ml-1 text-slate-600">
          {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

/**
 * Renders the free-agent pickup table (spec §11).
 *
 * Shows sprite/name, types, abilities, BST, the six base stats, and a
 * `+`/`-` pickup control per row. Any column header can be clicked to sort the
 * rows; the active column shows a direction arrow.
 * Clicking `+` starts a pending add (opening the cost/balance confirmation in
 * the parent); `-` cancels it. Other controls are disabled while a pick is
 * pending or pickups are unavailable.
 */
function FreeAgentTable({
  rows,
  pendingPokemonId,
  disabled,
  busy,
  sortKey,
  sortDir,
  onSort,
  onAdd,
  onCancel,
  canAfford,
}: {
  /** Free-agent rows to display (already filtered/sorted). */
  rows: PokemonPoolRow[];
  /** The row whose add is currently pending, if any. */
  pendingPokemonId: string | null;
  /** When true, the pickup control is disabled entirely (no team / wrong phase). */
  disabled: boolean;
  /** When true, an RPC is running; controls are disabled. */
  busy: boolean;
  /** Currently active sort key. */
  sortKey: PokemonSortKey;
  /** Current sort direction. */
  sortDir: "asc" | "desc";
  /** Called with a column key when its header is clicked. */
  onSort: (column: PokemonSortKey) => void;
  /** Called with a row when its `+` control is clicked. */
  onAdd: (row: PokemonPoolRow) => void;
  /** Called with a row when its `-` control is clicked. */
  onCancel: (row: PokemonPoolRow) => void;
  /** Per-row affordability gate; rows this rejects have `+` disabled. */
  canAfford: (row: PokemonPoolRow) => boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
        No free agents found. The pool may be empty or every Pokémon is already
        on a team.
      </p>
    );
  }

  return (
    <div className="mt-5 overflow-x-auto rounded-xl border border-slate-800">
      <table className="min-w-full divide-y divide-slate-800 text-center text-sm">
        <thead className="bg-slate-950 text-slate-300">
          <tr>
            <SortableTh label="Pokémon" column="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
            <SortableTh label="Type" column="type" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="Tier" column="tier" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="Abilities" column="abilities" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="Total" column="bst" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="HP" column="hp" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="Atk" column="attack" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="Def" column="defense" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="SpA" column="specialAttack" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="SpD" column="specialDefense" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortableTh label="Spe" column="speed" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <th scope="col" className="px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800 bg-slate-900">
          {rows.map((row) => {
            const isPending = pendingPokemonId === row.pokemon_id;
            const affordable = isPending ? true : canAfford(row);
            return (
              <tr key={row.pokemon_id} className="hover:bg-slate-800/80">
                <td className="px-3 py-2 text-left">
                  <div className="flex items-center justify-start gap-2">
                    <Sprite
                      spriteId={row.spriteId}
                      name={row.name}
                      size={40}
                    />
                    <span className="whitespace-nowrap font-medium text-slate-100">
                      {row.name}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap items-center justify-center gap-1">
                    {row.types.length > 0 ? (
                      row.types.map((type) => (
                        <TypeBadge key={type} type={type} />
                      ))
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-200">
                  {row.tier_value}
                </td>
                <td className="max-w-[180px] px-3 py-2 text-slate-300">
                  {row.abilities && row.abilities.length > 0 ? (
                    <span className="flex flex-wrap items-center justify-center gap-1">
                      {row.abilities.map((ability) => (
                        <AbilityTooltip key={ability.name} slug={ability.name} />
                      ))}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.bst ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.stats?.hp ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.stats?.attack ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.stats?.defense ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.stats?.specialAttack ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.stats?.specialDefense ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.stats?.speed ?? "—"}
                </td>
                <td className="px-3 py-2 text-center">
                  {isPending ? (
                    <button
                      type="button"
                      onClick={() => onCancel(row)}
                      disabled={busy}
                      className="rounded-lg border border-red-700 bg-red-950/60 px-2.5 py-1 text-sm font-bold text-red-300 transition hover:border-red-500 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Cancel pending add"
                      aria-label={`Cancel adding ${row.name}`}
                    >
                      −
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onAdd(row)}
                      disabled={disabled || busy || pendingPokemonId !== null || !affordable}
                      className="rounded-lg border border-emerald-700 bg-emerald-950/60 px-2.5 py-1 text-sm font-bold text-emerald-300 transition hover:border-emerald-500 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                      title={affordable || disabled ? "Add to your roster" : "Not enough tokens for this pickup"}
                      aria-label={`Add ${row.name}`}
                    >
                      +
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Renders the tier-list view of the free agent pool.
 *
 * Groups the same rows by tier, highest first, with unranked Pokémon last
 * (mirroring the pool page's tier view). Each card keeps the `+`/`-` pickup
 * control so a pickup can be started from either tab.
 */
function TierListView({
  rows,
  pendingPokemonId,
  disabled,
  busy,
  onAdd,
  onCancel,
  canAfford,
}: {
  /** Free-agent rows to display (already filtered). */
  rows: PokemonPoolRow[];
  /** The row whose add is currently pending, if any. */
  pendingPokemonId: string | null;
  /** When true, the pickup control is disabled entirely. */
  disabled: boolean;
  /** When true, an RPC is running; controls are disabled. */
  busy: boolean;
  /** Called with a row when its `+` control is clicked. */
  onAdd: (row: PokemonPoolRow) => void;
  /** Called with a row when its `-` control is clicked. */
  onCancel: (row: PokemonPoolRow) => void;
  /** Per-row affordability gate; rows this rejects have `+` disabled. */
  canAfford: (row: PokemonPoolRow) => boolean;
}) {
  const groups = useMemo(() => {
    const byTier = new Map<number, PokemonPoolRow[]>();
    for (const row of rows) {
      const list = byTier.get(row.tier_value) ?? [];
      list.push(row);
      byTier.set(row.tier_value, list);
    }
    // Within each tier, list strongest total stats first (unranked BST sorts
    // last as zero).
    for (const list of byTier.values()) {
      list.sort((a, b) => (b.bst ?? 0) - (a.bst ?? 0));
    }
    return [...byTier.entries()].sort((a, b) =>
      a[0] === 0 ? 1 : b[0] === 0 ? -1 : b[0] - a[0],
    );
  }, [rows]);

  if (rows.length === 0) {
    return (
      <p className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
        No free agents found. The pool may be empty or every Pokémon is already
        on a team.
      </p>
    );
  }

  return (
    <div className="mt-5 space-y-6">
      {groups.map(([tier, groupRows]) => (
        <section key={tier} className="rounded-xl border border-slate-800">
          <h3 className="border-b border-slate-800 bg-slate-950/60 px-4 py-3 text-sm font-semibold text-amber-300">
            {tierLabel(tier)}
          </h3>
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {groupRows.map((row) => {
              const isPending = pendingPokemonId === row.pokemon_id;
              const affordable = isPending ? true : canAfford(row);
              return (
                <div
                  key={row.pokemon_id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950/60 p-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Sprite
                      spriteId={row.spriteId}
                      name={row.name}
                      size={40}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-100">
                        {row.name}
                      </p>
                      <span className="flex flex-wrap items-center gap-1">
                        {row.types.length > 0 ? (
                          row.types.map((type) => (
                            <TypeBadge key={type} type={type} />
                          ))
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </span>
                    </div>
                  </div>
                  {isPending ? (
                    <button
                      type="button"
                      onClick={() => onCancel(row)}
                      disabled={busy}
                      className="rounded-lg border border-red-700 bg-red-950/60 px-2.5 py-1 text-sm font-bold text-red-300 transition hover:border-red-500 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Cancel pending add"
                      aria-label={`Cancel adding ${row.name}`}
                    >
                      −
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onAdd(row)}
                      disabled={disabled || busy || pendingPokemonId !== null || !affordable}
                      className="rounded-lg border border-emerald-700 bg-emerald-950/60 px-2.5 py-1 text-sm font-bold text-emerald-300 transition hover:border-emerald-500 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                      title={affordable || disabled ? "Add to your roster" : "Not enough tokens for this pickup"}
                      aria-label={`Add ${row.name}`}
                    >
                      +
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Renders the pending-add confirmation dialog.
 *
 * Shows the Pokémon's cost (tier plus transaction cost when enabled) and the
 * projected salary balance after the purchase, alongside the current balance.
 * Confirm runs the pickup RPC; Cancel or the overlay drops the pending add.
 */
function PickupConfirmDialog({
  row,
  goods,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The free-agent Pokémon being confirmed. */
  row: PokemonPoolRow;
  /** Loaded page state used to derive current balance and costs. */
  goods: PokemonGoods;
  /** When true, the pickup RPC is running; buttons are disabled. */
  busy: boolean;
  /** Called when the user confirms the pickup. */
  onConfirm: () => void;
  /** Called when the user cancels the pickup. */
  onCancel: () => void;
}) {
  const salary = getPokemonSalary(goods);
  const cost = getPickupCost(goods, row);
  const costsEnabled = Boolean(goods.settings?.enable_pokemon_costs);
  const hasCosts =
    costsEnabled || Boolean(goods.settings?.enable_transaction_costs);

  const projectedBalance =
    salary.remaining === Number.POSITIVE_INFINITY
      ? null
      : salary.remaining - cost.total;

  const insufficient = projectedBalance != null && projectedBalance < 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pickup-confirm-title"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl shadow-slate-950/50"
        onClick={(event) => event.stopPropagation()}
      >
        <h3
          id="pickup-confirm-title"
          className="text-xl font-bold text-white"
        >
          Add {row.name}?
        </h3>

        <div className="mt-4 space-y-2 text-sm text-slate-300">
          {!hasCosts ? (
            <p>No token costs are enabled for this pickup.</p>
          ) : (
            <>
              {costsEnabled && (
                <p className="flex justify-between">
                  <span>Tier cost</span>
                  <span className="font-medium text-slate-100">
                    {cost.tierCost} tokens
                  </span>
                </p>
              )}
              {goods.settings?.enable_transaction_costs && (
                <p className="flex justify-between">
                  <span>Transaction cost</span>
                  <span className="font-medium text-slate-100">
                    {cost.transactionCost} tokens
                  </span>
                </p>
              )}
              <p className="flex justify-between border-t border-slate-700 pt-2">
                <span>Total cost</span>
                <span className="font-semibold text-amber-300">
                  {cost.total} tokens
                </span>
              </p>
            </>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-300">
          {salary.remaining === Number.POSITIVE_INFINITY ? (
            <p>Current balance: unlimited</p>
          ) : (
            <>
              <p className="flex justify-between">
                <span>Current salary remaining</span>
                <span className="font-medium text-slate-100">
                  {salary.remaining} tokens
                </span>
              </p>
              <p className="mt-1 flex justify-between">
                <span>Projected balance after</span>
                <span
                  className={
                    insufficient
                      ? "font-semibold text-red-400"
                      : "font-semibold text-emerald-300"
                  }
                >
                  {projectedBalance} tokens
                </span>
              </p>
            </>
          )}
        </div>

        {insufficient && (
          <p className="mt-3 rounded-xl border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            You do not have enough tokens for this pickup.
          </p>
        )}

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || insufficient}
            className="flex-1 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Adding..." : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the right-column transaction history panel.
 *
 * Lists the user's team ledger in stack order (newest first): Pokémon name,
 * action label, the signed token delta, and when it happened. The note, when
 * present, appears beneath the action.
 */
function TransactionHistory({
  goods,
}: {
  /** Loaded page state whose team transactions to display. */
  goods: PokemonGoods;
}) {
  const transactions = goods.transactions;

  return (
    <aside className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
        Transaction history
      </p>
      <h2 className="mt-1 text-xl font-bold text-white">Recent moves</h2>

      {!goods.myTeam ? (
        <p className="mt-4 text-sm text-slate-500">
          You do not own a team in this season, so there is no history to show.
        </p>
      ) : transactions.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No transactions recorded for {goods.myTeam.team_name} yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {transactions.map((entry) => (
            <li
              key={entry.id}
              className="rounded-xl border border-slate-700 bg-slate-950/60 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <Sprite spriteId={entry.spriteId} name={entry.name} size={28} />
                  <span className="truncate font-medium text-slate-100">
                    {entry.name}
                  </span>
                </span>
                <span
                  className={`whitespace-nowrap text-sm font-semibold ${
                    entry.cost_delta < 0
                      ? "text-emerald-300"
                      : entry.cost_delta > 0
                        ? "text-amber-300"
                        : "text-slate-400"
                  }`}
                >
                  {entry.cost_delta === 0
                    ? "—"
                    : entry.cost_delta < 0
                      ? `+${-entry.cost_delta}`
                      : `-${entry.cost_delta}`}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-400">
                <span>
                  {actionLabel(entry.action)}
                  {entry.playerName ? ` by ${entry.playerName}` : ""}
                  {entry.note ? ` • ${entry.note}` : ""}
                </span>
                <span className="whitespace-nowrap">
                  {formatDateTime(entry.created_at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * The interactive Pokémon page content.
 *
 * @param props - The URL search params used to resolve the selected league.
 * @returns The free-agent pickup page.
 */
function PokemonPageContent({
  searchParams,
}: {
  /** Current URL search params used to select the league. */
  searchParams: URLSearchParams | null;
}) {
  const router = useRouter();
  const requestedLeagueId = searchParams?.get("leagueId") ?? null;

  const [goods, setGoods] = useState<PokemonGoods | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [selectedTab, setSelectedTab] = useState<"table" | "tiers">("table");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<PokemonSortKey>("tier");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pendingPokemonId, setPendingPokemonId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<PokemonPoolRow | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(
    async (leagueId: string): Promise<PokemonGoods> => {
      const next = await loadPokemonPageData(leagueId);
      setGoods(next);
      return next;
    },
    [],
  );

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
          setError("Select a league before opening the free agent pool.");
          return;
        }

        const next = await loadPokemonPageData(selectedLeagueId);
        if (!cancelled) {
          setGoods(next);
        }
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "The free agent pool could not be loaded.";
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

  const filtered = useMemo(() => {
    if (!goods) {
      return [];
    }
    const query = search.trim().toLowerCase();
    return goods.pool
      .filter((row) => {
        if (!query) {
          return true;
        }
        const haystack = `${row.name} ${row.species_name} ${row.pokemon_id}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice()
      .sort(
        (a, b) =>
          compareRows(a, b, sortKey, sortDir) || a.name.localeCompare(b.name),
      );
  }, [goods, search, sortKey, sortDir]);

  const salary = useMemo(
    () => (goods ? getPokemonSalary(goods) : null),
    [goods],
  );

  const canPickup = Boolean(
    goods &&
      goods.season?.status === "draft_complete" &&
      goods.myTeam != null,
  );

  const pickupHint = !goods
    ? ""
    : !goods.myTeam
      ? "You do not own a team in this season, so you cannot pick up free agents."
      : goods.season?.status !== "draft_complete"
        ? "Free agent pickups unlock once the draft is complete."
        : "";

  function handleSort(column: PokemonSortKey) {
    if (sortKey === column) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(column);
      setSortDir(DEFAULT_SORT_DIR[column]);
    }
  }

  function handleStartAdd(row: PokemonPoolRow) {
    if (!canPickup || isBusy) {
      return;
    }
    if (goods && !canAffordPickup(goods, row)) {
      const cost = getPickupCost(goods, row);
      setError(
        `Not enough tokens to pick up ${row.name}: ${cost.total} needed, ` +
          `${salary?.remaining ?? 0} available.`,
      );
      return;
    }
    setPendingPokemonId(row.pokemon_id);
    setConfirmTarget(row);
  }

  function handleCancelAdd() {
    setPendingPokemonId(null);
    setConfirmTarget(null);
  }

  const canAffordRow = (row: PokemonPoolRow): boolean =>
    goods != null && canAffordPickup(goods, row);

  async function handleConfirmPickup() {
    if (!goods || !confirmTarget) {
      return;
    }

    setIsBusy(true);
    setError(null);
    try {
      const result = await pickupRosterPokemon(
        goods.league.id,
        confirmTarget.pokemon_id,
      );
      await refresh(goods.league.id);
      setFeedback(
        `Added ${confirmTarget.name} to ${goods.myTeam?.team_name ?? "your team"}${
          result.charged_tokens > 0
            ? ` for ${result.charged_tokens} tokens`
            : ""
        }.`,
      );
      setPendingPokemonId(null);
      setConfirmTarget(null);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "That Pokémon could not be picked up.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  if (isLoading && !goods) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading free agents...
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
              <h2 className="text-3xl font-bold text-white">
                {goods.league.name}
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                {formatSeasonLabel(goods.season)} • Free agent pool
              </p>
            </div>

            <div className="rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
              <p>
                {goods.myTeam ? (
                  salary && goods.settings?.enable_pokemon_costs ? (
                    <span>
                      Team:{" "}
                      <span className="font-medium text-slate-100">
                        {goods.myTeam.team_name}
                      </span>{" "}
                      • Salary:{" "}
                      <span className="font-medium text-slate-100">
                        {salary.remaining}
                      </span>{" "}
                      of {salary.budget} tokens remaining
                    </span>
                  ) : (
                    <span>
                      Team:{" "}
                      <span className="font-medium text-slate-100">
                        {goods.myTeam.team_name}
                      </span>{" "}
                      • Roster: {goods.rosterCount} Pokémon
                    </span>
                  )
                ) : (
                  <span>You are not on a team this season.</span>
                )}
              </p>
              {goods.settings?.enable_transaction_costs &&
                typeof goods.settings.transaction_cost === "number" && (
                  <p className="mt-1 text-amber-300">
                    Transaction Cost: -{goods.settings.transaction_cost}
                  </p>
                )}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-slate-700 pt-4">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedTab("table")}
                className={`rounded-full px-3.5 py-2 text-sm font-medium transition ${
                  selectedTab === "table"
                    ? "bg-amber-500 text-slate-950"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setSelectedTab("tiers")}
                className={`rounded-full px-3.5 py-2 text-sm font-medium transition ${
                  selectedTab === "tiers"
                    ? "bg-amber-500 text-slate-950"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                Tiers
              </button>
            </div>

            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find Pokemon"
              aria-label="Find Pokemon"
              className="w-full max-w-xs rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-400"
            />
          </div>
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

        {isBusy && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-400">
            Picking up Pokémon...
          </div>
        )}

        {!canPickup && pickupHint && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-400">
            {pickupHint}
          </div>
        )}

        <section className="grid gap-6 xl:grid-cols-[1.5fr_0.9fr]">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Free agents
                </p>
                <h2 className="mt-1 text-xl font-bold text-white">
                  {filtered.length} available
                </h2>
              </div>
            </div>

            {selectedTab === "table" ? (
              <FreeAgentTable
                rows={filtered}
                pendingPokemonId={pendingPokemonId}
                disabled={!canPickup}
                busy={isBusy}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                onAdd={handleStartAdd}
                onCancel={handleCancelAdd}
                canAfford={canAffordRow}
              />
            ) : (
              <TierListView
                rows={filtered}
                pendingPokemonId={pendingPokemonId}
                disabled={!canPickup}
                busy={isBusy}
                onAdd={handleStartAdd}
                onCancel={handleCancelAdd}
                canAfford={canAffordRow}
              />
            )}
          </div>

          <TransactionHistory goods={goods} />
        </section>
      </div>

      {confirmTarget && goods && (
        <PickupConfirmDialog
          row={confirmTarget}
          goods={goods}
          busy={isBusy}
          onConfirm={handleConfirmPickup}
          onCancel={handleCancelAdd}
        />
      )}
    </main>
  );
}