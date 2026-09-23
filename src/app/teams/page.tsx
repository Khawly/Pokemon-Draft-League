/*
 * Team page for a league.
 *
 * Implements spec section 9. The user's own team is selected by default; a
 * Compare button adds a second team selector whose stats/typing tables render
 * alongside, and Clear Comparison removes it. The team stats table shows
 * sprite/name, tier, types, abilities, and the six base stats with sorting and
 * name/type filtering; the defensive typing table shows, for each attacking
 * type across the 18 columns, the damage multiplier it deals against each
 * Pokémon's defensive typing with the spec's color legend; and match history for
 * the selected player lists Matchup, Winner, Date/Time, Replay, and an
 * owner/admin-only Delete. Dropping a Pokémon confirms with its name, refunds
 * its tier into the team's token salary, removes it from the roster, re-lists
 * it on the free agents, and records a transaction (all enforced by the
 * `drop_roster_pokemon` RPC).
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AbilityTooltip } from "@/components/ability-tooltip";
import { supabase } from "@/lib/supabase/client";
import { getSpriteUrl } from "@/lib/pokeapi";
import { TYPE_LIST, getDefensiveMatchup, getMatchupColor } from "@/lib/typechart";
import {
  deleteMatch,
  dropRosterPokemon,
  getTeamSalary,
  loadTeamPageData,
  type TeamMatch,
  type TeamPageGoods,
  type TeamRosterPokemon,
} from "@/lib/supabase/teams";

/** LocalStorage key used by the top nav to persist the selected league. */
const SELECTED_LEAGUE_STORAGE_KEY = "pokemon-draft-league:selected-league";

/** Sortable columns of the team stats table. */
type StatSortKey =
  | "name"
  | "tier"
  | "hp"
  | "attack"
  | "defense"
  | "specialAttack"
  | "specialDefense"
  | "speed";

/** Type badge colors keyed by normalized type name (matches the pool page). */
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

/** Compact type text colors for the defensive chart column headers. */
const TYPE_TEXT_STYLES: Record<string, string> = {
  normal: "text-slate-300",
  fire: "text-red-400",
  water: "text-sky-400",
  electric: "text-yellow-300",
  grass: "text-green-400",
  ice: "text-cyan-300",
  fighting: "text-orange-400",
  poison: "text-fuchsia-400",
  ground: "text-amber-400",
  flying: "text-sky-300",
  psychic: "text-pink-400",
  bug: "text-lime-400",
  rock: "text-stone-400",
  ghost: "text-indigo-400",
  dragon: "text-violet-400",
  dark: "text-slate-500",
  steel: "text-slate-400",
  fairy: "text-pink-300",
};

/**
 * Wraps the teams content in a Suspense boundary to satisfy Next.js's
 * client-side streaming requirement for `useSearchParams`.
 *
 * @returns The teams page with a loading fallback.
 */
export default function TeamsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading teams...
          </div>
        </main>
      }
    >
      <TeamsRoute />
    </Suspense>
  );
}

/**
 * Bridge component that reads the search params inside the Suspense boundary.
 *
 * @returns The teams page content.
 */
