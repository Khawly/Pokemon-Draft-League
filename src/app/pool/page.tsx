/*
 * Draft pool page for a league.
 *
 * Full pool management per the league onboarding flow. A new (unsaved) pool
 * defaults to the entire national dex listed by Pokédex number with every
 * species "Off Pool"; the owner toggles species into the pool, assigns integer
 * tiers, and hits Save, which creates/persists the pool. Previously saved pools
 * appear in the "Saved Draft Pools" dropdown and are loaded read-write (owner)
 * or read-only (members). The bottom "Add Pokémon" panel is intentionally
 * absent: the default state already contains every species, so no search/add is
 * needed. CSV import/export round-trips tier/status/notes while skipping
 * species it cannot resolve against the catalog. On the tier list, each card's
 * ✓ button confirms (persists) a pending tier change for that single Pokémon,
 * independent of the global Save. The owner can also delete the selected saved
 * pool, and new/renamed pool names are rejected when they would duplicate an
 * existing saved pool in the dropdown.
 */
"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  getPokemonEntryBySlug,
  getSpriteUrl,
  matchPokemonName,
  POKEMON_DATA,
} from "@/lib/pokeapi";

/** A named, saved draft pool for a league season. */
type PoolSummary = {
  /** Draft pool primary key. */
  id: string;
  /** Display name of the pool. */
  name: string;
  /** Whether this is the pool the season's draft uses. */
  is_active: boolean;
};

/** A pool Pokémon row, enriched with type/BST/gen and optional notes. */
type PoolPokemonRow = {
  /** Stable client key used for React keys, selection, and edit targeting. */
  key: string;
  /** Primary key of the draft_pool_pokemon row, or null when not yet saved. */
  id: string | null;
  /** National Pokédex number used for ordering (shared by alternate forms). */
  dex: number;
  /** Sprite id: the dex number for species, 10001+ for alternate forms. */
  spriteId: number;
  /** PokeAPI slug, e.g. "pikachu" or "deoxys-defense". */
  pokemon_id: string;
  /** Human-readable display name, e.g. "Deoxys (Defense Forme)". */
  species_name: string;
  /** Tier bucket as an arbitrary non-negative integer (0 = unranked). */
  tier_value: number;
  /** Whether the species is enabled in the pool for drafting. */
  is_in_pool: boolean;
  /** Primary type name, e.g. "electric". */
  type_primary: string | null;
  /** Secondary type name or null for single-typed species. */
  type_secondary: string | null;
  /** Sum of base stats. */
  bst: number | null;
  /** Generation label, e.g. "Gen 1". */
  generation: string | null;
  /** Optional trainer note carried through CSV import/export. */
  notes: string | null;
};

/** Sortable table columns, including the national-dex default ordering. */
type SortKey = "dex" | "name" | "type" | "bst" | "gen" | "status" | "tier";

/** Maximum tier value allowed by the tier inputs (hard cap for now). */
const MAX_TIER = 50;

/** Type badge color classes keyed by normalized type name. */
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
 * Labels a tier value for display; there is no upper bound, so any positive
 * integer renders as "Tier n" and 0 renders as "Unranked".
 *
 * @param tier - The tier integer.
 * @returns The display label.
 */
function tierLabel(tier: number): string {
  return tier === 0 ? "Unranked" : `Tier ${tier}`;
}

/**
 * Extracts just the generation number from a label like "Gen 1".
 *
 * @param generation - The stored generation label.
 * @returns The numeric generation or the original label if no number is found.
 */
function generationNumber(generation: string): string {
  const match = /\d+/.exec(generation);
  return match ? match[0] : generation;
}

/**
 * Parses a tier input value into a non-negative integer capped at {@link MAX_TIER}.
 *
 * @param value - The raw string from a number input (may be transiently empty).
 * @param fallback - The previous tier to keep when the value is not finite.
 * @returns The parsed tier, clamped to the 0..{@link MAX_TIER} range.
 */
function parseTier(value: string, fallback: number): number {
  if (value.trim() === "") {
    return 0;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(MAX_TIER, Math.max(0, Math.floor(raw)));
}

/**
 * Parses a CSV record into its fields, honoring double-quoted values per RFC 4180.
 *
 * @param line - A single CSV line.
 * @returns The unquoted field values in order.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Builds the default working-state rows: the full national dex, by number,
 * every species "Off Pool" and unranked.
 *
 * @returns The default rows for an unsaved pool.
 */
function buildDefaultRows(): PoolPokemonRow[] {
  return POKEMON_DATA.map((entry) => ({
    key: `default-${entry.slug}`,
    id: null,
    dex: entry.dexNumber,
    spriteId: entry.dexNumber,
    pokemon_id: entry.slug,
    species_name: entry.name,
    tier_value: 0,
    is_in_pool: false,
    type_primary: entry.types[0] ?? null,
    type_secondary: entry.types[1] ?? null,
    bst: entry.bst,
    generation: entry.generation,
    notes: null,
  }));
}

/**
 * Creates the league's first draft pool under the given name.
 *
 * @param leagueId - The id of the league owning the pool.
 * @param seasonId - The id of the season the pool belongs to.
 * @param userId - The signed-in league owner creating the pool.
 * @param name - The pool's display name.
 * @returns A promise resolving to the created pool's id.
 * @throws If the DB insert fails (e.g. RLS denies non-owners).
 */
async function createPool(
  leagueId: string,
  seasonId: string,
  userId: string,
  name: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("draft_pools")
    .insert({
      league_id: leagueId,
      season_id: seasonId,
      name,
      created_by: userId,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message || "Unable to create the draft pool.");
  }

  return (data as { id: string }).id;
}

/**
 * Entry point for the pool route.
 *
 * Wraps the pool content in a Suspense boundary to satisfy Next.js's client-side
 * streaming requirement for `useSearchParams`.
 *
 * @returns The pool page with a loading fallback.
 */
export default function PoolPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading draft pool...
          </div>
        </main>
      }
    >
      <PoolRoute />
    </Suspense>
  );
}

