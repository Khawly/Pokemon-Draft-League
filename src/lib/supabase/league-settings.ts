/*
 * League settings rows for the draft and league settings pages.
 *
 * Both pages read and write the same `league_settings` table, one row per
 * league-season. Keeping the column names here stops each page from spelling out
 * the same select and upsert payload.
 */
import { supabase } from "@/lib/supabase/client";
import { requireClock } from "@/lib/validation";

/** The columns the draft settings page reads. */
export interface LeagueSettingsRow {
  draft_format: string | null;
  total_rounds: number | null;
  enable_pokemon_costs: boolean | null;
  total_token_salary: number | null;
  allow_per_team_salary: boolean | null;
  pick_time_limit_minutes: number | null;
  auto_pick_on_timeout: boolean | null;
  skip_player_on_timeout: boolean | null;
  quiet_hours_enabled: boolean | null;
  quiet_hours_start_est: string | null;
  quiet_hours_end_est: string | null;
  /** Absolute instant the seasonal draft is scheduled to start, or null. */
  draft_at: string | null;
}

/** The draft settings payload written by the settings page. */
export type LeagueSettingsWrite = Omit<
  LeagueSettingsRow,
  "quiet_hours_start_est" | "quiet_hours_end_est"
> & {
  league_id: string;
  season_id: string;
  quiet_hours_start_est: string | null;
  quiet_hours_end_est: string | null;
};

/**
 * Reads the settings row for one league-season.
 *
 * @param leagueId - The league whose settings to read.
 * @param seasonId - The season whose settings to read.
 * @returns The row, or null when none has been saved yet.
 * @throws When the read fails.
 */
export async function loadLeagueSettingsRow(
  leagueId: string,
  seasonId: string,
): Promise<LeagueSettingsRow | null> {
  const { data, error } = await supabase
    .from("league_settings")
    .select("*")
    .eq("league_id", leagueId)
    .eq("season_id", seasonId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as LeagueSettingsRow | null) ?? null;
}

/**
 * Writes the settings row for one league-season.
 *
 * @param row - The settings to persist.
 * @throws When the write fails.
 */
export async function saveLeagueSettingsRow(
  row: LeagueSettingsWrite,
): Promise<void> {
  if (
    row.total_rounds == null ||
    !Number.isInteger(row.total_rounds) ||
    row.total_rounds < 1
  ) {
    throw new Error("Total rounds must be a whole number of at least 1.");
  }

  if (
    row.pick_time_limit_minutes == null ||
    !Number.isInteger(row.pick_time_limit_minutes) ||
    row.pick_time_limit_minutes < 1
  ) {
    throw new Error("Pick time limit must be a whole number of at least 1.");
  }

  if (
    row.total_token_salary != null &&
    (!Number.isInteger(row.total_token_salary) ||
      row.total_token_salary < 0)
  ) {
    throw new Error(
      "Total token salary must be a whole number of 0 or more.",
    );
  }

  if (row.quiet_hours_enabled) {
    const start = requireClock(
      row.quiet_hours_start_est ?? "",
      "Quiet hours start",
    );
    const end = requireClock(row.quiet_hours_end_est ?? "", "Quiet hours end");

    if (start === end) {
      throw new Error("Quiet hours start and end must be different times.");
    }
  }

  const { error } = await supabase
    .from("league_settings")
    .upsert(row, { onConflict: "league_id, season_id" });

  if (error) {
    throw new Error(error.message);
  }
}

/** A league membership as the settings page reads it. */
export interface LeagueMembershipRow {
  league_id: string;
  role: string | null;
  leagues: { name?: string | null } | null;
}

/** Optional league columns the page probes for before rendering or saving. */
export interface LeagueColumns {
  number_of_players: number | null;
  image_url: string | null;
  supported: boolean;
}

/** Trade, cost, and matchup columns stored on `league_settings`. */
export interface LeagueRulesSettings {
  enable_transaction_costs: boolean | null;
  transaction_cost: number | null;
  admins_approve_trades: boolean | null;
  owners_admins_vote_on_trades: boolean | null;
  allow_token_trades: boolean | null;
  enable_pokemon_costs: boolean | null;
  admins_edit_matchups: boolean | null;
  trade_deadline_at: string | null;
  free_agency_deadline_at: string | null;
}

/** Column list shared by the settings read and the save-time schema probe. */
const LEAGUE_RULES_COLUMNS =
  "enable_transaction_costs, transaction_cost, admins_approve_trades, owners_admins_vote_on_trades, allow_token_trades, enable_pokemon_costs, admins_edit_matchups, trade_deadline_at, free_agency_deadline_at";