function TeamsRoute() {
  const searchParams = useSearchParams();
  return <TeamsPageContent searchParams={searchParams} />;
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
 * Formats a nullable timestamp for the match history Date/Time column.
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

/** A sortable stat header with the sort indicator and click handler. */
function StatHeader({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
}: {
  /** Visible header label. */
  label: string;
  /** Sort key this header controls. */
  column: StatSortKey;
  /** Currently active sort key. */
  sortKey: StatSortKey;
  /** Current sort direction. */
  sortDir: "asc" | "desc";
  /** Called with the column key when the header is clicked. */
  onSort: (column: StatSortKey) => void;
}) {
  const active = sortKey === column;
  return (
    <th
      scope="col"
      className="cursor-pointer select-none whitespace-nowrap px-3 py-3 hover:text-slate-300"
      onClick={() => onSort(column)}
      title={`Sort by ${label}`}
    >
      {label}
      <span className="ml-1 text-slate-600">
        {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
      </span>
    </th>
  );
}

/** The §9.2 team stats table: sorting and name/type filtering included. */
function TeamStatsTable({
  teamName,
  roster,
  isMine,
  canDrop,
  onDrop,
}: {
  /** Team name shown in the table header. */
  teamName: string;
  /** Roster Pokémon to display. */
  roster: TeamRosterPokemon[];
  /** True when this table belongs to the signed-in user's own team. */
  isMine: boolean;
  /** True when drops are allowed (season draft complete + own team). */
  canDrop: boolean;
  /** Called with a roster Pokémon when the user confirms a drop. */
  onDrop: (pokemon: TeamRosterPokemon) => void;
}) {
  const [sortKey, setSortKey] = useState<StatSortKey>("tier");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  function handleSort(column: StatSortKey) {
    if (column === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(column);
      setSortDir(column === "name" ? "asc" : "desc");
    }
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return roster
      .filter((pokemon) => {
        if (query) {
          const haystack = `${pokemon.name} ${pokemon.species_name} ${pokemon.pokemon_id}`.toLowerCase();
          if (!haystack.includes(query)) {
            return false;
          }
        }
        if (typeFilter !== "all" && !pokemon.types.includes(typeFilter)) {
          return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => {
        const direction = sortDir === "asc" ? 1 : -1;
        if (sortKey === "name") {
          return a.name.localeCompare(b.name) * direction;
        }
        if (sortKey === "tier") {
          return (a.tier_value - b.tier_value) * direction;
        }
        const left = a.stats?.[sortKey] ?? -1;
        const right = b.stats?.[sortKey] ?? -1;
        return (left - right) * direction;
      });
  }, [roster, search, typeFilter, sortKey, sortDir]);

  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    for (const pokemon of roster) {
      for (const type of pokemon.types) {
        set.add(type);
      }
    }
    return Array.from(set).sort();
  }, [roster]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            Team stats
          </p>
          <h2 className="mt-1 text-xl font-bold text-white">{teamName}</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Pokémon..."
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-400"
            aria-label="Search Pokémon"
          />
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-400"
            aria-label="Filter by type"
          >
            <option value="all">All types</option>
            {availableTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
          No Pokémon match. This roster may be empty or the filters exclude
          everything.
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-center text-sm">
            <thead className="bg-slate-950 text-slate-300">
              <tr>
                <th scope="col" className="px-3 py-3 text-left font-semibold">
                  Pokémon
                </th>
                <StatHeader
                  label="Tier"
                  column="tier"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <th scope="col" className="px-3 py-3 font-semibold">
                  Type 1
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Type 2
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Abilities
                </th>
                <StatHeader
                  label="HP"
                  column="hp"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <StatHeader
                  label="Atk"
                  column="attack"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <StatHeader
                  label="Def"
                  column="defense"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <StatHeader
                  label="SpA"
                  column="specialAttack"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <StatHeader
                  label="SpD"
                  column="specialDefense"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <StatHeader
                  label="Spe"
                  column="speed"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                {canDrop && <th scope="col" className="px-3 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900">
              {filtered.map((pokemon) => (
                <tr key={pokemon.id} className="hover:bg-slate-800/80">
                  <td className="px-3 py-2 text-left">
                    <div className="flex items-center justify-start gap-2">
                      <Sprite spriteId={pokemon.spriteId} name={pokemon.name} size={40} />
                      <span className="whitespace-nowrap font-medium text-slate-100">
                        {pokemon.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-200">
                    {pokemon.tier_value === 0 ? "Unranked" : pokemon.tier_value}
                  </td>
                  <td className="px-3 py-2">
                    {pokemon.types[0] ? <TypeBadge type={pokemon.types[0]} /> : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {pokemon.types[1] ? <TypeBadge type={pokemon.types[1]} /> : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="max-w-[180px] px-3 py-2 text-slate-300">
                    {pokemon.abilities && pokemon.abilities.length > 0 ? (
                      <span className="flex flex-wrap items-center justify-center gap-1">
                        {pokemon.abilities.map((ability) => (
                          <AbilityTooltip key={ability.name} slug={ability.name} />
                        ))}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {pokemon.stats?.hp ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {pokemon.stats?.attack ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {pokemon.stats?.defense ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {pokemon.stats?.specialAttack ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {pokemon.stats?.specialDefense ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {pokemon.stats?.speed ?? "—"}
                  </td>
                  {canDrop && (
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onDrop(pokemon)}
                        disabled={!isMine}
                        className="rounded-lg border border-red-700 bg-red-950/60 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:border-red-500 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                        title={isMine ? "Drop this Pokémon" : "You can only drop Pokémon from your own team"}
                      >
                        Drop
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The §9.3 defensive typing grid.
 *
 * Rows are the team's Pokémon and columns the 18 attacking types; each cell is
 * the damage multiplier that attacking type deals against the Pokémon's own
 * defensive typing (e.g. a Gyarados shows 4 vs Electric, 0 vs Ground). Cells
 * are colored defensively — resistances green, weaknesses red, immunities
 * black — and the attacking-type columns use the signature type colors.
 */
function DefensiveTypingGrid({
  teamName,
  roster,
}: {
  /** Team name shown in the grid header. */
  teamName: string;
  /** Roster Pokémon to evaluate. */
  roster: TeamRosterPokemon[];
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            Defensive typing
          </p>
          <h2 className="mt-1 text-xl font-bold text-white">{teamName}</h2>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-red-700 text-center text-[9px] leading-3 text-white">4</span>
            Double weakness
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-red-500 text-center text-[9px] leading-3 text-white">2</span>
            Weakness
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-slate-800 text-center text-[9px] leading-3 text-slate-200">1</span>
            Neutral
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-green-700 text-center text-[9px] leading-3 text-white">0.5</span>
            Resisted
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-green-500 text-center text-[9px] leading-3 text-white">0.25</span>
            Strongly resisted
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-slate-950 text-center text-[9px] leading-3 text-slate-400">0</span>
            Immune
          </span>
        </div>
      </div>

      {roster.length === 0 ? (
        <p className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
          This roster is empty, so there are no matchups to show.
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
            <thead className="bg-slate-950 text-slate-300">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 bg-slate-950 px-2 py-2 text-left font-semibold"
                >
                  Pokémon
                </th>
                {TYPE_LIST.map((type) => (
                  <th key={type} scope="col" className="px-1 py-2 text-center">
                    <span
                      className={`inline-block whitespace-nowrap font-semibold capitalize ${TYPE_TEXT_STYLES[type] ?? "text-slate-300"}`}
                      title={`${type}-type attacks`}
                    >
                      {type}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900">
              {roster.map((pokemon) => (
                <tr key={pokemon.id} className="hover:bg-slate-800/60">
                  <td className="sticky left-0 bg-slate-900 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <Sprite spriteId={pokemon.spriteId} name={pokemon.name} size={32} />
                      <span className="whitespace-nowrap font-medium text-slate-100">
                        {pokemon.name}
                      </span>
                    </div>
                  </td>
                  {TYPE_LIST.map((type) => {
                    const multiplier = getDefensiveMatchup(pokemon.types, type);
                    return (
                      <td
                        key={type}
                        className={`px-1 py-1 text-center text-xs font-bold ${getMatchupColor(multiplier)}`}
                        aria-label={`${pokemon.name} takes ${multiplier}x damage from ${type}`}
                      >
                        {multiplier}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The §9.4 match history table for a selected team. */
function MatchHistory({
  teamName,
  matches,
  isStaff,
  onDelete,
}: {
  /** Team name shown in the history header. */
  teamName: string;
  /** The selected player's matches, oldest first. */
  matches: TeamMatch[];
  /** True when the signed-in user is a league owner or admin. */
  isStaff: boolean;
  /** Called with a match id after the user confirms a delete. */
  onDelete: (match: TeamMatch) => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
        Match history
      </p>
      <h2 className="mt-1 text-xl font-bold text-white">{teamName}</h2>

      {matches.length === 0 ? (
        <p className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
          No matches recorded for this player yet.
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
            <thead className="bg-slate-950 text-slate-300">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Matchup
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Winner
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Date/Time
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Replay
                </th>
                {isStaff && <th scope="col" className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900">
              {matches.map((match) => (
                <tr key={match.id} className="hover:bg-slate-800/80">
                  <td className="px-4 py-3 font-medium text-slate-100">
                    <span className="whitespace-nowrap">
                      {match.player_1_name} vs {match.player_2_name}
                    </span>
                    {match.is_playoff && (
                      <span className="ml-2 rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-semibold text-violet-300">
                        Playoff
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-200">
                    {match.winner_name ?? (match.status === "forfeit" ? "Forfeit" : "—")}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                    {formatDateTime(match.date_time)}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {match.results.length === 0 ? (
                      "—"
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {match.results.map((result) => (
                          <a
                            key={result.id}
                            href={result.replay_url ?? "#"}
                            target={result.replay_url ? "_blank" : undefined}
                            rel="noreferrer"
                            className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
                              result.replay_url
                                ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/30"
                                : "bg-slate-800 text-slate-500"
                            }`}
                          >
                            {match.results.length > 1
                              ? `Game ${result.game_number}`
                              : "Replay"}
                          </a>
                        ))}
                      </div>
                    )}
                  </td>
                  {isStaff && (
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onDelete(match)}
                        className="rounded-lg border border-red-700 bg-red-950/60 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:border-red-500 hover:bg-red-900/60"
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Renders the teams page content, resolving the league and loading all data.
 *
 * @param props - Search params from the URL.
 * @returns The teams page markup, loading placeholder, or error state.
 */
function TeamsPageContent({
  searchParams,
}: {
  /** Current URL search params used to select the league. */
  searchParams: URLSearchParams | null;
}) {
  const router = useRouter();
  const [goods, setGoods] = useState<TeamPageGoods | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [compareTeamId, setCompareTeamId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestedLeagueId = searchParams?.get("leagueId") ?? null;

  const refresh = useCallback(
    async (leagueId: string) => {
      const next = await loadTeamPageData(leagueId);
      setGoods(next);
      setSelectedTeamId((current) => current ?? next.myTeamId ?? next.teams[0]?.id ?? null);
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
          setError("Select a league before opening teams.");
          return;
        }

        const next = await loadTeamPageData(selectedLeagueId);
        if (!cancelled) {
          setGoods(next);
          setSelectedTeamId(
            next.myTeamId ?? next.teams[0]?.id ?? null,
          );
          setCompareTeamId(null);
        }
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "Teams could not be loaded.";
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

  const selectedTeam = useMemo(
    () => goods?.teams.find((team) => team.id === selectedTeamId) ?? null,
    [goods, selectedTeamId],
  );

  const compareTeam = useMemo(
    () => goods?.teams.find((team) => team.id === compareTeamId) ?? null,
    [goods, compareTeamId],
  );

  const selectedRoster = useMemo(
    () => (goods && selectedTeamId ? goods.rostersByTeam.get(selectedTeamId) ?? [] : []),
    [goods, selectedTeamId],
  );

  const compareRoster = useMemo(
    () => (goods && compareTeamId ? goods.rostersByTeam.get(compareTeamId) ?? [] : []),
    [goods, compareTeamId],
  );

  const selectedSalary = useMemo(
    () => (goods && selectedTeamId ? getTeamSalary(goods, selectedTeamId) : null),
    [goods, selectedTeamId],
  );

  const selectedMatches = useMemo(() => {
    if (!goods || !selectedTeamId) {
      return [];
    }
    return goods.matches.filter(
      (match) =>
        match.player_1_team_id === selectedTeamId ||
        match.player_2_team_id === selectedTeamId,
    );
  }, [goods, selectedTeamId]);

  const canDrop = Boolean(
    goods &&
      goods.season?.status === "draft_complete" &&
      goods.myTeamId &&
      selectedTeamId === goods.myTeamId,
  );

  async function handleDrop(pokemon: TeamRosterPokemon) {
    if (!goods || !goods.myTeamId || selectedTeamId !== goods.myTeamId) {
      return;
    }

    const confirmed = window.confirm(
      `Drop ${pokemon.name} from your roster? Its tier (Tier ${pokemon.tier_value}) will be refunded into your team's token salary and it will be added back to the free agents.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    try {
      await dropRosterPokemon(goods.league.id, pokemon.pokemon_id);
      await refresh(goods.league.id);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "That Pokémon could not be dropped.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDeleteMatch(match: TeamMatch) {
    const confirmed = window.confirm(
      `Delete the ${match.player_1_name} vs ${match.player_2_name} match and its results? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    try {
      if (goods) {
        await deleteMatch(match.id);
        await refresh(goods.league.id);
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "That match could not be deleted.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  if (isLoading && !goods) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading teams...
        </div>
      </main>
    );
  }

  if (error) {
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

  const teamOptions = goods.teams.length > 0 ? goods.teams : [];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-3xl font-bold text-white">{goods.league.name}</h2>
              <p className="mt-1 text-sm text-slate-400">
                Season {goods.season?.season_number ?? "—"} • Team overview
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="block">
                <span className="sr-only">Selected team</span>
                <select
                  value={selectedTeamId ?? ""}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setSelectedTeamId(nextId);
                    if (compareTeamId !== null && compareTeamId === nextId) {
                      setCompareTeamId(null);
                    }
                  }}
                  className="w-56 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-medium text-slate-100 outline-none transition focus:border-amber-400"
                  aria-label="Selected team"
                >
                  {teamOptions.length === 0 && (
                    <option value="">No teams</option>
                  )}
                  {teamOptions.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.team_name} ({team.owner_name ?? "Unknown"})
                    </option>
                  ))}
                </select>
              </label>

              {compareTeamId === null ? (
                <button
                  type="button"
                  onClick={() => {
                    const other = goods.teams.find((team) => team.id !== selectedTeamId);
                    setCompareTeamId(other?.id ?? null);
                  }}
                  disabled={goods.teams.length < 2}
                  className="rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Compare
                </button>
              ) : (
                <>
                  <label className="block">
                    <span className="sr-only">Comparison team</span>
                    <select
                      value={compareTeamId ?? ""}
                      onChange={(event) => setCompareTeamId(event.target.value)}
                      className="w-56 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-medium text-slate-100 outline-none transition focus:border-amber-400"
                      aria-label="Comparison team"
                    >
                      {teamOptions.map((team) => (
                        <option
                          key={team.id}
                          value={team.id}
                          disabled={team.id === selectedTeamId}
                        >
                          {team.team_name} ({team.owner_name ?? "Unknown"})
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => setCompareTeamId(null)}
                    className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
                  >
                    Clear Comparison
                  </button>
                </>
              )}
            </div>
          </div>

          {selectedTeam && selectedSalary && (
            <div className="mt-5 flex flex-wrap gap-4 border-t border-slate-700 pt-4 text-sm text-slate-300">
              <span>
                Owner:{" "}
                <span className="font-medium text-slate-100">
                  {selectedTeam.owner_name ?? "Unknown"}
                </span>
              </span>
              {goods.settings?.enable_pokemon_costs ? (
                <span>
                  Salary:{" "}
                  <span className="font-medium text-slate-100">
                    {selectedSalary.remaining}
                  </span>{" "}
                  of {selectedSalary.budget} tokens remaining
                </span>
              ) : (
                <span>
                  Roster:{" "}
                  <span className="font-medium text-slate-100">
                    {selectedRoster.length}
                  </span>{" "}
                  Pokémon
                </span>
              )}
              <span>
                Draft position:{" "}
                <span className="font-medium text-slate-100">
                  {selectedTeam.draft_position ?? "—"}
                </span>
              </span>
            </div>
          )}
        </header>

        {isBusy && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-400">
            Updating roster...
          </div>
        )}

        {teamOptions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400">
            No teams exist for this league&apos;s current season yet.
          </div>
        ) : (
          <>
            <TeamStatsTable
              teamName={selectedTeam?.team_name ?? "Selected team"}
              roster={selectedRoster}
              isMine={selectedTeamId === goods.myTeamId}
              canDrop={canDrop}
              onDrop={handleDrop}
            />

            {compareTeam && (
              <TeamStatsTable
                teamName={`${compareTeam.team_name} (comparison)`}
                roster={compareRoster}
                isMine={false}
                canDrop={false}
                onDrop={() => undefined}
              />
            )}

            <DefensiveTypingGrid
              teamName={selectedTeam?.team_name ?? "Selected team"}
              roster={selectedRoster}
            />

            {compareTeam && (
              <DefensiveTypingGrid
                teamName={`${compareTeam.team_name} (comparison)`}
                roster={compareRoster}
              />
            )}

            <MatchHistory
              teamName={selectedTeam?.team_name ?? "Selected team"}
              matches={selectedMatches}
              isStaff={goods.isStaff}
              onDelete={handleDeleteMatch}
            />
          </>
        )}
      </div>
    </main>
  );
}