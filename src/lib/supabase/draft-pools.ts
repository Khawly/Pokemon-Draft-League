/*
 * Draft pool reads and writes for the pool editor.
 *
 * Owns the saved pool list, the paged row reads (and archive fallback), and the
 * save, activate, delete, and single-row writes the page performs.
 */
import { getPokemonEntryBySlug } from "@/lib/pokeapi";
import { supabase } from "@/lib/supabase/client";
import { createUuid } from "@/lib/uuid";

/** A saved draft pool. */
export interface PoolSummary {
  id: string;
  name: string;
  is_active: boolean;
}

/** A pool Pokémon row enriched with catalog metadata. */
export interface PoolPokemonRow {
  key: string;
  id: string | null;
  dex: number;
  spriteId: number;
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  is_in_pool: boolean;
  type_primary: string | null;
  type_secondary: string | null;
  bst: number | null;
  generation: string | null;
  notes: string | null;
}

/** A `draft_pool_pokemon` row as stored. */
interface PoolRowRecord {
  id: string;
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  is_in_pool: boolean;
  notes: string | null;
}

/** Compact tuple stored in `draft_pool_archives.pokemon`. */
type ArchivedPoolEntry = [
  pokemon_id: string,
  species_name: string,
  tier_value: number,
  is_in_pool: boolean,
  notes: string | null,
];

/** Rows fetched per request; matches PostgREST's default response cap. */
const POOL_PAGE_SIZE = 1000;

/**
 * Reads a closed season's pool from its compressed archive snapshot.
 *
 * @param poolId - The archived pool id.
 * @param options - `inPoolOnly` narrows the result to enabled species.
 * @returns The archived rows, or null when no archive exists.
 * @throws When the archive query fails.
 */
async function fetchArchivedPoolRows(
  poolId: string,
  options: { inPoolOnly?: boolean } = {},
): Promise<PoolPokemonRow[] | null> {
  const { data, error } = await supabase
    .from("draft_pool_archives")
    .select("pokemon")
    .eq("draft_pool_id", poolId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "The archived pool could not be loaded.");
  }

  if (!data) {
    return null;
  }

  const entries = (data as { pokemon: ArchivedPoolEntry[] }).pokemon ?? [];

  return entries
    .filter((entry) => !options.inPoolOnly || entry[3])
    .map(([pokemon_id, species_name, tier_value, is_in_pool, notes]) => {
      const match = getPokemonEntryBySlug(pokemon_id);

      return {
        key: `archived:${pokemon_id}`,
        id: null,
        dex: match?.dexNumber ?? 0,
        spriteId: match?.spriteId ?? 0,
        pokemon_id,
        species_name: species_name || match?.name || pokemon_id,
        tier_value,
        is_in_pool,
        type_primary: match?.types[0] ?? null,
        type_secondary: match?.types[1] ?? null,
        bst: match?.bst ?? null,
        generation: match?.generation ?? null,
        notes,
      };
    });
}

/**
 * Fetches the Pokémon rows for a draft pool.
 *
 * Checks the archive snapshot first, then pages through the live table: a
 * configured pool holds more rows than a single PostgREST response returns.
 *
 * @param poolId - The pool whose rows to fetch.
 * @param options - `inPoolOnly` narrows the read to enabled species.
 * @returns The ordered rows.
 * @throws When the archive or a page query fails.
 */
export async function fetchPoolRows(
  poolId: string,
  options: { inPoolOnly?: boolean } = {},
): Promise<PoolPokemonRow[]> {
  const archived = await fetchArchivedPoolRows(poolId, options);

  if (archived !== null) {
    return archived;
  }

  const allRows: PoolRowRecord[] = [];

  for (let from = 0; ; from += POOL_PAGE_SIZE) {
    let query = supabase
      .from("draft_pool_pokemon")
      .select("id, pokemon_id, species_name, tier_value, is_in_pool, notes")
      .eq("draft_pool_id", poolId);

    if (options.inPoolOnly) {
      query = query.eq("is_in_pool", true);
    }

    const { data, error } = await query
      .order("id", { ascending: true })
      .range(from, from + POOL_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message || "The pool could not be loaded.");
    }

    const page = (data ?? []) as PoolRowRecord[];
    allRows.push(...page);

    if (page.length < POOL_PAGE_SIZE) {
      break;
    }
  }

  return allRows.map((row) => {
    const match = getPokemonEntryBySlug(row.pokemon_id);

    return {
      key: row.id,
      id: row.id,
      dex: match?.dexNumber ?? 0,
      spriteId: match?.spriteId ?? 0,
      pokemon_id: row.pokemon_id,
      species_name: row.species_name || match?.name || row.pokemon_id,
      tier_value: row.tier_value,
      is_in_pool: row.is_in_pool,
      type_primary: match?.types[0] ?? null,
      type_secondary: match?.types[1] ?? null,
      bst: match?.bst ?? null,
      generation: match?.generation ?? null,
      notes: row.notes,
    };
  });
}

