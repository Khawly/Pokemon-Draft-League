/*
 * Schedule page data layer for the Pokemon Draft League.
 *
 * Loads the league, latest season, season settings (including schedule
 * configuration), every team with its owner's display info, the season's
 * matches with per-game results, and the computed season standings. Also
 * exposes the RPC-backed mutations the page uses: generating the schedule and
 * the playoff bracket (owner only), scheduling/rescheduling a match by its
 * participants, submitting and (staff-only) editing game results, and
 * forfeiting a match.
 */
import { supabase } from "@/lib/supabase/client";

/** Lifecycle status of a season (subset used by the schedule page). */
export type ScheduleSeasonStatus =
  | "draft_pending"
  | "draft_active"
  | "draft_complete"
  | "archived";

/** Season row for the schedule page. */
export type ScheduleSeason = {
  id: string;
  season_number: number;
  status: ScheduleSeasonStatus;
};

/** Per-season schedule/cost configuration read from league_settings. */
export type ScheduleSettings = {
  regular_season_weeks: number;
  match_format: "single" | "best_of_3";
  playoff_team_count: number;
  playoff_match_format: "single" | "best_of_3";
  playoff_format: "single_elimination" | "double_elimination";
  enable_pokemon_costs: boolean;
  total_token_salary: number | null;
  allow_per_team_salary: boolean;
  total_rounds: number;
};

/** A team slot in the season with its owner's resolved display info. */
export type ScheduleTeam = {
  id: string;
  owner_user_id: string;
  team_name: string;
  owner_name: string | null;
  owner_avatar_url: string | null;
};

/** One reported game of a match (result). */
export type ScheduleMatchResult = {
  id: string;
  winner_team_id: string;
  replay_url: string | null;
  game_number: number;
  pokemon_left_alive: number | null;
  submitted_at: string;
};

/** A head-to-head match in the season with resolved team/player display info. */
export type ScheduleMatch = {
  id: string;
  week_number: number;
  is_playoff: boolean;
  bracket_phase: "upper" | "lower" | "gf" | null;
  scheduled_at: string | null;
  status: "scheduled" | "in_progress" | "completed" | "forfeit" | "cancelled";
  winner_team_id: string | null;
  notes: string | null;
  player_1_team_id: string;
  player_2_team_id: string;
  player_1_name: string;
  player_2_name: string;
  player_1_avatar_url: string | null;
  player_2_avatar_url: string | null;
  player_1_user_id: string;
  player_2_user_id: string;
  results: ScheduleMatchResult[];
};

/** A row from the season_standings RPC (ranked by the database). */
export type StandingsRow = {
  team_id: string;
  team_name: string;
  wins: number;
  losses: number;
  ko_diff: number;
};

/** Complete schedule page payload for a league. */
export type SchedulePageGoods = {
  league: {
    id: string;
    name: string;
    owner_id: string;
  };
  season: ScheduleSeason | null;
  settings: ScheduleSettings | null;
  teams: ScheduleTeam[];
  /** Matches for the current season, ordered by week then created time. */
  matches: ScheduleMatch[];
  standings: StandingsRow[];
  currentUserId: string;
  userRole: "owner" | "admin" | "member" | null;
  isOwner: boolean;
  isStaff: boolean;
  myTeamId: string | null;
};

type ScheduleMatchRow = {
  id: string;
  week_number: number;
  is_playoff: boolean;
  bracket_phase: ScheduleMatch["bracket_phase"];
  scheduled_at: string | null;
  status: ScheduleMatch["status"];
  winner_team_id: string | null;
  notes: string | null;
  player_1_team_id: string;
  player_2_team_id: string;
  player_1?: {
    team_name?: string;
    owner_user_id?: string;
    owner?: { display_name?: string | null; avatar_url?: string | null } | null;
  } | null;
  player_2?: {
    team_name?: string;
    owner_user_id?: string;
    owner?: { display_name?: string | null; avatar_url?: string | null } | null;
  } | null;
};

/**
 * Loads the complete schedule page state for a league for the signed-in user.
 *
 * Guards on authentication, loads the league and latest season, and when a
 * season exists resolves settings, teams (with owner display info), the
 * season's matches with per-game results, and the standings.
 *
 * @param leagueId - The id of the league whose schedule to load.
 * @returns A Promise resolving to the assembled {@link SchedulePageGoods}.
 * @throws If the user is not signed in, the league is missing, or a core query
 *   fails.
 */
