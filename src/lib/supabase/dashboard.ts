/*
 * Home page data layer for the Pokemon Draft League.
 *
 * Loads everything the dashboard shell renders for the league's latest season:
 * the season standings (through the season_standings RPC), the open schedule,
 * the free agent pool size, the signed-in member's own team and roster, their
 * open trade proposals, their most recent notifications, and the unread
 * match-time alerts their opponent has raised for this week's matchup. Read-only
 * - the dashboard links out to the pages that own each write.
 */
import { supabase } from "@/lib/supabase/client";
import { loadLatestSeason } from "@/lib/supabase/seasons";
import { loadWeekProgressState } from "@/lib/supabase/week-deadline";
import { getPokemonEntryBySlug } from "@/lib/pokeapi";

/** Page size used when walking the draft pool's in-pool rows past the cap. */
const POOL_PAGE_SIZE = 1000;

/** How many open matches the dashboard's schedule list shows. */
const UPCOMING_MATCH_LIMIT = 3;

/** How many recent notifications the dashboard's notification list shows. */
const NOTIFICATION_LIMIT = 5;

/**
 * The notification types that describe a match time being proposed, answered, or
 * withdrawn. A match-time alert is only raised for these; everything else in the
 * notification history is informational.
 */
const MATCH_TIME_EVENT_TYPES = [
  "match_proposed",
  "match_proposal_accepted",
  "match_proposal_declined",
  "match_proposal_withdrawn",
];


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
  /** The owner's live display name, which is what the UI labels them with. */
  owner_name: string | null;
  owner_avatar_url: string | null;
};

/** A season match with both team names resolved. */
export type DashboardMatch = {
  id: string;
  week_number: number;
  is_playoff: boolean;
  scheduled_at: string | null;
  status:
    | "unscheduled"
    | "scheduled"
    | "in_progress"
    | "completed"
    | "forfeit"
    | "cancelled";
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
  /**
   * The season's teams with their owners' live display names, so the UI can label
   * a player by the name they currently have rather than the team-name snapshot.
   */
  teams: DashboardTeam[];
  /** Pokemon currently rostered across every team in the season. */
  rosteredPokemonCount: number;
  /** Pool Pokemon not yet claimed by any roster (free agents). */
  freeAgentCount: number;
  /**
   * First regular-season week that still has an undecided match, else null.
   *
   * This is a convenience for the stat card, not the league's official week: the
   * authoritative pointer is `league_settings.current_week`, which only the
   * weekly-deadline system maintains. The schedule page reads that instead, so
   * the two can legitimately differ for a league with no deadline configured.
   */
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
  myTeam: DashboardTeam | null;
  /** The member's roster, richest Pokemon first. */
  myRoster: DashboardRosterPokemon[];
  /** The member's most recent notifications, newest first. */
  notifications: DashboardNotification[];
  /**
   * Unread match-time alerts raised by the member's opponent for their matchup in
   * the current week, backing the badge on the Schedule nav button. Ids are
   * carried alongside the count so opening the schedule can clear exactly these.
   */
  matchTimeAlertIds: string[];
  /** How many of those alerts there are. */
  matchTimeAlertCount: number;
  /**
   * The league this payload describes. Exposed so a real-time refresh can scope
   * its own reads without re-resolving the league from the URL.
   */
  leagueId: string;
};