/**
 * Builds the database payload for a pool row.
 *
 * @param row - The row to persist.
 * @param poolId - The pool the row belongs to.
 * @param id - The UUID to write for new rows.
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
 * Creates a draft pool.
 *
 * @param leagueId - The league owning the pool.
 * @param seasonId - The season the pool belongs to.
 * @param userId - The owner creating it.
 * @param name - The pool's display name.
 * @returns The created pool id.
 * @throws When the insert is rejected.
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
 * Loads the league row the pool editor needs.
 *
 * @param leagueId - The league to read.
 * @returns The league, or null when it cannot be read.
 */
export async function loadPoolLeague(
  leagueId: string,
): Promise<{ id: string; name: string; owner_id: string } | null> {
  const { data, error } = await supabase
    .from("leagues")
    .select("id, name, owner_id")
    .eq("id", leagueId)
    .maybeSingle();

  return error || !data ? null : data;
}

/**
 * Loads the saved pools for a season.
 *
 * Empty legacy "Default Pool" placeholders are hidden; once the owner has saved
 * Pokémon into one it is real data and stays.
 *
 * @param leagueId - The league owning the pools.
 * @param seasonId - The season to read.
 * @returns The visible pools, oldest first.
 * @throws When the pool list cannot be read.
 */
export async function loadSavedPools(
  leagueId: string,
  seasonId: string,
): Promise<PoolSummary[]> {
  const { data: poolRows, error: poolsError } = await supabase
    .from("draft_pools")
    .select("id, name, is_active")
    .eq("league_id", leagueId)
    .eq("season_id", seasonId)
    .order("created_at", { ascending: true });

  if (poolsError) {
    throw new Error(
      poolsError.message || "The draft pools could not be loaded.",
    );
  }

  const poolList = (poolRows ?? []) as PoolSummary[];
  const legacyDefaultIds = poolList
    .filter((pool) => pool.name.trim().toLowerCase() === "default pool")
    .map((pool) => pool.id);

  if (legacyDefaultIds.length === 0) {
    return poolList;
  }

  const { data: legacyRows, error: legacyError } = await supabase
    .from("draft_pool_pokemon")
    .select("draft_pool_id")
    .in("draft_pool_id", legacyDefaultIds);

  if (legacyError) {
    return poolList;
  }

  const poolsWithRows = new Set(
    ((legacyRows ?? []) as { draft_pool_id: string }[]).map(
      (row) => row.draft_pool_id,
    ),
  );

  return poolList.filter(
    (pool) => !legacyDefaultIds.includes(pool.id) || poolsWithRows.has(pool.id),
  );
}

/**
 * Reads the saved row for a pool.
 *
 * @param poolId - The pool to read.
 * @returns The row, or null when the pool no longer exists.
 */
export async function loadActivePoolRow(
  poolId: string,
): Promise<PoolSummary | null> {
  const { data, error } = await supabase
    .from("draft_pools")
    .select("id, name")
    .eq("id", poolId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as PoolSummary | null) ?? null;
}

/**
 * Persists a pool and its rows.
 *
 * Creates the pool when needed, renames it when the name changed, upserts rows
 * by id and natural key, and deletes rows removed from the editor.
 *
 * @param input - The pool identity and rows to write.
 * @returns The id of the pool that was written.
 * @throws When any write is rejected.
 */
