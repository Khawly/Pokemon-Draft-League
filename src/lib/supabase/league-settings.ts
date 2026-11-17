/*
 * League settings rows for the draft and league settings pages.
 *
 * Both pages read and write the same `league_settings` table, one row per
 * league-season. Keeping the column names here stops each page from spelling out
 * the same select and upsert payload.
 */
import { supabase } from "@/lib/supabase/client";

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
  const { error } = await supabase
    .from("league_settings")
    .upsert(row, { onConflict: "league_id, season_id" });

  if (error) {
    throw new Error(error.message);
  }
}
