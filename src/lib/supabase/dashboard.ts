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

/**
 * The notification types that describe a trade moving. A trade alert is only
 * raised for these; the rest of the notification history is informational.
 *
 * Kept in step with the `type` values raised by the trade RPCs in
 * supabase/migrations/20261103_trade_workflow.sql. A value added there and not here
 * would be silently omitted from the badge rather than erroring, which is the same
 * quiet-drift trap as TRANSACTION_SOURCES.
 */
const TRADE_EVENT_TYPES = [
  "trade_proposed",
  "trade_accepted",
  "trade_declined",
  "trade_withdrawn",
  "trade_pending_approval",
  "trade_rejected",
  "trade_completed",
];

/**
 * Trade statuses that can still change hands, and so can still be the subject of an
 * alert.
 *
 * An alert about a trade that has already been declined, completed, or rejected is
 * dropped rather than counted, so a badge cannot outlive the thing it is counting.
 * That is the same guarantee the match-time badge gets from being scoped to the
 * current week.
 */
const OPEN_TRADE_STATUSES = ["awaiting_response", "pending_approval", "approved"];


/**
 * Match statuses that count as still open (not yet decided).
 *
 * `unscheduled` belongs here and is the load-bearing entry. generate_schedule
 * inserts its matchups with a literal 'scheduled' but no scheduled_at, and the
 * matches_default_unscheduled trigger rewrites exactly that case to
 * 'unscheduled' (20261026_match_scheduling_agreement.sql). So every match in a
 * freshly generated schedule is unscheduled, and omitting it here made a league
 * that had just set its schedule read as having no weeks at all: the Current Week
 * card showed "Schedule not set" because the derived week had no open match to
 * point at. The list has to stay in step with matches_status_check.
 */
export const OPEN_MATCH_STATUSES = [
  "unscheduled",
  "scheduled",
  "in_progress",
] as const;

/**
 * Match statuses that mean the match is over, so its week is decided.
 *
 * The complement of {@link OPEN_MATCH_STATUSES} against matches_status_check.
 * Exported so the tests can assert the two lists still partition that
 * constraint, which is what stops a future status being added to one list and
 * forgotten in the other.
 */
export const DECIDED_MATCH_STATUSES = [
  "completed",
  "forfeit",
  "cancelled",
] as const;

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
  /** Owner avatar for each side, or null when the owner has none set. */
  player_1_avatar_url: string | null;
  player_2_avatar_url: string | null;
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

/**
 * The minimal shape a roster sprite needs.
 *
 * Matchup cards show pictures and nothing else, and a league's cards put every
 * team's roster on the page at once. Carrying {@link DashboardRosterPokemon}'s
 * typing and BST arrays for all of them would triple the payload for fields no
 * card reads, so the sprite map uses this instead and only the member's own
 * detailed roster uses the full shape.
 */
export type DashboardRosterSprite = {
  id: string;
  /** Used as the sprite's alt text, so a screen reader still names the Pokemon. */
  name: string;
  spriteId: number;
};

/** One of the signed-in member's notifications. */
export type DashboardNotification = {
  id: string;
  message: string;
  is_read: boolean;
  created_at: string;
};

/**
 * The league's rules for the current season, as the dashboard panel shows them.
 *
 * A trimmed copy of the dashboard's own {@link LeagueRules} rather than an import,
 * because this payload is consumed by a component that must not take a dependency
 * on the rules module just to render a paragraph of text.
 */