export async function loadSchedulePageData(
  leagueId: string,
): Promise<SchedulePageGoods> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to view the schedule.");
  }

  const { data: league, error: leagueError } = await supabase
    .from("leagues")
    .select("id, name, owner_id")
    .eq("id", leagueId)
    .maybeSingle();

  if (leagueError || !league) {
    throw new Error("This league could not be loaded.");
  }

  const { data: seasonRow, error: seasonError } = await supabase
    .from("seasons")
    .select("id, season_number, status")
    .eq("league_id", leagueId)
    .order("season_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (seasonError) {
    throw new Error("This league's season could not be loaded.");
  }

  const season = (seasonRow as ScheduleSeason | null) ?? null;

  const base: SchedulePageGoods = {
    league: {
      id: league.id,
      name: league.name,
      owner_id: league.owner_id,
    },
    season,
    settings: null,
    teams: [],
    matches: [],
    standings: [],
    currentUserId: user.id,
    userRole: null,
    isOwner: false,
    isStaff: false,
    myTeamId: null,
  };

  if (!season) {
    return base;
  }

  const [settingsResult, teamResult, memberResult, standingsResult] =
    await Promise.all([
      supabase
        .from("league_settings")
        .select(
          "regular_season_weeks, match_format, playoff_team_count, playoff_match_format, playoff_format, enable_pokemon_costs, total_token_salary, allow_per_team_salary, total_rounds",
        )
        .eq("season_id", season.id)
        .maybeSingle(),
      supabase
        .from("teams")
        .select(
          "id, owner_user_id, team_name, profiles: owner_user_id (display_name, avatar_url)",
        )
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("draft_position", { ascending: true, nullsFirst: false }),
      supabase
        .from("league_members")
        .select("user_id, role")
        .eq("league_id", leagueId)
        .eq("is_active", true),
      supabase.rpc("season_standings", { p_league_id: leagueId }),
    ]);

  if (
    settingsResult.error ||
    teamResult.error ||
    memberResult.error ||
    standingsResult.error
  ) {
    throw new Error("Schedule data could not be loaded.");
  }

  const settingsRow = settingsResult.data as {
    regular_season_weeks: number;
    match_format: "single" | "best_of_3";
    playoff_team_count: number;
    playoff_match_format: "single" | "best_of_3";
    playoff_format: "single_elimination" | "double_elimination";
    enable_pokemon_costs: boolean;
    total_token_salary: number | null;
    allow_per_team_salary: boolean;
    total_rounds: number;
  } | null;

  const settings: ScheduleSettings | null = settingsRow
    ? {
        regular_season_weeks: settingsRow.regular_season_weeks,
        match_format: settingsRow.match_format,
        playoff_team_count: settingsRow.playoff_team_count,
        playoff_match_format: settingsRow.playoff_match_format,
        playoff_format: settingsRow.playoff_format,
        enable_pokemon_costs: settingsRow.enable_pokemon_costs,
        total_token_salary: settingsRow.total_token_salary,
        allow_per_team_salary: settingsRow.allow_per_team_salary,
        total_rounds: settingsRow.total_rounds,
      }
    : null;

  const teams = ((teamResult.data ?? []) as {
    id: string;
    owner_user_id: string;
    team_name: string;
    profiles?: { display_name?: string | null; avatar_url?: string | null } | null;
  }[]).map(
    (row): ScheduleTeam => ({
      id: row.id,
      owner_user_id: row.owner_user_id,
      team_name: row.team_name,
      owner_name: row.profiles?.display_name ?? null,
      owner_avatar_url: row.profiles?.avatar_url ?? null,
    }),
  );

  const members = ((memberResult.data ?? []) as {
    user_id: string;
    role: "owner" | "admin" | "member";
  }[]) ?? [];

  const myMembership = members.find((member) => member.user_id === user.id);
  const userRole = myMembership?.role ?? null;
  const myTeam = teams.find((team) => team.owner_user_id === user.id);

  const standings = ((standingsResult.data ?? []) as {
    team_id: string;
    team_name: string;
    wins: number;
    losses: number;
    ko_diff: number;
  }[]).map((row) => ({
    team_id: row.team_id,
    team_name: row.team_name,
    wins: Number(row.wins),
    losses: Number(row.losses),
    ko_diff: Number(row.ko_diff),
  }));

  const { data: matchRows, error: matchError } = await supabase
    .from("matches")
    .select(
      "id, week_number, is_playoff, bracket_phase, scheduled_at, status, winner_team_id, notes, player_1_team_id, player_2_team_id, player_1: player_1_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url)), player_2: player_2_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url))",
    )
    .eq("league_id", leagueId)
    .eq("season_id", season.id)
    .order("week_number", { ascending: true })
    .order("created_at", { ascending: true });

  if (matchError) {
    throw new Error("Matches could not be loaded.");
  }

  const matchIds = (matchRows ?? []).map((row) => row.id);

  const resultsByMatch = new Map<string, ScheduleMatchResult[]>();
  if (matchIds.length > 0) {
    const { data: resultRows, error: resultsError } = await supabase
      .from("match_results")
      .select(
        "id, match_id, winner_team_id, replay_url, game_number, pokemon_left_alive, submitted_at",
      )
      .in("match_id", matchIds);

    if (resultsError) {
      throw new Error("Match results could not be loaded.");
    }

    for (const row of (resultRows ?? []) as (Omit<ScheduleMatchResult, "match_id"> & {
      match_id: string;
    })[]) {
      const current = resultsByMatch.get(row.match_id) ?? [];
      current.push({
        id: row.id,
        winner_team_id: row.winner_team_id,
        replay_url: row.replay_url,
        game_number: row.game_number,
        pokemon_left_alive: row.pokemon_left_alive,
        submitted_at: row.submitted_at,
      });
      resultsByMatch.set(row.match_id, current);
    }
  }

  const matches = ((matchRows ?? []) as unknown as ScheduleMatchRow[]).map(
    (row): ScheduleMatch => ({
      id: row.id,
      week_number: row.week_number,
      is_playoff: row.is_playoff,
      bracket_phase: row.bracket_phase,
      scheduled_at: row.scheduled_at,
      status: row.status,
      winner_team_id: row.winner_team_id,
      notes: row.notes,
      player_1_team_id: row.player_1_team_id,
      player_2_team_id: row.player_2_team_id,
      player_1_name: row.player_1?.team_name ?? "Team 1",
      player_2_name: row.player_2?.team_name ?? "Team 2",
      player_1_avatar_url: row.player_1?.owner?.avatar_url ?? null,
      player_2_avatar_url: row.player_2?.owner?.avatar_url ?? null,
      player_1_user_id: row.player_1?.owner_user_id ?? "",
      player_2_user_id: row.player_2?.owner_user_id ?? "",
      results: resultsByMatch.get(row.id) ?? [],
    }),
  );

  return {
    ...base,
    settings,
    teams,
    matches,
    standings,
    userRole,
    isOwner: userRole === "owner",
    isStaff: userRole === "owner" || userRole === "admin",
    myTeamId: myTeam?.id ?? null,
  };
}

