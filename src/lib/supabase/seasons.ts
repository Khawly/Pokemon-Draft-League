/*
 * Season helpers for the Pokemon Draft League.
 *
 * Loads a league's latest season (tolerating a database that predates the
 * optional season name column), builds the season label shown across the app,
 * and exposes the owner-only RPC that renames the current season.
 */
import { supabase } from "@/lib/supabase/client";

/** The season columns every page needs for labelling. */
export type SeasonLabel = {
  season_number: number;
  name?: string | null;
};

/** Result of {@link loadLatestSeason}, mirroring the shape the pages expect. */
export type LatestSeasonResult<T> = {
  data: T | null;
  error: Error | null;
};

/**
 * Loads a league's most recent season row.
 *
 * The `name` column arrived in a later migration than the rest of the schema, so
 * the query is retried without it when the database rejects the column. That
 * keeps pages working on a league whose migrations are not fully applied yet.
 *
 * @param leagueId - League whose latest season should be loaded.
 * @param columns - Comma separated column list; must include `season_number`.
 * @returns The season row, or null when the league has no seasons.
 */
export async function loadLatestSeason<T>(
  leagueId: string,
  columns: string,
): Promise<LatestSeasonResult<T>> {
  const run = async (select: string) =>
    supabase
      .from("seasons")
      .select(select)
      .eq("league_id", leagueId)
      .order("season_number", { ascending: false })
      .limit(1)
      .maybeSingle();

  const { data, error } = await run(columns);

  if (!error) {
    return { data: (data as T | null) ?? null, error: null };
  }

  if (!columns.includes("name")) {
    return { data: null, error };
  }

  const { data: legacyData, error: legacyError } = await run(
    columns.replace("name, ", "").replace(", name", ""),
  );

  if (legacyError) {
    return { data: null, error: legacyError };
  }

  return { data: (legacyData as T | null) ?? null, error: null };
}

/**
 * Builds the label used wherever the app names the active season.
 *
 * Prefers the owner-set name and falls back to the numbered form, so seasons
 * without a name keep reading as "Season 3".
 *
 * @param season - Season row, or null/undefined when no season is resolved.
 * @returns The season name, the numbered fallback, or an em dash when unknown.
 */
export function formatSeasonLabel(season?: SeasonLabel | null): string {
  if (!season) {
    return "—";
  }

  const name = season.name?.trim();

  return name || `Season ${season.season_number}`;
}

/**
 * Renames the league's current season, or clears the name when blank.
 *
 * @param leagueId - League whose latest season should be renamed.
 * @param name - Desired season name; trimmed server-side, blank clears it.
 * @throws If the season name RPC rejects the change.
 */
export async function saveSeasonName(leagueId: string, name: string): Promise<void> {
  const { error } = await supabase.rpc("set_season_name", {
    p_league_id: leagueId,
    p_name: name.trim(),
  });

  if (error) {
    throw new Error(error.message);
  }
}