export type DashboardRules = {
  /** The rules text, or null when the owner has cleared them. */
  content: string | null;
  /** When the rules were last saved. */
  updatedAt: string;
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
  /**
   * The league's rules for the current season, or null when the owner has not set
   * any. Carried here rather than fetched by the panel because the dashboard is the
   * one page that has to render before the draft has finished, where the rules are
   * the only thing there is to show.
   */
  rules: DashboardRules | null;
/** Full standings table, ranked. */
  standings: DashboardStanding[];
  /**
   * Every open match in the current week, soonest first, backing the Schedule
   * panel. Uncapped, because the point of the panel is to show the whole week's
   * slate rather than a preview of it. Falls back to every open match once the
   * regular season is over, where playoff rounds are not in a week.
   */
  currentWeekMatches: DashboardMatch[];
  /** The member's own next open match, when they have one. */
  nextMatch: DashboardMatch | null;
  /**
   * Roster sprites for every team that appears in a matchup card on this page,
   * keyed by team id and richest Pokemon first.
   *
   * Covers the teams in {@link DashboardGoods.nextMatch} and in
   * {@link DashboardGoods.currentWeekMatches}, which is what the Next Match and
   * Schedule panels draw. Every team's roster is already read by the loader, so
   * this slices what is in hand rather than issuing another query.
   */
  rostersByTeam: Record<string, DashboardRosterSprite[]>;
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
   * Unread trade alerts raised by the other party, backing the badge on the Trades
   * nav button and on the Trades page's "My Trades" tab. Ids are carried alongside
   * the count so opening either can clear exactly these.
   */
  tradeAlertIds: string[];
  /** How many of those alerts there are. */
  tradeAlertCount: number;
  /**
   * The league this payload describes. Exposed so a real-time refresh can scope
   * its own reads without re-resolving the league from the URL.
   */
  leagueId: string;
  /**
   * Whether the signed-in member owns this league.
   *
   * Carried because the rules panel words its empty state differently for the
   * owner ("you have not set any") than for anyone else, and the shell has no other
   * way to tell: the dashboard payload carries neither the league row nor the
   * member's role.
   */
  isOwner: boolean;
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
    rules: null,
standings: [],
    currentWeekMatches: [],
    nextMatch: null,
    rostersByTeam: {},
    myTeam: null,
    myRoster: [],
    notifications: [],
    matchTimeAlertIds: [],
    matchTimeAlertCount: 0,
    tradeAlertIds: [],
    tradeAlertCount: 0,
    isOwner: false,
    leagueId: "",
  };
}

/** The fields {@link deriveCurrentWeek} reads from a match. */
type WeekDerivationMatch = Pick<
  DashboardMatch,
  "is_playoff" | "status" | "week_number"
>;

/**
 * The regular-season week the league is in: the earliest week that still has an
 * undecided match.
 *
 * A week is undecided while any of its regular-season matches is in
 * {@link OPEN_MATCH_STATUSES}. A freshly generated schedule counts throughout,
 * because every one of its matches is `unscheduled` until both sides agree a
 * time, and treating that as decided is what made a just-configured league read
 * as having no schedule. Playoff matches are ignored: a bracket round never
 * decides a regular-season week.
 *
 * @param matches - Every match in the season, playoff rounds included.
 * @returns The week number, or null when nothing regular is undecided.
 */
export function deriveCurrentWeek(matches: WeekDerivationMatch[]): number | null {
  let earliest: number | null = null;

  for (const match of matches) {
    if (match.is_playoff) continue;
    if (!(OPEN_MATCH_STATUSES as readonly string[]).includes(match.status)) continue;
    if (earliest === null || match.week_number < earliest) {
      earliest = match.week_number;
    }
  }

  return earliest;
}

/**
 * The open matches the dashboard's Schedule panel shows: the current week's whole
 * slate, in the order given.
 *
 * Filtering to the league's actual week is what keeps the panel consistent with
 * the Current Week card. A league that played through week 2 sees week 3's
 * matchups rather than the leftovers of every week, which is what an uncapped
 * "all open matches" list would show.
 *
 * Once the regular season is over `currentWeek` is null and playoff rounds are not
 * in a week at all, so everything open is returned rather than leaving the panel
 * blank through the postseason.
 *
 * @param openMatches - Open matches, already in display order.
 * @param currentWeek - The week the league is in, or null outside the regular season.
 * @returns The matches to render.
 */