/**
 * Saves the season's schedule configuration and regenerates the regular season
 * matchups (owner only). Replaces any existing schedule for the season.
 *
 * @param leagueId - The league whose schedule to generate.
 * @param config - The schedule configuration to persist and build from.
 * @returns The number of regular season matches created.
 */
export async function generateSchedule(
  leagueId: string,
  config: Pick<
    ScheduleSettings,
    | "regular_season_weeks"
    | "match_format"
    | "playoff_team_count"
    | "playoff_match_format"
    | "playoff_format"
  >,
): Promise<number> {
  const { data, error } = await supabase.rpc("generate_schedule", {
    p_league_id: leagueId,
    p_weeks: config.regular_season_weeks,
    p_match_format: config.match_format,
    p_playoff_team_count: config.playoff_team_count,
    p_playoff_match_format: config.playoff_match_format,
    p_playoff_format: config.playoff_format,
  });

  if (error) {
    throw new Error(error.message || "The schedule could not be generated.");
  }

  return Number(data ?? 0);
}

/**
 * Advances the playoff bracket by one round (owner only). Each call creates the
 * next round whose participants are known, then stops until results come in.
 *
 * @param leagueId - The league whose playoff bracket to advance.
 * @returns The number of playoff matches created.
 */
export async function generatePlayoffRound(
  leagueId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("generate_playoff_round", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message || "The playoff bracket could not be advanced.");
  }

  return Number(data ?? 0);
}