export async function savePoolRows({
  poolId,
  name,
  rows,
  savedRows,
  leagueId,
  seasonId,
  userId,
}: {
  poolId: string | null;
  name: string;
  rows: PoolPokemonRow[];
  savedRows: PoolPokemonRow[];
  leagueId: string;
  seasonId: string;
  userId: string;
}): Promise<string> {
  let targetPoolId = poolId;

  if (!targetPoolId) {
    targetPoolId = await createPool(leagueId, seasonId, userId, name);
  } else {
    const currentPool = await loadActivePoolRow(targetPoolId);

    if (!currentPool) {
      throw new Error("The active draft pool no longer exists.");
    }

    if (currentPool.name !== name) {
      const { error } = await supabase
        .from("draft_pools")
        .update({ name })
        .eq("id", targetPoolId);

      if (error) {
        throw new Error(error.message || "Unable to rename the pool.");
      }
    }
  }

  const dedupedBySlug = new Map<string, PoolPokemonRow>();

  for (const row of rows) {
    const existing = dedupedBySlug.get(row.pokemon_id);

    if (!existing || (existing.id === null && row.id !== null)) {
      dedupedBySlug.set(row.pokemon_id, row);
    }
  }

  const dedupedRows = [...dedupedBySlug.values()];
  const existingRows = dedupedRows.filter((row) => row.id !== null);
  const insertRows = dedupedRows.filter((row) => row.id === null);

  if (existingRows.length > 0) {
    const { error } = await supabase
      .from("draft_pool_pokemon")
      .upsert(
        existingRows.map((row) => buildPoolRowPayload(row, targetPoolId, row.id)),
        { onConflict: "id" },
      );

    if (error) {
      throw new Error(error.message || "Unable to save the pool.");
    }
  }

  if (insertRows.length > 0) {
    const { error } = await supabase
      .from("draft_pool_pokemon")
      .upsert(
        insertRows.map((row) =>
          buildPoolRowPayload(row, targetPoolId, createUuid()),
        ),
        { onConflict: "draft_pool_id,pokemon_id" },
      );

    if (error) {
      throw new Error(error.message || "Unable to save the pool.");
    }
  }

  const deletedIds = savedRows
    .filter(
      (saved) =>
        saved.id &&
        !dedupedRows.some((row) => row.pokemon_id === saved.pokemon_id),
    )
    .map((saved) => saved.id)
    .filter((id): id is string => id !== null);

  if (deletedIds.length > 0) {
    const { error } = await supabase
      .from("draft_pool_pokemon")
      .delete()
      .in("id", deletedIds);

    if (error) {
      throw new Error(error.message || "Unable to remove Pokémon.");
    }
  }

  return targetPoolId;
}

/**
 * Marks one pool as the season's active draft pool.
 *
 * @param poolId - The pool to activate.
 * @throws When the RPC fails.
 */
export async function setActivePool(poolId: string): Promise<void> {
  const { error } = await supabase.rpc("set_active_draft_pool", {
    p_pool_id: poolId,
  });

  if (error) {
    throw new Error(error.message || "Unable to set the active pool.");
  }
}

/**
 * Deletes a pool and its rows.
 *
 * @param poolId - The pool to delete.
 * @throws When the delete is rejected.
 */
export async function deletePool(poolId: string): Promise<void> {
  const { error } = await supabase
    .from("draft_pools")
    .delete()
    .eq("id", poolId);

  if (error) {
    throw new Error(error.message || "Unable to delete the pool.");
  }
}

/**
 * Writes a saved row's tier.
 *
 * @param rowId - The row's primary key.
 * @param tierValue - The new tier.
 * @throws When the update is rejected.
 */
export async function updatePoolRowTier(
  rowId: string,
  tierValue: number,
): Promise<void> {
  const { error } = await supabase
    .from("draft_pool_pokemon")
    .update({ tier_value: tierValue })
    .eq("id", rowId);

  if (error) {
    throw new Error(error.message || "Unable to confirm the tier change.");
  }
}

/**
 * Upserts an unsaved row under the pool's natural key.
 *
 * @param row - The staged row.
 * @param poolId - The pool the row belongs to.
 * @param id - The UUID to write.
 * @throws When the upsert is rejected.
 */
export async function upsertPoolRow(
  row: PoolPokemonRow,
  poolId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("draft_pool_pokemon")
    .upsert(buildPoolRowPayload(row, poolId, id), {
      onConflict: "draft_pool_id,pokemon_id",
    });

  if (error) {
    throw new Error(error.message || "Unable to confirm the tier change.");
  }
}