export function selectCurrentWeekMatches(
  openMatches: DashboardMatch[],
  currentWeek: number | null,
): DashboardMatch[] {
  if (currentWeek == null) {
    return openMatches;
  }
  return openMatches.filter((match) => match.week_number === currentWeek);
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

const [settingsResult, teamResult, standingsResult, matchResult, rulesResult, leagueResult] =
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
          "id, week_number, is_playoff, scheduled_at, status, player_1_team_id, player_2_team_id, player_1: player_1_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url)), player_2: player_2_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url))",
        )
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("week_number", { ascending: true }),
      /*
       * The rules for this season. A failure here is deliberately not fatal: the
       * dashboard has a dozen other panels, and a league whose rules row is
       * unreadable should still show its standings rather than an error page. The
       * panel falls back to saying no rules are set.
       */
      supabase
        .from("rules_documents")
        .select("content, updated_at")
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .maybeSingle(),
      /*
       * The league's owner, so the shell can tell the owner apart from everyone
       * else when wording the rules panel. Read last so the destructuring above
       * lines up.
       */
      supabase
        .from("leagues")
        .select("owner_id")
        .eq("id", leagueId)
        .maybeSingle(),
    ]);

  const settings = settingsResult.data as {
    regular_season_weeks?: number | null;
    match_format?: "single" | "best_of_3" | null;
  } | null;

  const isOwner =
    (leagueResult.data as { owner_id?: string | null } | null)?.owner_id ===
    userId;

  const rulesRow = rulesResult.data as {
    content: string | null;
    updated_at: string;
  } | null;

  const rules: DashboardRules | null = rulesRow
    ? { content: rulesRow.content, updatedAt: rulesRow.updated_at }
    : null;

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
      owner?: { display_name?: string | null; avatar_url?: string | null } | null;
    } | null;
    player_2?: {
      team_name?: string | null;
      owner_user_id?: string;
      owner?: { display_name?: string | null; avatar_url?: string | null } | null;
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
    player_1_avatar_url: row.player_1?.owner?.avatar_url ?? null,
    player_2_avatar_url: row.player_2?.owner?.avatar_url ?? null,
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
  const derivedWeek = deriveCurrentWeek(matches);

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

  const tradeAlertsPromise = loadTradeAlerts(leagueId, userId).catch(
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
  const tradeAlerts = await tradeAlertsPromise;

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

  /** Enriches one roster row with its catalog display data, richest first. */
  const toRosterPokemon = (
    rows: typeof rosterRows,
  ): DashboardRosterPokemon[] =>
    rows
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

  const myRoster =
    myTeam == null
      ? []
      : toRosterPokemon(rosterRows.filter((row) => row.team_id === myTeam.id));

  /*
   * The Schedule panel shows the current week's whole slate, not a preview of it.
   * Filtering to the week the league is actually in is what makes the panel match
   * the Current Week card: a league that played through week 2 should see week 3's
   * matchups, not the leftovers of every week.
   *
   * Once the regular season is over currentWeek is null and the playoff rounds are
   * not in a week at all, so the panel falls back to every open match rather than
   * going blank during the postseason.
   */
  const currentWeekMatches = selectCurrentWeekMatches(sortedOpen, currentWeek);

  const myNextMatch =
    sortedOpen.find(
      (match) =>
        myTeam != null &&
        (match.player_1_team_id === myTeam.id ||
          match.player_2_team_id === myTeam.id),
    ) ?? null;

  /*
   * Sprite-only roster for one team, richest Pokemon first. Deliberately a
   * narrower shape than DashboardRosterPokemon: matchup cards draw pictures, and
   * a league's cards would otherwise carry every team's typing and BST arrays for
   * fields no card reads.
   */
  const toRosterSprites = (rows: typeof rosterRows): DashboardRosterSprite[] =>
    [...rows]
      // Richest first, ordered on the row's tier so a card matches the order the
      // roster panels use, then mapped down to the sprite shape.
      .sort((a, b) => b.tier_value - a.tier_value || a.id.localeCompare(b.id))
      .map<DashboardRosterSprite>((row) => {
        const catalog = getPokemonEntryBySlug(row.pokemon_id);
        return {
          id: row.id,
          name: catalog?.name ?? row.pokemon_id,
          spriteId: catalog?.spriteId ?? 0,
        };
      });

  const rostersByTeam: Record<string, DashboardRosterSprite[]> = {};
  const cardTeamIds = new Set<string>();
  for (const match of [myNextMatch, ...currentWeekMatches]) {
    if (!match) continue;
    cardTeamIds.add(match.player_1_team_id);
    cardTeamIds.add(match.player_2_team_id);
  }
  for (const teamId of cardTeamIds) {
    rostersByTeam[teamId] = toRosterSprites(
      rosterRows.filter((row) => row.team_id === teamId),
    );
  }

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
    rules,
standings,
    currentWeekMatches,
    nextMatch: myNextMatch,
    rostersByTeam,
    myTeam,
    myRoster,
    notifications,
    matchTimeAlertIds: alerts.ids,
    matchTimeAlertCount: alerts.count,
    tradeAlertIds: tradeAlerts.ids,
    tradeAlertCount: tradeAlerts.count,
    leagueId,
    isOwner,
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
 * Loads the unread trade alerts the other party has raised against the member in
 * the league's current season.
 *
 * Deliberately the same shape as {@link loadMatchTimeAlerts}: unread, addressed to
 * the member, restricted to a trade that can still change hands, with the member's
 * own actions excluded. Sharing that shape is what makes the two badges behave
 * identically rather than merely look alike -- both are cleared by a visit, both
 * drop on the same "Clear all", and neither ever counts something the member did.
 *
 * Self-contained for the same reason as its match-time counterpart: a notification
 * arriving in real time has to refresh just the badge, and that must not cost a full
 * dashboard load, which pages the entire draft pool and reads every roster. Two
 * small index-backed reads are enough.
 *
 * @param leagueId - League whose alerts to read.
 * @param userId - The signed-in member, who is the recipient.
 * @returns The alert ids and count; empty when there is nothing to show.
 */
export async function loadTradeAlerts(
  leagueId: string,
  userId: string,
): Promise<MatchTimeAlerts> {
  const { data: seasonRow } = await loadLatestSeason<DashboardSeason>(
    leagueId,
    "id, season_number, status, name",
  );

  const seasonId = seasonRow?.id ?? null;

  if (!seasonId) {
    return NO_ALERTS;
  }

  /*
   * Scoped to trades that are still open. The member is a party to these, either as
   * the sender or the one asked, so this is the set of trades whose outcome they are
   * actually waiting on.
   */
  const { data: tradeRows } = await supabase
    .from("trades")
    .select("id")
    .eq("league_id", leagueId)
    .eq("season_id", seasonId)
    .in("status", OPEN_TRADE_STATUSES)
    .or(`proposer_user_id.eq.${userId},recipient_user_id.eq.${userId}`);

  const openTradeIds = ((tradeRows ?? []) as { id: string }[]).map(
    (row) => row.id,
  );

  if (openTradeIds.length === 0) {
    return NO_ALERTS;
  }

  const { data, error } = await supabase
    .from("notifications")
    .select("id, actor_user_id")
    .eq("league_id", leagueId)
    .eq("recipient_user_id", userId)
    .eq("is_read", false)
    .in("type", TRADE_EVENT_TYPES)
    .in("related_entity_id", openTradeIds);

  if (error || !data) {
    return NO_ALERTS;
  }

  /*
   * The same self-exclusion the match-time alerts apply, and for the same reason: a
   * member answering their own proposal, or voting on a trade they are party to,
   * must never see the badge go up as a result of acting.
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
 * Formats a scheduled match time as a short date/time, or an empty string when
 * the match has no valid time set. Callers omit the segment rather than showing
 * a placeholder.
 *
 * The zone is passed in rather than read from the browser so the dashboard reads
 * times the same way the rest of the league pages do: in the zone the member
 * picked in user settings.
 *
 * @param value - An ISO timestamp, or null.
 * @param timeZone - IANA time zone to render the timestamp in.
 * @returns The formatted date/time, or "" when there is no valid time.
 */
export function formatMatchTime(value: string | null, timeZone: string): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
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