/**
 * Schedules or reschedules a match's date/time and notes (participants only).
 *
 * @param matchId - The match to update.
 * @param scheduledAt - The new ISO timestamp, or null to clear the time.
 * @param notes - Optional scheduling notes for the opponent.
 */
export async function updateMatchSchedule(
  matchId: string,
  scheduledAt: string | null,
  notes: string,
): Promise<void> {
  const { error } = await supabase.rpc("update_match_schedule", {
    p_match_id: matchId,
    p_scheduled_at: scheduledAt,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message || "The match could not be scheduled.");
  }
}

/**
 * Submits one game result for a match the user participates in. Enforces one
 * result per game, rejects duplicate replay links (`Link already submitted`),
 * and closes the match when a team reaches the required win count.
 *
 * @param matchId - The match to report on.
 * @param gameNumber - The game number (1 for single, 1..3 for best of 3).
 * @param winnerTeamId - The winning team.
 * @param replayUrl - Optional replay link for the game.
 * @param pokemonLeftAlive - Optional surviving Pokemon count for the winner.
 * @returns The match's status after the submission.
 */
export async function submitGameResult(
  matchId: string,
  gameNumber: number,
  winnerTeamId: string,
  replayUrl: string,
  pokemonLeftAlive: number | null,
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_game_result", {
    p_match_id: matchId,
    p_game_number: gameNumber,
    p_winner_team_id: winnerTeamId,
    p_replay_url: replayUrl,
    p_pokemon_left_alive: pokemonLeftAlive,
  });

  if (error) {
    throw new Error(error.message || "The result could not be submitted.");
  }

  return (data as string) ?? "in_progress";
}

/**
 * Corrects a reported game result (owners and admins only).
 *
 * @param resultId - The game result to edit.
 * @param winnerTeamId - The corrected winning team.
 * @param replayUrl - The corrected replay link, if any.
 * @param pokemonLeftAlive - The corrected surviving Pokemon count, if any.
 * @returns The match's status after the edit.
 */
export async function updateGameResult(
  resultId: string,
  winnerTeamId: string,
  replayUrl: string,
  pokemonLeftAlive: number | null,
): Promise<string> {
  const { data, error } = await supabase.rpc("update_game_result", {
    p_result_id: resultId,
    p_winner_team_id: winnerTeamId,
    p_replay_url: replayUrl,
    p_pokemon_left_alive: pokemonLeftAlive,
  });

  if (error) {
    throw new Error(error.message || "The result could not be edited.");
  }

  return (data as string) ?? "in_progress";
}

/**
 * Forfeits a match the user participates in to their opponent.
 *
 * @param matchId - The match to forfeit.
 */
export async function forfeitMatch(matchId: string): Promise<void> {
  const { error } = await supabase.rpc("forfeit_match", {
    p_match_id: matchId,
  });

  if (error) {
    throw new Error(error.message || "The match could not be forfeited.");
  }
}

/**
 * Returns the number of games a match needs to be won before it is completed.
 *
 * @param format - The match format (`single` or `best_of_3`).
 * @returns 1 for single games, 2 for best of 3.
 */
export function winsRequired(format: "single" | "best_of_3"): number {
  return format === "single" ? 1 : 2;
}

/**
 * Renders a team's game record such as `2-1` given its match results.
 *
 * @param match - The match whose results to tally.
 * @param teamId - The team to produce a record for.
 * @returns A `wins-losses` string, or null when the results imply no games.
 */
export function gameRecord(
  match: ScheduleMatch,
  teamId: string,
): string | null {
  const wins = match.results.filter(
    (result) => result.winner_team_id === teamId,
  ).length;
  const losses = match.results.length - wins;
  if (match.results.length === 0) {
    return null;
  }
  return `${wins}-${losses}`;
}

/**
 * The next power of two at or above a positive count (used for byes).
 *
 * @param count - The count to round up to a power of two.
 * @returns The next power of two.
 */
export function nextPowerOfTwo(count: number): number {
  let result = 1;
  while (result < count) {
    result *= 2;
  }
  return result;
}