/** The payload returned when a league has no season to summarize yet. */
function emptyGoods(): DashboardGoods {
  return {
    season: null,
    teamsCount: 0,
    teams: [],
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
    matchTimeAlertIds: [],
    matchTimeAlertCount: 0,
    leagueId: "",
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
    case "unscheduled":
      return "Unscheduled";
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
        .select(
          "id, team_name, owner_user_id, profiles: owner_user_id (display_name, avatar_url)",
        )
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("draft_position", { ascending: true, nullsFirst: false }),
      supabase.rpc("season_standings", { p_league_id: leagueId }),
      supabase
        .from("matches")
        .select(
          "id, week_number, is_playoff, scheduled_at, status, player_1_team_id, player_2_team_id, player_1: player_1_team_id (team_name, owner_user_id, owner: owner_user_id (display_name)), player_2: player_2_team_id (team_name, owner_user_id, owner: owner_user_id (display_name))",
        )
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("week_number", { ascending: true }),
    ]);

  const settings = settingsResult.data as {
    regular_season_weeks?: number | null;
    match_format?: "single" | "best_of_3" | null;
  } | null;

  const teams = ((teamResult.data ?? []) as {
    id: string;
    team_name: string;
    owner_user_id: string;
    profiles?: { display_name?: string | null; avatar_url?: string | null } | null;
  }[]).map<DashboardTeam>((row) => ({
    id: row.id,
    team_name: row.team_name,
    owner_user_id: row.owner_user_id,
    owner_name: row.profiles?.display_name ?? null,
    owner_avatar_url: row.profiles?.avatar_url ?? null,
  }));

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
    player_1?: {
      team_name?: string | null;
      owner_user_id?: string;
      owner?: { display_name?: string | null } | null;
    } | null;
    player_2?: {
      team_name?: string | null;
      owner_user_id?: string;
      owner?: { display_name?: string | null } | null;
    } | null;
  }[]).map<DashboardMatch>((row) => ({
    id: row.id,
    week_number: row.week_number,
    is_playoff: row.is_playoff,
    scheduled_at: row.scheduled_at,
    status: row.status,
    player_1_team_id: row.player_1_team_id,
    player_2_team_id: row.player_2_team_id,
    // The owner's live display name; `team_name` is only a draft-time snapshot.
    player_1_name: row.player_1?.owner?.display_name ?? row.player_1?.team_name ?? "Team 1",
    player_2_name: row.player_2?.owner?.display_name ?? row.player_2?.team_name ?? "Team 2",
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
  const derivedWeek =
    regularWeeks.find((week) =>
      openMatches.some(
        (match) => !match.is_playoff && match.week_number === week,
      ),
    ) ?? null;

  /*
   * The league's official week pointer, when the weekly deadline maintains it.
   * The weekly-deadline system owns that value, so trusting it keeps this page
   * and the schedule page from disagreeing about which week the league is in.
   * A league with no deadline configured has no pointer, so the derived week
   * stands in for it.
   */
  let currentWeek = derivedWeek;

  try {
    const progress = await loadWeekProgressState(leagueId);

    if (progress?.deadline_enabled && progress.current_week > 0) {
      currentWeek = progress.current_week;
    }
  } catch {
    // No settings row, no migration, or not a member: keep the derived week.
  }

  /*
   * Started before the payload's other reads so it overlaps with them rather than
   * extending the load. It resolves its own week and matchup so the same function
   * can serve a badge-only refresh later.
   */
  const alertsPromise = loadMatchTimeAlerts(leagueId, userId).catch(
    () => NO_ALERTS,
  );

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

  const alerts = await alertsPromise;

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
    teams,
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
    myTeam,
    myRoster,
    notifications,
    matchTimeAlertIds: alerts.ids,
    matchTimeAlertCount: alerts.count,
    leagueId,
  };
}

/** The unread match-time alerts backing the Schedule nav badge. */
export type MatchTimeAlerts = {
  /** Notification ids, for clearing exactly these when the schedule is opened. */
  ids: string[];
  /** How many there are. */
  count: number;
};

/**
 * Deletes every notification addressed to the member in one league.
 *
 * This is the panel's "clear all", so it removes the member's whole backlog for
 * the league rather than only the handful the panel lists, and it deletes rather
 * than marks read: the panel shows read rows too, so marking them read would
 * leave the list looking untouched.
 *
 * Scoped by league because that is the panel's scope, and because notifications
 * are addressed per league and season. A member who plays in two leagues clears
 * one and keeps the other.
 *
 * The match-time alerts behind the Schedule nav badge are notifications too, so
 * clearing removes them and the badge with it. The caller is responsible for
 * dropping the badge in the same state update, or the number will outlive the
 * rows it was counting.
 *
 * @param leagueId - The league to clear the member's notifications in.
 * @returns How many notifications were removed.
 * @throws If the delete fails. The delete is all-or-nothing from the member's
 *   point of view: a failure leaves the panel exactly as it was.
 */
export async function clearAllNotifications(leagueId: string): Promise<number> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to clear notifications.");
  }

  const { count, error } = await supabase
    .from("notifications")
    .delete({ count: "exact" })
    .eq("league_id", leagueId)
    .eq("recipient_user_id", user.id);

  if (error) {
    throw new Error(error.message || "Notifications could not be cleared.");
  }

  return count ?? 0;
}