/**
 * Columns the save path needs. `enable_pokemon_costs` is read but not required
 * here, matching what the save has always probed for.
 */
const LEAGUE_RULES_PROBE_COLUMNS =
  "enable_transaction_costs, transaction_cost, admins_approve_trades, owners_admins_vote_on_trades, allow_token_trades, admins_edit_matchups, trade_deadline_at, free_agency_deadline_at";

/**
 * Loads a member's active league memberships, newest first.
 *
 * @param userId - The member whose memberships to read.
 * @returns The memberships and whether the read failed.
 */
export async function loadOwnerMemberships(
  userId: string,
): Promise<{ memberships: LeagueMembershipRow[]; error: boolean }> {
  const { data, error } = await supabase
    .from("league_members")
    .select("league_id, role, leagues(name)")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("joined_at", { ascending: false });

  return {
    memberships: (data ?? []) as LeagueMembershipRow[],
    error: Boolean(error),
  };
}

/**
 * Reads the optional league columns.
 *
 * @param leagueId - The league to read.
 * @returns The column values and whether the columns exist.
 */
export async function loadLeagueColumns(
  leagueId: string,
): Promise<LeagueColumns> {
  const { data, error } = await supabase
    .from("leagues")
    .select("number_of_players, image_url")
    .eq("id", leagueId)
    .maybeSingle();

  if (error || !data) {
    return { number_of_players: null, image_url: null, supported: false };
  }

  const row = data as {
    number_of_players?: number | null;
    image_url?: string | null;
  };

  return {
    number_of_players:
      typeof row.number_of_players === "number" &&
      Number.isFinite(row.number_of_players)
        ? row.number_of_players
        : null,
    image_url: row.image_url ?? null,
    supported: true,
  };
}

/**
 * Reads the trade, cost, and matchup columns for one league-season.
 *
 * @param leagueId - The league whose settings to read.
 * @param seasonId - The season whose settings to read.
 * @param probe - True to only check that the columns exist.
 * @returns The row (null in probe mode) and whether the columns exist.
 */
export async function loadLeagueRulesSettings(
  leagueId: string,
  seasonId: string,
  probe = false,
): Promise<{ data: LeagueRulesSettings | null; supported: boolean }> {
  const query = supabase
    .from("league_settings")
    .select(probe ? LEAGUE_RULES_PROBE_COLUMNS : LEAGUE_RULES_COLUMNS)
    .eq("league_id", leagueId)
    .eq("season_id", seasonId);

  const { data, error } = probe
    ? await query.limit(1)
    : await query.maybeSingle();

  if (error) {
    return { data: null, supported: false };
  }

  if (probe) {
    return { data: null, supported: Array.isArray(data) || Boolean(data) };
  }

  return { data: (data as LeagueRulesSettings | null) ?? null, supported: true };
}

/**
 * Updates the league's own row.
 *
 * @param leagueId - The league to update.
 * @param payload - The columns to write.
 * @throws When the write is rejected.
 */
export async function updateLeagueRow(
  leagueId: string,
  payload: {
    name: string;
    number_of_players?: number;
    image_url?: string | null;
  },
): Promise<void> {
  const trimmedName = payload.name.trim();

  if (!trimmedName) {
    throw new Error("League name is required.");
  }

  if (trimmedName.length > 32) {
    throw new Error("League name must be 32 characters or fewer.");
  }

  if (
    payload.number_of_players != null &&
    (!Number.isInteger(payload.number_of_players) ||
      payload.number_of_players < 2 ||
      payload.number_of_players > 50)
  ) {
    throw new Error(
      "Number of players must be a whole number between 2 and 50.",
    );
  }

  const { error } = await supabase
    .from("leagues")
    .update({ ...payload, name: trimmedName })
    .eq("id", leagueId);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Writes the trade, cost, and matchup columns for one league-season.
 *
 * @param row - The settings to persist.
 * @throws When the write is rejected.
 */
export async function saveLeagueRulesSettings(
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("league_settings")
    .upsert(row, { onConflict: "league_id, season_id" });

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Reports whether the optional `number_of_players` column exists.
 *
 * @param leagueId - A league id to probe with.
 * @returns True when the column is present.
 */
export async function supportsNumberOfPlayersColumn(
  leagueId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("leagues")
    .select("number_of_players")
    .eq("id", leagueId)
    .limit(1);

  return !error && (Array.isArray(data) || Boolean(data));
}