/**
 * Renders the pool page, reading search params within the Suspense boundary.
 *
 * @returns The pool page content.
 */
function PoolRoute() {
  const searchParams = useSearchParams();
  return <PoolPageContent searchParams={searchParams} />;
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

/** Renders a sortable table header cell. */
function SortHeader({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
}: {
  /** Visible header label. */
  label: string;
  /** Sort key this header controls. */
  column: SortKey;
  /** Currently active sort key. */
  sortKey: SortKey;
  /** Current sort direction. */
  sortDir: "asc" | "desc";
  /** Called with the column key when the header is clicked. */
  onSort: (column: SortKey) => void;
}) {
  const active = sortKey === column;
  return (
    <th
      scope="col"
      className="cursor-pointer select-none whitespace-nowrap px-4 py-3 hover:text-slate-300"
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

/** Raw shape of a `draft_pool_pokemon` row as returned by the select below. */
type PoolRowRecord = {
  id: string;
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  is_in_pool: boolean;
  type_primary: string | null;
  type_secondary: string | null;
  bst: number | null;
  generation: string | null;
  notes: string | null;
};

/** Rows fetched per request; matches Supabase/PostgREST's default response cap. */
const POOL_PAGE_SIZE = 1000;

/**
 * Fetches the Pokémon rows for a draft pool from the database.
 *
 * Pages through the table instead of issuing one unbounded select: Supabase
 * caps a single response (default 1000 rows) and a configured pool holds the
 * full national dex plus alternate forms (>1000 rows). Without paging the rows
 * past the cap silently vanish from the editor after a save-triggered refetch.
 *
 * @param poolId - The id of the draft pool whose rows to fetch.
 * @returns A promise resolving to the ordered list of pool Pokémon rows.
 * @throws If any page query fails.
 */
async function fetchPoolRows(poolId: string): Promise<PoolPokemonRow[]> {
  const allRows: PoolRowRecord[] = [];

  // The id order keeps each page's window stable across the loop.
  for (let from = 0; ; from += POOL_PAGE_SIZE) {
    const { data, error: rowsError } = await supabase
      .from("draft_pool_pokemon")
      .select(
        "id, pokemon_id, species_name, tier_value, is_in_pool, type_primary, type_secondary, bst, generation, notes",
      )
      .eq("draft_pool_id", poolId)
      .order("id", { ascending: true })
      .range(from, from + POOL_PAGE_SIZE - 1);

    if (rowsError) {
      throw new Error(rowsError.message || "The pool could not be loaded.");
    }

    const page = (data ?? []) as PoolRowRecord[];
    allRows.push(...page);

    // A short page means the table is exhausted; a full page means another may follow.
    if (page.length < POOL_PAGE_SIZE) {
      break;
    }
  }

  return allRows.map(
    (row): PoolPokemonRow => {
      // Derive the dex number and sprite id from the matched catalog/form entry:
      // alternate forms keep their base species' dex but render their own sprite.
      const match = getPokemonEntryBySlug(row.pokemon_id);
      return {
        key: row.id,
        id: row.id,
        dex: match?.dexNumber ?? 0,
        spriteId: match?.spriteId ?? 0,
        pokemon_id: row.pokemon_id,
        species_name: row.species_name,
        tier_value: row.tier_value,
        is_in_pool: row.is_in_pool,
        type_primary: row.type_primary,
        type_secondary: row.type_secondary,
        bst: row.bst,
        generation: row.generation,
        notes: row.notes,
      };
    },
  );
}

/**
 * Builds the database payload for a pool row, carrying the PK id when known.
 *
 * @param row - The pool row to persist.
 * @param poolId - The id of the pool the row belongs to.
 * @param id - The UUID to write for new rows (the deployed table has no default).
 * @returns The insert/update payload.
 */
function buildPoolRowPayload(
  row: PoolPokemonRow,
  poolId: string,
  id: string | null,
): Record<string, unknown> {
  return {
    id: id ?? undefined,
    draft_pool_id: poolId,
    pokemon_id: row.pokemon_id,
    species_name: row.species_name,
    tier_value: row.tier_value,
    is_in_pool: row.is_in_pool,
    type_primary: row.type_primary,
    type_secondary: row.type_secondary,
    bst: row.bst,
    generation: row.generation,
    notes: row.notes,
  };
}

/**
 * Client component that loads and renders the league's draft pools.
 *
 * Handles authentication, league/season resolution, the list of saved draft
 * pools, the default full-national-dex working state, staged inline editing,
 * CSV import/export, and the table + tier list views.
 *
 * @remarks `searchParams` is passed in as a prop to satisfy the Suspense
 * requirement while keeping the page component cache-safe.
 * @returns The pool page markup, loading placeholder, or error state.
 */
function PoolPageContent({
  searchParams,
}: {
  /** Current URL search params used to select league and view. */
  searchParams: URLSearchParams | null;
}) {
  const router = useRouter();
  const requestedLeagueId = searchParams?.get("leagueId") ?? null;
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [leagueName, setLeagueName] = useState("");
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [pools, setPools] = useState<PoolSummary[]>([]);
  const [activePoolId, setActivePoolId] = useState<string | null>(null);
  const [poolName, setPoolName] = useState("");
  const [savedPoolName, setSavedPoolName] = useState("");
  const [isOwner, setIsOwner] = useState(false);
  const [rows, setRows] = useState<PoolPokemonRow[]>([]);
  const [savedRows, setSavedRows] = useState<PoolPokemonRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [selectedTab, setSelectedTab] = useState<"table" | "tiers">("table");
  const [sortKey, setSortKey] = useState<SortKey>("dex");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState({
    name: "",
    type: "all",
    generation: "all",
    status: "all",
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nextClientKeyRef = useRef(1);

  const isDirty = useMemo(() => {
    if (poolName.trim() !== savedPoolName) {
      return true;
    }
    if (rows.length !== savedRows.length) {
      return true;
    }
    const savedMap = new Map(savedRows.map((row) => [row.key, row]));
    for (const row of rows) {
      const saved = savedMap.get(row.key);
      if (
        !saved ||
        saved.pokemon_id !== row.pokemon_id ||
        saved.species_name !== row.species_name ||
        saved.tier_value !== row.tier_value ||
        saved.is_in_pool !== row.is_in_pool ||
        saved.notes !== row.notes
      ) {
        return true;
      }
    }
    return false;
  }, [rows, savedRows, poolName, savedPoolName]);

  // Load the user, league, season, and the list of saved pools.
  useEffect(() => {
    /** Loads the pool-related data for the selected league. */
    async function loadLeague() {
      try {
        setError(null);
        setSuccessMessage(null);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.replace("/");
          return;
        }

        setCurrentUserId(user.id);

        let selectedLeagueId = requestedLeagueId;

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
          setError("Select a league before opening the draft pool.");
          return;
        }

        const { data: league, error: leagueError } = await supabase
          .from("leagues")
          .select("id, name, owner_id")
          .eq("id", selectedLeagueId)
          .maybeSingle();

        if (leagueError || !league) {
          setError("This league could not be loaded.");
          return;
        }

        const resolvedLeagueId = league.id;
        setLeagueId(resolvedLeagueId);
        setLeagueName(league.name || "");
        setIsOwner(league.owner_id === user.id);

        const { data: seasonRow, error: seasonError } = await supabase
          .from("seasons")
          .select("id")
          .eq("league_id", resolvedLeagueId)
          .order("season_number", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (seasonError || !seasonRow) {
          setError("This league has no active season.");
          return;
        }

        const resolvedSeasonId = (seasonRow as { id: string }).id;
        setSeasonId(resolvedSeasonId);

        // Load the saved pools for this season. The dropdown stays empty (and
        // no pool is auto-created) until the owner actually saves one.
        const { data: poolRows, error: poolsError } = await supabase
          .from("draft_pools")
          .select("id, name, is_active")
          .eq("league_id", resolvedLeagueId)
          .eq("season_id", resolvedSeasonId)
          .order("created_at", { ascending: true });

        if (poolsError) {
          throw new Error(poolsError.message || "The draft pools could not be loaded.");
        }

        const poolList = (poolRows ?? []) as PoolSummary[];
        setPools(poolList);

        if (poolList.length === 0) {
          if (league.owner_id === user.id) {
            // One default pool per league, created on first load so the owner
            // always has somewhere to save to. Contents start as the unconfigured
            // working set (full dex, all off pool) until the first Save.
            const defaultId = await createPool(
              resolvedLeagueId,
              resolvedSeasonId,
              user.id,
              "Default Pool",
            );
            setPools([{ id: defaultId, name: "Default Pool", is_active: false }]);
            setActivePoolId(defaultId);
          } else {
            setActivePoolId(null);
            setPoolName("");
            setSavedPoolName("");
          }
          return;
        }

        // Always land on the pool the season actually uses when one is set.
        setActivePoolId((poolList.find((pool) => pool.is_active) ?? poolList[0]).id);
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "The draft pools could not be loaded.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }

    loadLeague();
  }, [router, requestedLeagueId]);

  // Load the rows for the active pool; an owner with no saved pool gets the
  // default full-national-dex working state.
  useEffect(() => {
    /** Loads the Pokémon rows for {@link activePoolId}. */
    async function loadPoolPokemon() {
      if (!activePoolId) {
        setRows(isOwner ? buildDefaultRows() : []);
        setSavedRows([]);
        setSelectedIds(new Set());
        return;
      }

      const pool = pools.find((candidate) => candidate.id === activePoolId);
      setPoolName(pool?.name ?? "");
      setSavedPoolName(pool?.name ?? "");

      try {
        const refreshed = await fetchPoolRows(activePoolId);
        // An owner's empty pool is "unconfigured": present it as the default
        // working set (full national dex, off pool) rather than a blank table,
        // and treat it as the saved base so nothing looks dirty on first load.
        const baseRows =
          refreshed.length === 0 && isOwner ? buildDefaultRows() : refreshed;
        setRows(baseRows);
        setSavedRows(baseRows);
        setSelectedIds(new Set());
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "The pool could not be loaded.",
        );
        setRows([]);
        setSavedRows([]);
      }
    }

    loadPoolPokemon();
  }, [activePoolId, pools, isOwner]);

  /** Resets the working state to a brand-new, unsaved pool. */
  function startNewPool() {
    if (!leagueId || !seasonId) {
      return;
    }
    if (isDirty && !window.confirm("Discard unsaved changes and start a new pool?")) {
      return;
    }
    setActivePoolId(null);
    setPoolName("");
    setSavedPoolName("");
    setSelectedIds(new Set());
    setError(null);
    setSuccessMessage(null);
  }

  /** Switches the active Saved Draft Pools selection, guarding unsaved edits. */
  function handlePoolSwitch(nextPoolId: string) {
    if (nextPoolId === activePoolId) {
      return;
    }
    if (isDirty && !window.confirm("Discard unsaved changes and switch pools?")) {
      return;
    }
    if (nextPoolId === "") {
      startNewPool();
      return;
    }
    setActivePoolId(nextPoolId);
  }

  /** Saves staged edits, creating the pool on first save if needed. */
  async function handleSave() {
    if (!isOwner || isBusy) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const trimmedName = poolName.trim();
      if (!trimmedName) {
        setError("Pool name cannot be empty.");
        return;
      }

      // The dropdown must never carry two pools with the same name: reject a
      // new pool or a rename that collides with another saved pool in the season.
      const duplicateName = pools.some(
        (pool) =>
          pool.id !== activePoolId &&
          pool.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (duplicateName) {
        setError(`A saved pool named "${trimmedName}" already exists.`);
        return;
      }

      let targetPoolId = activePoolId;

      if (!targetPoolId) {
        if (!leagueId || !seasonId || !currentUserId) {
          throw new Error("You must be signed in to save a draft pool.");
        }
        targetPoolId = await createPool(
          leagueId,
          seasonId,
          currentUserId,
          trimmedName,
        );
      } else {
        // Rename the existing pool when its name changed.
        const { data: poolRow, error: poolError } = await supabase
          .from("draft_pools")
          .select("id, name")
          .eq("id", targetPoolId)
          .maybeSingle();

        const currentPool = poolRow as PoolSummary | null;

        if (poolError || !currentPool) {
          throw new Error(
            poolError?.message || "The active draft pool no longer exists.",
          );
        }

        if (currentPool.name !== trimmedName) {
          const { error: renameError } = await supabase
            .from("draft_pools")
            .update({ name: trimmedName })
            .eq("id", targetPoolId);

          if (renameError) {
            throw new Error(renameError.message || "Unable to rename the pool.");
          }
        }
      }

      // Merge any duplicated pokemon_id rows that may have been staged (a CSV
      // name resolving to a slug already present), keeping the copy that
      // carries a real DB id so existing rows are updated rather than re-inserted.
      const dedupedBySlug = new Map<string, PoolPokemonRow>();
      for (const row of rows) {
        const existing = dedupedBySlug.get(row.pokemon_id);
        if (!existing || (existing.id === null && row.id !== null)) {
          dedupedBySlug.set(row.pokemon_id, row);
        }
      }
      const dedupedRows = [...dedupedBySlug.values()];

      // Rows without a DB id get an explicit UUID: the deployed table has no
      // auto-generating default, and an omitted id inserts NULL into a NOT NULL
      // primary key.
      const existingRows = dedupedRows.filter((row) => row.id !== null);
      const insertRows = dedupedRows.filter((row) => row.id === null);

      if (existingRows.length > 0) {
        const { error: updateError } = await supabase
          .from("draft_pool_pokemon")
          .upsert(
            existingRows.map((row) =>
              buildPoolRowPayload(row, targetPoolId, row.id),
            ),
            { onConflict: "id" },
          );

        if (updateError) {
          throw new Error(updateError.message || "Unable to save the pool.");
        }
      }

      if (insertRows.length > 0) {
        // The composite natural key (draft_pool_id, pokemon_id) makes the upsert
        // merge into an existing pool row for that Pokémon instead of raising a
        // duplicate constraint error.
        const { error: insertError } = await supabase
          .from("draft_pool_pokemon")
          .upsert(
            insertRows.map((row) =>
              buildPoolRowPayload(row, targetPoolId, crypto.randomUUID()),
            ),
            { onConflict: "draft_pool_id,pokemon_id" },
          );

        if (insertError) {
          throw new Error(insertError.message || "Unable to save the pool.");
        }
      }

      const deletedIds = savedRows
        .filter(
          (saved) =>
            saved.id &&
            !dedupedRows.some(
              (row) => row.pokemon_id === saved.pokemon_id,
            ),
        )
        .map((saved) => saved.id)
        .filter((id): id is string => id !== null);

      if (deletedIds.length > 0) {
        const { error: deleteError } = await supabase
          .from("draft_pool_pokemon")
          .delete()
          .in("id", deletedIds);

        if (deleteError) {
          throw new Error(deleteError.message || "Unable to remove Pokémon.");
        }
      }

      // Refresh from the database so new rows get real ids and dirty clears.
      const refreshed = await fetchPoolRows(targetPoolId);
      setRows(refreshed);
      setSavedRows(refreshed);
      setPoolName(trimmedName);
      setSavedPoolName(trimmedName);

      // Register a newly created pool in the dropdown.
      if (activePoolId !== targetPoolId) {
        setPools((current) =>
          current.some((pool) => pool.id === targetPoolId)
            ? current
            : [...current, { id: targetPoolId, name: trimmedName, is_active: false }],
        );
        setActivePoolId(targetPoolId);
      } else {
        setPools((current) =>
          current.map((pool) =>
            pool.id === targetPoolId ? { ...pool, name: trimmedName } : pool,
          ),
        );
      }

      setSuccessMessage(`Saved "${trimmedName}".`);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save the pool.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  /** Marks the selected saved pool as the season's active draft pool. */
  async function handleSetActivePool() {
    if (!isOwner || isBusy || !activePoolId) {
      return;
    }
    if (isDirty) {
      setError("Save your changes before setting this as the active pool.");
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      // The RPC clears any other active pool in the season and activates this
      // one in a single transaction, so the one-active-per-season index holds.
      const { error: rpcError } = await supabase.rpc("set_active_draft_pool", {
        p_pool_id: activePoolId,
      });

      if (rpcError) {
        throw new Error(rpcError.message || "Unable to set the active pool.");
      }

      setPools((current) =>
        current.map((pool) => ({ ...pool, is_active: pool.id === activePoolId })),
      );
      setSuccessMessage(
        `"${poolName.trim() || "This pool"}" is now the active draft pool.`,
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to set the active pool.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Deletes the currently selected saved draft pool and its Pokémon rows.
   *
   * Confirms with the user first (destructive and discards unsaved changes).
   * After deletion the selection moves to the next remaining pool, or back to
   * the unsaved new-pool working state when no pools are left. Only the league
   * owner may delete.
   *
   * @returns A promise resolving once the pool is removed.
   */
  async function handleDeletePool() {
    if (!isOwner || isBusy || !activePoolId) {
      return;
    }

    const deletedPoolName = poolName.trim() || "this pool";
    const confirmed = window.confirm(
      isDirty
        ? `Delete "${deletedPoolName}"? Unsaved changes will be discarded and its Pokémon removed.`
        : `Delete "${deletedPoolName}" and all of its Pokémon?`,
    );
    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { error: deleteError } = await supabase
        .from("draft_pools")
        .delete()
        .eq("id", activePoolId);

      if (deleteError) {
        throw new Error(deleteError.message || "Unable to delete the pool.");
      }

      const remaining = pools.filter((pool) => pool.id !== activePoolId);
      setPools(remaining);
      setSuccessMessage(`Deleted "${deletedPoolName}".`);

      // The loadPoolPokemon effect reacts to the new selection: the next
      // remaining pool's rows load, or the default new-pool working set when
      // nothing is left.
      setActivePoolId(remaining.length > 0 ? remaining[0].id : null);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to delete the pool.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  /** Updates a row's tier value (staged until Save). */
  function handleTierChange(rowId: string, nextTier: number) {
    setRows((current) =>
      current.map((row) =>
        row.key === rowId ? { ...row, tier_value: nextTier } : row,
      ),
    );
  }

  /**
   * Confirms a single Pokémon's tier change by persisting it immediately.
   *
   * Existing rows are updated by primary key; rows staged without a DB id
   * (e.g. CSV imports) are upserted on the pool's natural key and adopt the
   * generated id so they no longer read as pending. Only the owner may confirm.
   *
   * @param rowId - The client key of the row whose tier change to confirm.
   * @returns A promise resolving once the write completes.
   */
  async function handleConfirmTier(rowId: string) {
    if (!isOwner || isBusy) {
      return;
    }

    const row = rows.find((candidate) => candidate.key === rowId);
    if (!row || !activePoolId) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      if (row.id) {
        const { error: updateError } = await supabase
          .from("draft_pool_pokemon")
          .update({ tier_value: row.tier_value })
          .eq("id", row.id);

        if (updateError) {
          throw new Error(
            updateError.message || "Unable to confirm the tier change.",
          );
        }

        // Reflect the persisted tier in the saved baseline so this card's
        // pending state (and the dirty indicator) clears.
        setSavedRows((current) =>
          current.map((saved) =>
            saved.key === rowId
              ? { ...saved, tier_value: row.tier_value }
              : saved,
          ),
        );
      } else {
        const newId = crypto.randomUUID();
        const { error: upsertError } = await supabase
          .from("draft_pool_pokemon")
          .upsert(buildPoolRowPayload(row, activePoolId, newId), {
            onConflict: "draft_pool_id,pokemon_id",
          });

        if (upsertError) {
          throw new Error(
            upsertError.message || "Unable to confirm the tier change.",
          );
        }

        // Adopt the generated id and mirror the row into the saved baseline so
        // the editor no longer treats this tier as an unconfirmed change.
        setRows((current) =>
          current.map((candidate) =>
            candidate.key === rowId ? { ...candidate, id: newId } : candidate,
          ),
        );
        setSavedRows((current) => [
          ...current.filter((saved) => saved.pokemon_id !== row.pokemon_id),
          { ...row, id: newId },
        ]);
      }

      setSuccessMessage(
        `Confirmed ${row.species_name} as ${tierLabel(row.tier_value)}.`,
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to confirm the tier change.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  /** Toggles whether a pool row is available for drafting (staged). */
  function handleToggleInPool(rowId: string) {
    setRows((current) =>
      current.map((row) =>
        row.key === rowId ? { ...row, is_in_pool: !row.is_in_pool } : row,
      ),
    );
  }

  /** Stages removal of a Pokémon from the pool (persisted on Save). */
  function handleRemovePokemon(rowId: string) {
    setRows((current) =>
      current.filter((row) => row.key !== rowId),
    );
  }

  /** Toggles a row's selection for bulk actions. */
  function toggleSelection(rowId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }

  /** Applies a bulk status change to all selected rows. */
  function handleBulkStatus(nextInPool: boolean) {
    setRows((current) =>
      current.map((row) =>
        selectedIds.has(row.key)
          ? { ...row, is_in_pool: nextInPool }
          : row,
      ),
    );
  }

  /** Stages removal of all selected rows from the pool. */
  function handleBulkRemove() {
    setRows((current) =>
      current.filter((row) => !selectedIds.has(row.key)),
    );
    setSelectedIds(new Set());
  }

  /** Builds and downloads a CSV export of the current staged pool. */
  function handleExportCsv() {
    const header = ["pokemon_name", "tier", "status", "notes"];
    const csvLines = rows.map((row) => {
      const status = row.is_in_pool ? "in_pool" : "off_pool";
      const tier = row.is_in_pool ? String(row.tier_value) : "0";
      const notes = row.notes ?? "";
      return [row.species_name, tier, status, notes]
        .map((cell) =>
          /[",\n]/.test(cell)
            ? `"${cell.replace(/"/g, '""')}"`
            : cell,
        )
        .join(",");
    });

    const csv = [header.join(","), ...csvLines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeName = (poolName || "draft-pool").replace(/[^\w-]+/g, "-");
    link.href = url;
    link.download = `${safeName}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /** Imports a CSV file, resolving names against the catalog and staging rows. */
  async function handleImportCsvFile(file: File) {
    if (!file || isBusy || !isOwner) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const text = await file.text();
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (lines.length === 0) {
        setError("CSV file is empty.");
        return;
      }

      const imported: Array<{
        name: string;
        tier: number;
        inPool: boolean;
        notes: string;
      }> = [];

      for (const line of lines) {
        const cells = parseCsvLine(line);
        const name = cells[0] ?? "";
        const tier = Number(cells[1] ?? 0);
        const status = (cells[2] ?? "").toLowerCase();
        const notes = cells[3] ?? "";
        if (!name) {
          continue;
        }
        imported.push({
          name,
          tier: Number.isFinite(tier)
            ? Math.min(MAX_TIER, Math.max(0, Math.floor(tier)))
            : 0,
          inPool: status !== "off_pool",
          notes,
        });
      }

      if (imported.length === 0) {
        setError("No valid rows found in the CSV file.");
        return;
      }

      // Build the staged result in a slug-keyed map seeded with the current
      // rows so each CSV name updates its existing row (or merges into an
      // earlier import of the same slug) rather than producing duplicates.
      const importedRows = new Map<string, PoolPokemonRow>(
        rows.map((row) => [row.pokemon_id, row]),
      );
      let addedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      const skippedNames: string[] = [];

      for (const entry of imported) {
        // Resolve to a species or a distinct alternate form (regionals, Rotom
        // appliances, Deoxys formes, etc.); "(No Mega)" style names collapse to
        // their base species via the variant fallback.
        const match = await matchPokemonName(entry.name);
        if (!match) {
          skippedCount += 1;
          skippedNames.push(entry.name);
          continue;
        }

        const existing = importedRows.get(match.slug);
        if (existing) {
          importedRows.set(match.slug, {
            ...existing,
            tier_value: entry.tier,
            is_in_pool: entry.inPool,
            notes: entry.notes || existing.notes,
          });
          updatedCount += 1;
          continue;
        }

        importedRows.set(match.slug, {
          key: `new-${nextClientKeyRef.current++}`,
          id: null,
          dex: match.dexNumber,
          spriteId: match.spriteId,
          pokemon_id: match.slug,
          species_name: match.name,
          tier_value: entry.tier,
          is_in_pool: entry.inPool,
          type_primary: match.types[0] ?? null,
          type_secondary: match.types[1] ?? null,
          bst: match.bst,
          generation: match.generation,
          notes: entry.notes || null,
        });
        addedCount += 1;
      }

      setRows([...importedRows.values()]);

      // Report the full breakdown so a silently dropped name is visible: how many
      // rows were added, how many updated existing rows, and which names failed to
      // resolve (listing them, since an unresolved form/regional is the usual cause
      // of an "imported fewer than expected" result).
      const skippedDetail =
        skippedCount > 0
          ? ` Skipped ${skippedCount} unknown: ${skippedNames.slice(0, 12).join(", ")}${skippedCount > 12 ? ", …" : ""}.`
          : "";
      setSuccessMessage(
        `Imported ${imported.length} rows (${addedCount} new, ${updatedCount} updated).${skippedDetail}`,
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to import the CSV file.",
      );
    } finally {
      setIsBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  const inPoolCount = rows.filter((row) => row.is_in_pool).length;
  const tieredCount = rows.filter((row) => row.is_in_pool && row.tier_value > 0).length;
  const untieredCount = inPoolCount - tieredCount;

  // The active pool is the season's draft pool; used to badge the dropdown and
  // to disable the Set Pool button once this pool already holds that role.
  const selectedPool = pools.find((pool) => pool.id === activePoolId) ?? null;
  const selectedPoolIsActive = selectedPool?.is_active ?? false;

  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    for (const row of rows) {
      if (row.type_primary) {
        types.add(row.type_primary);
      }
      if (row.type_secondary) {
        types.add(row.type_secondary);
      }
    }
    return [...types].sort();
  }, [rows]);

  const availableGenerations = useMemo(() => {
    const gens = new Set<string>();
    for (const row of rows) {
      if (row.generation) {
        gens.add(row.generation);
      }
    }
    return [...gens].sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const query = filters.name.trim().toLowerCase();
    const next = rows.filter((row) => {
      if (filters.status === "in" && !row.is_in_pool) {
        return false;
      }
      if (filters.status === "out" && row.is_in_pool) {
        return false;
      }
      if (
        filters.type !== "all" &&
        row.type_primary !== filters.type &&
        row.type_secondary !== filters.type
      ) {
        return false;
      }
      if (
        filters.generation !== "all" &&
        row.generation !== filters.generation
      ) {
        return false;
      }
      if (query && !row.species_name.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });

    const direction = sortDir === "asc" ? 1 : -1;
    return next.sort((a, b) => {
      switch (sortKey) {
        case "dex":
          return (a.dex - b.dex) * direction;
        case "name":
          return a.species_name.localeCompare(b.species_name) * direction;
        case "type":
          return ((a.type_primary ?? "") + (a.type_secondary ?? "")).localeCompare(
            (b.type_primary ?? "") + (b.type_secondary ?? ""),
          ) * direction;
        case "bst":
          return ((a.bst ?? -1) - (b.bst ?? -1)) * direction;
        case "gen":
          return ((a.generation ?? "")).localeCompare(b.generation ?? "") * direction;
        case "status":
          return (Number(a.is_in_pool) - Number(b.is_in_pool)) * direction;
        case "tier":
          return (a.tier_value - b.tier_value) * direction;
      }
    });
  }, [rows, filters, sortKey, sortDir]);

  // A Pokémon's persisted (saved) tier is the "known" value the tier cards
  // group by; a staged tier change does not move the card until confirmed.
  const savedTierByKey = useMemo(() => {
    const tiers = new Map<string, number>();
    for (const saved of savedRows) {
      tiers.set(saved.key, saved.tier_value);
    }
    return tiers;
  }, [savedRows]);

  const groupedByTier = useMemo(() => {
    const groups = new Map<number, PoolPokemonRow[]>();
    const poolRows = rows.filter((row) => row.is_in_pool);

    for (const row of poolRows) {
      // Group by the saved tier so a card stays in place while its tier edit is
      // still pending; confirming the change moves it into the new group.
      const tier = savedTierByKey.get(row.key) ?? 0;
      const list = groups.get(tier) ?? [];
      list.push(row);
      groups.set(tier, list);
    }

    // Descending tiers, unranked (0) always last.
    const tiers = [...groups.keys()].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : b - a));
    return tiers.map((tier) => ({
      tier,
      label: tierLabel(tier),
      rows: groups.get(tier) ?? [],
    }));
  }, [rows, savedTierByKey]);

  // Tier-card check marks stay disabled until a row's current tier differs
  // from the last-saved baseline; rows staged without a saved entry baseline at 0.
  const pendingTierKeys = useMemo(() => {
    const pending = new Set<string>();
    for (const row of rows) {
      if ((savedTierByKey.get(row.key) ?? 0) !== row.tier_value) {
        pending.add(row.key);
      }
    }
    return pending;
  }, [rows, savedTierByKey]);

  /** Toggles the sort key/direction when a sortable header is clicked. */
  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading draft pool...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold text-white">{leagueName} Pool</h1>
        </header>

        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="rounded-xl border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200">
            {successMessage}
          </div>
        )}

        {isDirty && (
          <div className="rounded-xl border border-amber-800 bg-amber-950/60 px-4 py-3 text-sm text-amber-200">
            You have unsaved changes. Click Save to persist them.
          </div>
        )}

        {!isOwner && (
          <p className="rounded-xl border border-amber-800 bg-amber-950/60 px-4 py-3 text-sm text-amber-200">
            Read-only view: only the league owner can edit the draft pool.
          </p>
        )}

        {/* Top bar: pool selection + pool management + document actions */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-slate-950/40">
          <div className="flex flex-col gap-5">
            {/* Row 1: saved pool / name, plus the pool management buttons */}
            <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <span className="whitespace-nowrap">Saved Draft Pools</span>
                  <select
                    value={activePoolId ?? ""}
                    onChange={(event) => handlePoolSwitch(event.target.value)}
                    disabled={pools.length === 0}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-400"
                  >
                    {pools.length === 0 ? (
                      <option value="">No saved pools</option>
                    ) : (
                      <>
                        <option value="">Start a new pool</option>
                        {pools.map((pool) => (
                          <option key={pool.id} value={pool.id}>
                            {pool.is_active ? `${pool.name} (active)` : pool.name}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                </label>

                {isOwner && (
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <span className="whitespace-nowrap">Name</span>
                    <input
                      value={poolName}
                      onChange={(event) => setPoolName(event.target.value)}
                      placeholder="Pool name"
                      maxLength={60}
                      className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-400"
                    />
                    {selectedPoolIsActive && (
                      <span className="whitespace-nowrap rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                        Active
                      </span>
                    )}
                  </label>
                )}
              </div>

              {isOwner && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={startNewPool}
                    disabled={isBusy}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    New pool
                  </button>

                  {pools.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleDeletePool()}
                      disabled={isBusy || !activePoolId}
                      title={
                        activePoolId
                          ? "Delete the selected draft pool"
                          : "Select a saved pool to delete it"
                      }
                      className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-2.5 text-sm font-medium text-red-200 transition hover:border-red-700 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Delete pool
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Divider between pool selection and document actions */}
            <div className="h-px bg-slate-800/60" />

            {/* Row 2: CSV import/export on the left, save / set pool on the right */}
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleExportCsv}
                  disabled={rows.length === 0}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Export CSV
                </button>

                {isOwner && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          void handleImportCsvFile(file);
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isBusy}
                      className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Import CSV
                    </button>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {isOwner && (
                  <button
                    type="button"
                    onClick={() => void handleSetActivePool()}
                    disabled={isBusy || !activePoolId || isDirty || selectedPoolIsActive}
                    title={
                      selectedPoolIsActive
                        ? "This pool is already the active draft pool"
                        : isDirty
                          ? "Save your changes first"
                          : "Set this pool as the one the draft uses"
                    }
                    className="rounded-xl border border-sky-500/60 bg-sky-500/10 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {selectedPoolIsActive ? "Active Pool" : "Set Pool"}
                  </button>
                )}

                {isOwner && (
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={isBusy || !isDirty}
                    className="rounded-xl border border-emerald-500/60 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isBusy ? "Saving..." : "Save"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Summary panel */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-emerald-800 bg-emerald-950/40 p-5">
            <p className="text-xs uppercase tracking-wider text-emerald-300">
              In Pool
            </p>
            <p className="mt-1 text-2xl font-bold text-emerald-200">{inPoolCount}</p>
          </div>
          <div className="rounded-2xl border border-amber-800 bg-amber-950/40 p-5">
            <p className="text-xs uppercase tracking-wider text-amber-300">Tiered</p>
            <p className="mt-1 text-2xl font-bold text-amber-200">{tieredCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <p className="text-xs uppercase tracking-wider text-slate-400">
              Not Tiered
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-200">{untieredCount}</p>
          </div>
        </section>

        {/* Tabs: Tiers and Table */}
        <div className="flex items-center gap-2 text-sm">
          {(
            [
              { key: "table", label: "Table" },
              { key: "tiers", label: "Tiers" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setSelectedTab(tab.key)}
              className={`rounded-xl border px-4 py-2 font-medium transition ${
                selectedTab === tab.key
                  ? "border-amber-400 bg-amber-500/10 text-amber-200"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Table tab with sorting and filtering */}
        {selectedTab === "table" && (
          <section className="space-y-4">
            <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 sm:flex-row sm:items-center">
              <input
                type="search"
                value={filters.name}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Search by name..."
                className="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-amber-400"
              />
              <select
                value={filters.type}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    type: event.target.value,
                  }))
                }
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-400"
              >
                <option value="all">All types</option>
                {availableTypes.map((type) => (
                  <option key={type} value={type}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </option>
                ))}
              </select>
              <select
                value={filters.generation}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    generation: event.target.value,
                  }))
                }
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-400"
              >
                <option value="all">All generations</option>
                {availableGenerations.map((gen) => (
                  <option key={gen} value={gen}>
                    {gen}
                  </option>
                ))}
              </select>
              <select
                value={filters.status}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-400"
              >
                <option value="all">All statuses</option>
                <option value="in">In Pool</option>
                <option value="out">Off Pool</option>
              </select>
            </div>

            {isOwner && selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
                <span>
                  {selectedIds.size} selected
                </span>
                <button
                  type="button"
                  onClick={() => handleBulkStatus(true)}
                  className="rounded-lg border border-emerald-700 bg-emerald-950/60 px-3 py-1.5 text-xs font-semibold text-emerald-200"
                >
                  Set In Pool
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkStatus(false)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300"
                >
                  Set Off Pool
                </button>
                <button
                  type="button"
                  onClick={handleBulkRemove}
                  className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-1.5 text-xs font-semibold text-red-200"
                >
                  Remove
                </button>
              </div>
            )}

            <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl shadow-slate-950/40">
              {filteredRows.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400">
                  {rows.length === 0
                    ? isOwner
                      ? "No Pokémon yet. Save the pool to persist its contents."
                      : "The league owner has not set up the draft pool yet."
                    : "No Pokémon match the current filters."}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-800 bg-slate-950/60 text-xs uppercase tracking-wider text-slate-500">
                      <tr>
                        {isOwner && (
                          <th className="px-4 py-3" scope="col">
                            <input
                              type="checkbox"
                              checked={
                                filteredRows.length > 0 &&
                                filteredRows.every((row) =>
                                  selectedIds.has(row.key),
                                )
                              }
                              onChange={() => {
                                const allSelected = filteredRows.every((row) =>
                                  selectedIds.has(row.key),
                                );
                                setSelectedIds((current) => {
                                  const next = new Set(current);
                                  if (allSelected) {
                                    for (const row of filteredRows) {
                                      next.delete(row.key);
                                    }
                                  } else {
                                    for (const row of filteredRows) {
                                      next.add(row.key);
                                    }
                                  }
                                  return next;
                                });
                              }}
                              aria-label="Select all"
                              className="h-4 w-4 accent-emerald-500"
                            />
                          </th>
                        )}
                        <SortHeader label="Dex" column="dex" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Pokémon" column="name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Type" column="type" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="BST" column="bst" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Gen" column="gen" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Status" column="status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Tier" column="tier" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((row) => (
                        <tr
                          key={row.key}
                          className="border-b border-slate-800/60 last:border-b-0"
                        >
                          {isOwner && (
                            <td className="px-4 py-3">
                              <input
                                type="checkbox"
                                checked={selectedIds.has(row.key)}
                                onChange={() => toggleSelection(row.key)}
                                aria-label={`Select ${row.species_name}`}
                                className="h-4 w-4 accent-emerald-500"
                              />
                            </td>
                          )}
                          <td className="px-4 py-3 text-slate-500">
                            {row.dex > 0 ? `#${row.dex}` : "—"}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <Sprite spriteId={row.spriteId} name={row.species_name} size={40} />
                              <span className="font-medium text-slate-100">
                                {row.species_name}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {row.type_primary && (
                                <span
                                  className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                                    TYPE_STYLES[row.type_primary] ?? "bg-slate-700 text-slate-200"
                                  }`}
                                >
                                  {row.type_primary.charAt(0).toUpperCase() +
                                    row.type_primary.slice(1)}
                                </span>
                              )}
                              {row.type_secondary && (
                                <span
                                  className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                                    TYPE_STYLES[row.type_secondary] ?? "bg-slate-700 text-slate-200"
                                  }`}
                                >
                                  {row.type_secondary.charAt(0).toUpperCase() +
                                    row.type_secondary.slice(1)}
                                </span>
                              )}
                              {!row.type_primary && (
                                <span className="text-slate-600">—</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-300">
                            {row.bst ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-slate-300">
                            {row.generation ? generationNumber(row.generation) : "—"}
                          </td>
                          <td className="px-4 py-3">
                            {isOwner ? (
                              <button
                                type="button"
                                onClick={() => handleToggleInPool(row.key)}
                                className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                                  row.is_in_pool
                                    ? "bg-emerald-500/10 text-emerald-200"
                                    : "bg-slate-800 text-slate-400"
                                }`}
                              >
                                {row.is_in_pool ? "In" : "Off"}
                              </button>
                            ) : (
                              <span
                                className={`text-xs font-semibold ${
                                  row.is_in_pool ? "text-emerald-300" : "text-slate-500"
                                }`}
                              >
                                {row.is_in_pool ? "In pool" : "Off pool"}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {!row.is_in_pool ? (
                              <span className="text-slate-600">—</span>
                            ) : isOwner ? (
                              <input
                                type="number"
                                min={0}
                                max={MAX_TIER}
                                step={1}
                                value={row.tier_value}
                                onChange={(event) =>
                                  handleTierChange(
                                    row.key,
                                    parseTier(event.target.value, row.tier_value),
                                  )
                                }
                                className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-amber-400"
                              />
) : (
                              <span className="text-slate-300">
                                {row.tier_value > 0 ? row.tier_value : "—"}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Tiers tab */}
        {selectedTab === "tiers" && (
          <div className="space-y-6">
            {groupedByTier.length === 0 ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center text-sm text-slate-400">
                No in-pool Pokémon to tier yet.
              </div>
            ) : (
              groupedByTier.map((group) => (
                <section
                  key={group.tier}
                  className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-slate-950/40"
                >
                  <h2 className="mb-4 text-lg font-semibold text-white">
                    {group.label}
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      {group.rows.length} Pokémon
                    </span>
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {group.rows.map((row) => (
                      <div
                        key={row.key}
                        className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3"
                      >
                        <Sprite spriteId={row.spriteId} name={row.species_name} size={48} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-100">
                            {row.species_name}
                          </p>
                          <p className="text-xs text-slate-500">
                            {row.type_primary
                              ? row.type_primary.charAt(0).toUpperCase() +
                                row.type_primary.slice(1) +
                                (row.type_secondary
                                  ? " / " +
                                    row.type_secondary.charAt(0).toUpperCase() +
                                    row.type_secondary.slice(1)
                                  : "")
                              : "No data"}
                          </p>
                        </div>
                        {isOwner && (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              max={MAX_TIER}
                              step={1}
                              value={row.tier_value}
                              onChange={(event) =>
                                handleTierChange(
                                  row.key,
                                  parseTier(event.target.value, row.tier_value),
                                )
                              }
                              aria-label={`Tier for ${row.species_name}`}
                              className="w-14 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
                            />
                            <button
                              type="button"
                              onClick={() => void handleConfirmTier(row.key)}
                              disabled={!pendingTierKeys.has(row.key) || isBusy}
                              title={
                                pendingTierKeys.has(row.key)
                                  ? `Confirm tier ${tierLabel(row.tier_value)}`
                                  : "Change the tier to enable confirmation"
                              }
                              aria-label={`Confirm tier for ${row.species_name}`}
                              className="shrink-0 rounded-lg border border-emerald-500/60 bg-emerald-500/10 px-2 py-1 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-emerald-500/10"
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemovePokemon(row.key)}
                              aria-label={`Remove ${row.species_name}`}
                              className="shrink-0 rounded-lg border border-red-800 bg-red-950/60 px-2 py-1 text-xs font-bold text-red-200 transition hover:bg-red-900/60"
                            >
                              X
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}
      </div>
    </main>
  );
}