/** An empty result, used whenever a league has nothing to report. */
const NO_ALERTS: MatchTimeAlerts = { ids: [], count: 0 };

/**
 * Loads the unread match-time alerts the member's opponent has raised about the
 * member's matchup in the league's current week.
 *
 * Self-contained on purpose: a notification arriving in real time has to be able
 * to refresh just the badge, and the dashboard payload does not carry the member's
 * full set of matchups. Resolving the week and the matchup here costs three small
 * index-backed reads, against re-running the whole dashboard load to redraw one
 * number, which pages the entire draft pool and reads every roster.
 *
 * The calls are also the ones the full load would make anyway, so both routes
 * share one implementation and the rules about what counts as an alert live in
 * one place.
 *
 * @param leagueId - League whose alerts to read.
 * @param userId - The signed-in member, who is the recipient.
 * @returns The alert ids and count; empty when there is nothing to show.
 */
export async function loadMatchTimeAlerts(
  leagueId: string,
  userId: string,
): Promise<MatchTimeAlerts> {
  const [progressResult, teamResult] = await Promise.all([
    // The weekly-deadline system owns the week pointer, so it is preferred. A
    // league without a deadline configured has none, and falls back below.
    loadWeekProgressState(leagueId).catch(() => null),
    supabase
      .from("teams")
      .select("id, season_id")
      .eq("league_id", leagueId)
      .eq("owner_user_id", userId)
      .maybeSingle(),
  ]);

  const teamId = teamResult.data?.id ?? null;
  const seasonId = teamResult.data?.season_id ?? null;

  if (!teamId || !seasonId) {
    return NO_ALERTS;
  }

  const { data: matchRows } = await supabase
    .from("matches")
    .select("id, week_number")
    .eq("season_id", seasonId)
    .eq("is_playoff", false)
    .or(`player_1_team_id.eq.${teamId},player_2_team_id.eq.${teamId}`);

  const matchups = (matchRows ?? []) as { id: string; week_number: number }[];

  if (matchups.length === 0) {
    return NO_ALERTS;
  }

  const week =
    progressResult?.deadline_enabled && progressResult.current_week > 0
      ? progressResult.current_week
      : (matchups
          .map((match) => match.week_number)
          .sort((a, b) => a - b)[0] ?? null);

  if (week == null) {
    return NO_ALERTS;
  }

  const myMatchIds = matchups
    .filter((match) => match.week_number === week)
    .map((match) => match.id);

  if (myMatchIds.length === 0) {
    return NO_ALERTS;
  }

  const { data, error } = await supabase
    .from("notifications")
    .select("id, actor_user_id")
    .eq("league_id", leagueId)
    .eq("recipient_user_id", userId)
    .eq("is_read", false)
    .in("type", MATCH_TIME_EVENT_TYPES)
    .in("related_entity_id", myMatchIds);

  if (error || !data) {
    return NO_ALERTS;
  }

  /*
   * The actor is compared here rather than with a `neq` filter: a null actor would
   * be dropped by SQL comparison, and more importantly a member's own actions -
   * answering a proposal, withdrawing their own - must never count as an alert
   * about themselves.
   */
  const ids = (data as { id: string; actor_user_id: string | null }[])
    .filter((row) => row.actor_user_id !== userId)
    .map((row) => row.id);

  return { ids, count: ids.length };
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
 * Formats a scheduled match time as a short date/time, or an em dash when the
 * match has no time set.
 *
 * The zone is passed in rather than read from the browser so the dashboard reads
 * times the same way the rest of the league pages do: in the zone the member
 * picked in user settings.
 *
 * @param value - An ISO timestamp, or null.
 * @param timeZone - IANA time zone to render the timestamp in.
 * @returns The formatted date/time.
 */
export function formatMatchTime(value: string | null, timeZone: string): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * Formats a notification's creation time as a short relative age such as
 * "just now", "3h ago", or "Sep 24".
 *
 * The relative labels are zone independent; only the calendar-date fallback
 * after a week depends on the reader's zone.
 *
 * @param value - An ISO timestamp.
 * @param timeZone - IANA time zone used for the calendar-date fallback.
 * @returns The relative age label.
 */
export function formatNotificationAge(
  value: string,
  timeZone: string,
): string {
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

  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
