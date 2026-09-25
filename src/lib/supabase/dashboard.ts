/*
 * Home page data layer for the Pokemon Draft League.
 *
 * Loads everything the dashboard shell renders for the league's latest season:
 * the season standings (through the season_standings RPC), the open schedule,
 * the free agent pool size, the signed-in member's own team and roster, their
 * open trade proposals, and their most recent notifications. Read-only — the
 * dashboard links out to the pages that own each write.
 */
import { supabase } from "@/lib/supabase/client";
import { loadLatestSeason } from "@/lib/supabase/seasons";
import { getPokemonEntryBySlug } from "@/lib/pokeapi";

/** Page size used when walking the draft pool's in-pool rows past the cap. */
const POOL_PAGE_SIZE = 1000;

/** How many open matches the dashboard's schedule list shows. */
const UPCOMING_MATCH_LIMIT = 3;

/** How many recent notifications the dashboard's notification list shows. */
const NOTIFICATION_LIMIT = 5;

/** Match statuses that count as still open (not yet decided). */
const OPEN_MATCH_STATUSES = ["scheduled", "in_progress"] as const;

/** Lifecycle status of the season the dashboard summarizes. */
export type DashboardSeasonStatus =
  | "draft_pending"
  | "draft_active"
  | "draft_complete"
  | "archived";

/** The league's latest season. */
export type DashboardSeason = {
  id: string;
  season_number: number;
  status: DashboardSeasonStatus;
  name: string | null;
};

/** A team slot in the season with its owner. */
export type DashboardTeam = {
  id: string;
  team_name: string;
  owner_user_id: string;
};

/** A season match with both team names resolved. */
export type DashboardMatch = {
  id: string;
  week_number: number;
  is_playoff: boolean;
  scheduled_at: string | null;
  status: "scheduled" | "in_progress" | "completed" | "forfeit" | "cancelled";
  player_1_team_id: string;
  player_2_team_id: string;
  player_1_name: string;
  player_2_name: string;
};

/** A ranked standings row, already ordered by the database. */
export type DashboardStanding = {
  team_id: string;
  team_name: string;
  wins: number;
  losses: number;
  ko_diff: number;
};

/** One rostered Pokemon enriched with catalog display data. */
export type DashboardRosterPokemon = {
  id: string;
  name: string;
  spriteId: number;
  /** Typing as PokeAPI type names (one or two entries). */
  types: string[];
  tier_value: number;
  bst: number | null;
};

/** One of the signed-in member's notifications. */
export type DashboardNotification = {
  id: string;
  message: string;
  is_read: boolean;
  created_at: string;
};

/** Everything the dashboard shell renders for the selected league. */
export type DashboardGoods = {
  /** Latest season, or null when the league has not created one yet. */
  season: DashboardSeason | null;
  /** Teams in the season. */
  teamsCount: number;
  /** Pokemon currently rostered across every team in the season. */
  rosteredPokemonCount: number;
  /** Pool Pokemon not yet claimed by any roster (free agents). */
  freeAgentCount: number;
  /** First regular-season week with an undecided match, else null. */
  currentWeek: number | null;
  /** Configured regular-season week count. */
  totalWeeks: number;
  /** True when the season has any playoff matches. */
  hasPlayoffs: boolean;
  /** League match format, used to describe the next match. */
  matchFormat: "single" | "best_of_3" | null;
  /** Open trade proposals the member sent or received. */
  pendingTradesCount: number;
  /** Full standings table, ranked. */
  standings: DashboardStanding[];
  /** Open matches, the member's own first, capped at three. */
  upcomingMatches: DashboardMatch[];
  /** The member's own next open match, when they have one. */
  nextMatch: DashboardMatch | null;
  /** The member's team in this season, when they own one. */
  myTeam: { id: string; team_name: string } | null;
  /** The member's roster, richest Pokemon first. */
  myRoster: DashboardRosterPokemon[];
  /** The member's most recent notifications, newest first. */
  notifications: DashboardNotification[];
};

/** The payload returned when a league has no season to summarize yet. */
function emptyGoods(): DashboardGoods {
  return {
    season: null,
    teamsCount: 0,
    rosteredPokemonCount: 0,
    freeAgentCount: 0,
    currentWeek: null,
    totalWeeks: 0,
    hasPlayoffs: false,
    matchFormat: null,
    pendingTradesCount: 0,
    standings: [],
    upcomingMatches: [],
    nextMatch: null,
    myTeam: null,
    myRoster: [],
    notifications: [],
  };
}

/** The sort key for a match's scheduled time, treating an unset time as last. */
function scheduledTime(match: DashboardMatch): number {
  return match.scheduled_at
    ? new Date(match.scheduled_at).getTime()
    : Number.MAX_SAFE_INTEGER;
}

/**
 * Human label for a match's status badge.
 *
 * @param status - The stored match status.
 * @returns The label to show.
 */
