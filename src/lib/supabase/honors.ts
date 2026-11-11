/*
 * Loads the league's previous-season playoff finishers for the E4 badge.
 *
 * The champion already has a crown from `crowned_member_names`, but the rest of
 * the bracket has no stored placement. This finds the most recent season that
 * produced a champion, reconstructs the finishing order from its playoff
 * results, and returns places two through five so their names can carry an E4
 * badge anywhere the app renders them.
 *
 * The query count is kept small and staged so this decoration does not compete
 * with the page's own data on the free-tier connection pool.
 */
import { supabase } from "@/lib/supabase/client";
import {
  computePlayoffPlacements,
  type PlayoffPlacementMatch,
} from "@/lib/playoff-placements";

/** One member who finished second through fifth in the honoured season. */
export interface EliteFinisher {
  /** The member's id, for exact badge matching. */
  userId: string;
  /** Their live display name, for surfaces that only render a name. */
  displayName: string | null;
}

/** How many finishers after the champion wear the E4 badge. */
const ELITE_FINISHER_COUNT = 4;

/** A team row read alongside its owner's display name. */
type EliteTeamRow = {
  id: string;
  owner_user_id: string | null;
  profiles?: { display_name?: string | null } | { display_name?: string | null }[] | null;
};

/**
 * Reads a possibly-embedded profile object as a single row.
 *
 * PostgREST returns a to-one embed as an object, but the generated types are
 * loose enough that callers also see an array. Normalising here keeps the
 * lookup simple.
 *
 * @param profiles - The embedded profile value.
 * @returns The profile object, or null when none was returned.
 */
function profileRow(
  profiles: EliteTeamRow["profiles"],
): { display_name?: string | null } | null {
  if (!profiles) {
    return null;
  }

  return Array.isArray(profiles) ? (profiles[0] ?? null) : profiles;
}

/**
 * Loads the members who finished second through fifth in the most recent
 * season that produced a champion.
 *
 * The season is found by walking the league's seasons newest first and asking
 * `playoff_champion` until one answers. That is the same season whose winner
 * wears the crown, so the crown and the E4 badges always describe the same
 * tournament.
 *
 * @param leagueId - The league whose previous season to read.
 * @returns Up to four finishers, in placement order. Empty when no completed
 *   playoff season exists or the data cannot be read.
 */
export async function loadEliteFinishers(
  leagueId: string,
): Promise<EliteFinisher[]> {
  const { data: seasonRows, error: seasonsError } = await supabase
    .from("seasons")
    .select("id")
    .eq("league_id", leagueId)
    .order("season_number", { ascending: false });

  if (seasonsError || !seasonRows?.length) {
    return [];
  }

  let seasonId: string | null = null;
  let championTeamId: string | null = null;

  for (const season of seasonRows as { id: string }[]) {
    const { data: champion, error: championError } = await supabase.rpc(
      "playoff_champion",
      { p_league_id: leagueId, p_season_id: season.id },
    );

    if (championError) {
      continue;
    }

    if (typeof champion === "string" && champion.length > 0) {
      seasonId = season.id;
      championTeamId = champion;
      break;
    }
  }

  if (!seasonId || !championTeamId) {
    return [];
  }

  const [settingsResult, matchResult] = await Promise.all([
    supabase
      .from("league_settings")
      .select("playoff_format")
      .eq("season_id", seasonId)
      .maybeSingle(),
    supabase
      .from("matches")
      .select(
        "week_number, bracket_phase, bracket_slot, status, winner_team_id, player_1_team_id, player_2_team_id",
      )
      .eq("league_id", leagueId)
      .eq("season_id", seasonId)
      .eq("is_playoff", true),
  ]);

  if (settingsResult.error || matchResult.error) {
    return [];
  }

  const [teamResult, standingsResult] = await Promise.all([
    supabase
      .from("teams")
      .select("id, owner_user_id, profiles: owner_user_id (display_name)")
      .eq("league_id", leagueId)
      .eq("season_id", seasonId),
    supabase.rpc("season_standings_for", {
      p_league_id: leagueId,
      p_season_id: seasonId,
    }),
  ]);

  if (teamResult.error || standingsResult.error) {
    return [];
  }

  const format =
    (settingsResult.data as { playoff_format?: string | null } | null)
      ?.playoff_format === "double_elimination"
      ? ("double_elimination" as const)
      : ("single_elimination" as const);

  const standings = (standingsResult.data ?? []) as { team_id: string }[];

  const placements = computePlayoffPlacements({
    format,
    matches: (matchResult.data ?? []) as PlayoffPlacementMatch[],
    championTeamId,
    standingsOrder: standings.map((row) => row.team_id),
  });

  const teamsById = new Map(
    ((teamResult.data ?? []) as EliteTeamRow[]).map((team) => [team.id, team]),
  );

  return placements
    .slice(1, 1 + ELITE_FINISHER_COUNT)
    .map((teamId) => teamsById.get(teamId))
    .filter((team): team is EliteTeamRow => Boolean(team?.owner_user_id))
    .map((team) => ({
      userId: team.owner_user_id as string,
      displayName: profileRow(team.profiles)?.display_name ?? null,
    }));
}