export function matchStatusLabel(status: DashboardMatch["status"]): string {
  switch (status) {
    case "in_progress":
      return "Live";
    case "scheduled":
      return "Scheduled";
    case "completed":
      return "Final";
    case "forfeit":
      return "Forfeit";
    default:
      return "Cancelled";
  }
}

/**
 * Loads the dashboard payload for a league's latest season.
 *
 * Resolves the season first, then fans out the season-scoped reads: settings,
 * teams, standings, matches, rosters, pool, trades, and notifications. A league
 * without a season returns the empty payload rather than throwing, so a freshly
 * created league still renders its shell.
 *
 * @param leagueId - The league to summarize.
 * @param userId - The signed-in member, used to scope trades, notifications,
 * and the "my team" panels.
 * @returns The dashboard payload.
 */
export async function loadDashboardData(
  leagueId: string,
  userId: string,
): Promise<DashboardGoods> {
  const { data: seasonRow, error: seasonError } = await loadLatestSeason<DashboardSeason>(
    leagueId,
    "id, season_number, status, name",
  );

  if (seasonError) {
    throw new Error("This league's season could not be loaded.");
  }

  const season = (seasonRow as DashboardSeason | null) ?? null;

  if (!season) {
    return emptyGoods();
  }

  const [settingsResult, teamResult, standingsResult, matchResult] =
    await Promise.all([
      supabase
        .from("league_settings")
        .select("regular_season_weeks, match_format")
        .eq("season_id", season.id)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("teams")
        .select("id, team_name, owner_user_id")
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("draft_position", { ascending: true, nullsFirst: false }),
      supabase.rpc("season_standings", { p_league_id: leagueId }),
      supabase
        .from("matches")
        .select(
          "id, week_number, is_playoff, scheduled_at, status, player_1_team_id, player_2_team_id, player_1: player_1_team_id (team_name), player_2: player_2_team_id (team_name)",
        )
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("week_number", { ascending: true }),
    ]);

  const settings = settingsResult.data as {
    regular_season_weeks?: number | null;
    match_format?: "single" | "best_of_3" | null;
  } | null;
  const teams = (teamResult.data ?? []) as DashboardTeam[];
  const teamIds = teams.map((team) => team.id);
  const myTeam = teams.find((team) => team.owner_user_id === userId) ?? null;

  const matches = ((matchResult.data ?? []) as {
    id: string;
    week_number: number;
    is_playoff: boolean;
    scheduled_at: string | null;
    status: DashboardMatch["status"];
    player_1_team_id: string;
    player_2_team_id: string;
    player_1?: { team_name?: string | null } | null;
    player_2?: { team_name?: string | null } | null;
  }[]).map<DashboardMatch>((row) => ({
    id: row.id,
    week_number: row.week_number,
    is_playoff: row.is_playoff,
    scheduled_at: row.scheduled_at,
    status: row.status,
    player_1_team_id: row.player_1_team_id,
    player_2_team_id: row.player_2_team_id,
    player_1_name: row.player_1?.team_name ?? "Team 1",
    player_2_name: row.player_2?.team_name ?? "Team 2",
  }));

  const standings = ((standingsResult.data ?? []) as {
    team_id: string;
    team_name: string;
    wins: number | string | null;
    losses: number | string | null;
    ko_diff: number | string | null;
  }[]).map<DashboardStanding>((row) => ({
    team_id: row.team_id,
    team_name: row.team_name,
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    ko_diff: Number(row.ko_diff ?? 0),
  }));

  const openMatches = matches.filter((match) =>
    (OPEN_MATCH_STATUSES as readonly string[]).includes(match.status),
  );

  // The current week is the earliest regular-season week that still has an
  // undecided match; once every regular match is decided the season is either
  // in the postseason or finished.
  const regularWeeks = [
    ...new Set(
      matches.filter((match) => !match.is_playoff).map((match) => match.week_number),
    ),
  ].sort((a, b) => a - b);
  const currentWeek =
    regularWeeks.find((week) =>
      openMatches.some(
        (match) => !match.is_playoff && match.week_number === week,
      ),
    ) ?? null;

  // Surface the member's own fixtures first, then the soonest by kickoff.
  const sortedOpen = [...openMatches].sort((a, b) => {
    const aMine =
      myTeam != null &&
      (a.player_1_team_id === myTeam.id || a.player_2_team_id === myTeam.id);
    const bMine =
      myTeam != null &&
      (b.player_1_team_id === myTeam.id || b.player_2_team_id === myTeam.id);
    if (aMine !== bMine) {
      return aMine ? -1 : 1;
    }
    return scheduledTime(a) - scheduledTime(b);
  });

  const [rosterResult, poolResult, tradeResult, notificationResult] =
    await Promise.all([
      teamIds.length > 0
        ? supabase
            .from("team_roster")
            .select("id, team_id, pokemon_id, tier_value")
            .in("team_id", teamIds)
            .order("acquired_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      loadFreeAgentPokemon(leagueId, season.id),
      supabase
        .from("trades")
        .select("id")
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .in("status", ["awaiting_response", "pending_approval"])
        .or(`proposer_user_id.eq.${userId},recipient_user_id.eq.${userId}`),
      supabase
        .from("notifications")
        .select("id, message, is_read, created_at")
        .eq("league_id", leagueId)
        .eq("recipient_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(NOTIFICATION_LIMIT),
    ]);

  const rosterRows = (rosterResult.data ?? []) as {
    id: string;
    team_id: string;
    pokemon_id: string;
    tier_value: number;
  }[];

  // A Pokemon on any roster is no longer a free agent even though the draft
  // engine leaves is_in_pool TRUE for drafted species.
  const claimedPokemon = new Set(rosterRows.map((row) => row.pokemon_id));
  const myRoster = rosterRows
    .filter((row) => myTeam != null && row.team_id === myTeam.id)
    .map<DashboardRosterPokemon>((row) => {
      const catalog = getPokemonEntryBySlug(row.pokemon_id);
      return {
        id: row.id,
        name: catalog?.name ?? row.pokemon_id,
        spriteId: catalog?.spriteId ?? 0,
        types: catalog?.types ?? [],
        tier_value: row.tier_value,
        bst: catalog?.bst ?? null,
      };
    })
    .sort((a, b) => b.tier_value - a.tier_value);

  const notifications = ((notificationResult.data ?? []) as {
    id: string;
    message: string;
    is_read: boolean;
    created_at: string;
  }[]).map<DashboardNotification>((row) => ({
    id: row.id,
    message: row.message,
    is_read: row.is_read,
    created_at: row.created_at,
  }));

  return {
    season,
    teamsCount: teams.length,
    rosteredPokemonCount: rosterRows.length,
    freeAgentCount: poolResult.filter((id) => !claimedPokemon.has(id)).length,
    currentWeek,
    totalWeeks: settings?.regular_season_weeks ?? 0,
    hasPlayoffs: matches.some((match) => match.is_playoff),
    matchFormat: settings?.match_format ?? null,
    pendingTradesCount: (tradeResult.data ?? []).length,
    standings,
    upcomingMatches: sortedOpen.slice(0, UPCOMING_MATCH_LIMIT),
    nextMatch:
      sortedOpen.find(
        (match) =>
          myTeam != null &&
          (match.player_1_team_id === myTeam.id ||
            match.player_2_team_id === myTeam.id),
      ) ?? null,
    myTeam: myTeam
      ? { id: myTeam.id, team_name: myTeam.team_name }
      : null,
    myRoster,
    notifications,
  };
}

/**
 * Collects the ids of every pool Pokemon still flagged in-pool for the season.
 *
 * Scoped to the active pool when the owner has set one, otherwise every pool in
 * the season, and paged past the response cap like the pool page.
 *
 * @param leagueId - The league owning the pools.
 * @param seasonId - The season the pools belong to.
 * @returns The in-pool Pokemon ids.
 */
async function loadFreeAgentPokemon(
  leagueId: string,
  seasonId: string,
): Promise<string[]> {
  const { data: poolRows, error: poolError } = await supabase
    .from("draft_pools")
    .select("id, is_active")
    .eq("league_id", leagueId)
    .eq("season_id", seasonId);

  if (poolError || !poolRows || poolRows.length === 0) {
    return [];
  }

  const pools = poolRows as { id: string; is_active: boolean }[];
  const active = pools.filter((pool) => pool.is_active);
  const poolIds = (active.length > 0 ? active : pools).map((pool) => pool.id);

  const ids: string[] = [];

  for (let from = 0; ; from += POOL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("draft_pool_pokemon")
      .select("pokemon_id")
      .in("draft_pool_id", poolIds)
      .eq("is_in_pool", true)
      .order("id", { ascending: true })
      .range(from, from + POOL_PAGE_SIZE - 1);

    if (error) {
      return ids;
    }

    const page = (data ?? []) as { pokemon_id: string }[];
    ids.push(...page.map((row) => row.pokemon_id));

    if (page.length < POOL_PAGE_SIZE) {
      break;
    }
  }

  return ids;
}

/**
 * Formats a scheduled match time as a short local date/time, or an em dash when
 * the match has no time set.
 *
 * @param value - An ISO timestamp, or null.
 * @returns The formatted date/time.
 */
export function formatMatchTime(value: string | null): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Formats a notification's creation time as a short relative age such as
 * "just now", "3h ago", or "Sep 24".
 *
 * @param value - An ISO timestamp.
 * @returns The relative age label.
 */
export function formatNotificationAge(value: string): string {
  const timestamp = new Date(value).getTime();

  if (Number.isNaN(timestamp)) {
    return "";
  }

  const minutes = Math.round((Date.now() - timestamp) / 60000);

  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);

  if (days < 7) {
    return `${days}d ago`;
  }

  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
