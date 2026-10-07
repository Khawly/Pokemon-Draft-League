/*
 * Schedule page data layer for the Pokemon Draft League.
 *
 * Loads the league, latest season, season settings (including schedule
 * configuration), every team with its owner's display info, the season's
 * matches with per-game results and their scheduling proposals, and the computed
 * season standings. Also exposes the RPC-backed mutations the page uses:
 * generating the schedule and the playoff bracket (owner only), the two-sided
 * time agreement between participants (propose, accept/decline, withdraw),
 * submitting and (staff-only) editing game results, and forfeiting a match.
 */
import { supabase } from "@/lib/supabase/client";
import { loadLatestSeason } from "@/lib/supabase/seasons";
import { getPokemonEntryBySlug } from "@/lib/pokeapi";

/**
 * The minimal roster entry a matchup card needs: a picture and its alt text.
 * Cards show sprites only, so typing and BST are deliberately not carried.
 */
export type ScheduleRosterSprite = {
  id: string;
  /** Used as the sprite's alt text so a screen reader still names the Pokemon. */
  name: string;
  spriteId: number;
};


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
  name: string | null;
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
  /** The reporter's display name, or null when they have not set one. */
  reporter_name: string | null;
};

/** A time one participant has offered the other for a match. */
export type ScheduleProposal = {
  id: string;
  proposed_by: string;
  proposed_at: string;
  notes: string | null;
  status: "pending" | "accepted" | "declined" | "withdrawn";
  created_at: string;
  responded_at: string | null;
};

/** A head-to-head match in the season with resolved team/player display info. */
export type ScheduleMatch = {
  id: string;
  week_number: number;
  is_playoff: boolean;
  bracket_phase: "upper" | "lower" | "gf" | null;
  scheduled_at: string | null;
  status:
    | "unscheduled"
    | "scheduled"
    | "in_progress"
    | "completed"
    | "forfeit"
    | "cancelled";
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
  /**
   * Display name of whoever filed the forfeit. Falls back to the league owner's
   * name when no filer was recorded; null only if that name is unset too.
   */
  forfeited_by_name: string | null;
  /**
   * The proposal still waiting for an answer, when there is one. Its presence is
   * what makes a matchup read as "waiting on the other player" rather than
   * simply having no time.
   */
  pending_proposal: ScheduleProposal | null;
};

/**
 * One row of the owner-only match-time negotiation log.
 *
 * Unlike `ScheduleMatch.pending_proposal`, which is only the proposal still
 * waiting for an answer, this covers every proposal ever made on the match,
 * including the ones that were accepted, declined, or withdrawn. The two sides
 * are named rather than left as user ids so the log reads as a record of what
 * two people agreed to, and the week is carried so a log spanning a whole
 * season can be grouped or filtered.
 */
export type ProposalHistoryEntry = {
  id: string;
  match_id: string;
  week_number: number;
  is_playoff: boolean;
  bracket_phase: ScheduleMatch["bracket_phase"];
  status: ScheduleProposal["status"];
  /** The time offered for the match, not the time the offer was made. */
  proposed_at: string;
  notes: string | null;
  proposed_by: string;
  proposed_by_name: string;
  /** Null until the offer is answered; a proposal cannot answer itself. */
  responded_at: string | null;
  responded_by: string | null;
  /** Display name of whoever answered, or null while still pending. */
  responded_by_name: string | null;
  /** The two participants, as the owner sees them named. */
  player_1_name: string;
  player_2_name: string;
  player_1_user_id: string;
  player_2_user_id: string;
  /** When the offer was made, for ordering and for the "awaiting" row. */
  created_at: string;
};

/** A ranked standings row (already ordered by the database). */
export type StandingsRow = {
  team_id: string;
  team_name: string;
  wins: number;
  losses: number;
  ko_diff: number;
};

/**
 * Marks the member's own notifications as read.
 *
 * Used by the dashboard to clear the Schedule nav badge: opening the schedule is
 * what counts as dealing with those alerts.
 *
 * @param notificationIds - The notices to clear, or null/empty to clear them all.
 * @returns How many rows were updated.
 * @throws If the RPC fails.
 */
export async function markNotificationsRead(
  notificationIds: string[] | null = null,
): Promise<number> {
  const { data, error } = await supabase.rpc("mark_notifications_read", {
    p_notification_ids: notificationIds && notificationIds.length > 0
      ? notificationIds
      : null,
  });

  if (error) {
    throw new Error(error.message || "Notifications could not be marked as read.");
  }

  return Number(data ?? 0);
}

/** A proposal row as stored, before its match and participants are resolved. */
type ProposalHistoryRow = {
  id: string;
  match_id: string;
  status: ScheduleProposal["status"];
  proposed_at: string;
  notes: string | null;
  proposed_by: string;
  created_at: string;
  responded_at: string | null;
  responded_by: string | null;
};

/** The two participants of a match, as the owner should see them named. */
type ProposalParticipants = {
  week_number: number;
  is_playoff: boolean;
  bracket_phase: ScheduleMatch["bracket_phase"];
  player_1_name: string;
  player_2_name: string;
  player_1_user_id: string;
  player_2_user_id: string;
};

/**
 * Resolves a user id to one of the match's participants' names.
 *
 * A proposal's author and its responder are both one of the two players, so the
 * match's own participants already hold every name this log needs. Mapping off
 * the match rather than a separate profiles read keeps the log correct when a
 * member has since changed their display name, and keeps it to two queries.
 */
function participantName(
  userId: string | null,
  participants: ProposalParticipants,
): string | null {
  if (!userId) {
    return null;
  }

  if (userId === participants.player_1_user_id) {
    return participants.player_1_name;
  }

  if (userId === participants.player_2_user_id) {
    return participants.player_2_name;
  }

  /*
   * A proposal whose author or responder is not a current participant of the
   * match, which a mid-season roster change can produce. Returning the raw id is
   * better than attributing the offer to the wrong person.
   */
  return userId;
}

/**
 * Loads the full match-time negotiation history for a season, newest first.
 *
 * Covers every proposal ever made, not just the pending one a matchup card
 * shows, so the owner can see who proposed what and how each offer ended.
 *
 * Owner-only in practice. The database refuses these rows to anyone but the
 * league's owner, and the History tab checks ownership before calling this, so a
 * member never issues the query. It is deliberately separate from
 * `loadSchedulePageData`: that one is on the critical path for every member who
 * opens the Schedule tab, while this log grows with every rescheduling attempt
 * and is only wanted by the owner on one tab.
 *
 * The proposals are read by match id rather than joined onto their match.
 * Filtering a nested embed on the league proved unreliable here, and reading the
 * season's matches with `MATCHES_WITH_PARTICIPANTS_SELECT` gives both the week
 * numbers and the participant names the log has to show anyway.
 *
 * @param leagueId - The league whose history to read.
 * @param seasonId - Restricts the log to the season on screen.
 * @returns Every proposal made this season, including accepted, declined,
 *   withdrawn, and still-pending ones, newest first.
 * @throws If either query fails.
 */
export async function loadProposalHistory(
  leagueId: string,
  seasonId: string,
): Promise<ProposalHistoryEntry[]> {
  const { data: matchRows, error: matchError } = await supabase
    .from("matches")
    .select(MATCHES_WITH_PARTICIPANTS_SELECT)
    .eq("league_id", leagueId)
    .eq("season_id", seasonId);

  if (matchError) {
    throw new Error("Match proposal history could not be loaded.");
  }

  const matches = (matchRows ?? []) as ScheduleMatchRow[];
  const matchIds = matches.map((row) => row.id);

  if (matchIds.length === 0) {
    return [];
  }

  const { data: proposalRows, error: proposalError } = await supabase
    .from("match_scheduling_proposals")
    .select(
      "id, match_id, status, proposed_at, notes, proposed_by, created_at, responded_at, responded_by",
    )
    .in("match_id", matchIds)
    .order("created_at", { ascending: false });

  if (proposalError) {
    throw new Error("Match proposal history could not be loaded.");
  }

  const participantsByMatch = new Map<string, ProposalParticipants>();

  for (const row of matches) {
    const player1UserId = row.player_1?.owner_user_id ?? "";
    const player2UserId = row.player_2?.owner_user_id ?? "";

    participantsByMatch.set(row.id, {
      week_number: row.week_number,
      is_playoff: row.is_playoff,
      bracket_phase: row.bracket_phase,
      player_1_name:
        row.player_1?.owner?.display_name ??
        row.player_1?.team_name ??
        "Player 1",
      player_2_name:
        row.player_2?.owner?.display_name ??
        row.player_2?.team_name ??
        "Player 2",
      player_1_user_id: player1UserId,
      player_2_user_id: player2UserId,
    });
  }

  return ((proposalRows ?? []) as ProposalHistoryRow[]).flatMap((row) => {
    /*
     * Every id came from this season's matches, so a miss means a proposal whose
     * match was deleted between the two reads. Dropping it is better than
     * rendering a log row with no matchup attached to it.
     */
    const participants = participantsByMatch.get(row.match_id);

    if (!participants) {
      return [];
    }

    return [
      {
        id: row.id,
        match_id: row.match_id,
        status: row.status,
        proposed_at: row.proposed_at,
        notes: row.notes,
        proposed_by: row.proposed_by,
        created_at: row.created_at,
        responded_at: row.responded_at,
        responded_by: row.responded_by,
        week_number: participants.week_number,
        is_playoff: participants.is_playoff,
        bracket_phase: participants.bracket_phase,
        player_1_name: participants.player_1_name,
        player_2_name: participants.player_2_name,
        player_1_user_id: participants.player_1_user_id,
        player_2_user_id: participants.player_2_user_id,
        proposed_by_name:
          participantName(row.proposed_by, participants) ?? "Unknown",
        responded_by_name: participantName(row.responded_by, participants),
      },
    ];
  });
}


/**
 * Columns every match read needs: the match itself plus both participants
 * resolved to a live display name.
 *
 * Shared so the schedule page and the owner-only proposal history cannot drift
 * apart on how a person is named, which is the whole point of resolving the
 * owner rather than reading `teams.team_name`.
 */
const MATCHES_WITH_PARTICIPANTS_SELECT =
  "id, week_number, is_playoff, bracket_phase, scheduled_at, status, winner_team_id, notes, player_1_team_id, player_2_team_id, player_1: player_1_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url)), player_2: player_2_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url)), forfeited_by: forfeited_by_user_id (display_name)";

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
  /**
   * Sprite-only roster for every team in the season, keyed by team id and richest
   * Pokemon first. Backs the sprite rows on the matchup cards.
   */
  rostersByTeam: Record<string, ScheduleRosterSprite[]>;
  standings: StandingsRow[];
  currentUserId: string;
  userRole: "owner" | "admin" | "member" | null;
  isOwner: boolean;
  isStaff: boolean;
  myTeamId: string | null;
};

type ScheduleMatchRow = {
  forfeited_by?: { display_name?: string | null } | null;
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

  const { data: seasonRow, error: seasonError } = await loadLatestSeason<ScheduleSeason>(
    leagueId,
    "id, season_number, status, name",
  );

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
    rostersByTeam: {},
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
    .select(MATCHES_WITH_PARTICIPANTS_SELECT)
    .eq("league_id", leagueId)
    .eq("season_id", season.id)
    .order("week_number", { ascending: true })
    .order("created_at", { ascending: true });

  if (matchError) {
    throw new Error("Matches could not be loaded.");
  }

  const matchIds = (matchRows ?? []).map((row) => row.id);

  /*
   * The league owner's display name, used to attribute a forfeit whose filer was
   * not recorded (forfeits filed before attribution existed). A missing profile
   * or a failed read just leaves the name unset rather than failing the page.
   */
  const { data: ownerProfile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", league.owner_id)
    .maybeSingle();
  const ownerDisplayName =
    (ownerProfile as { display_name?: string | null } | null)?.display_name ?? null;

  /*
   * Rosters for every team in the season, so each matchup card can show both
   * sides' Pokemon. One query for all teams rather than one per card; the card
   * only reads the sprite fields, so the rest of the row is not selected.
   */
  const rostersByTeam: Record<string, ScheduleRosterSprite[]> = {};
  const teamIds = teams.map((team) => team.id);
  if (teamIds.length > 0) {
    const { data: rosterRows, error: rosterError } = await supabase
      .from("team_roster")
      .select("id, team_id, pokemon_id, tier_value")
      .in("team_id", teamIds);

    if (rosterError) {
      throw new Error("Team rosters could not be loaded.");
    }

    const rows = (rosterRows ?? []) as {
      id: string;
      team_id: string;
      pokemon_id: string;
      tier_value: number;
    }[];

    for (const teamId of teamIds) {
      rostersByTeam[teamId] = rows
        .filter((row) => row.team_id === teamId)
        // Richest first, matching the order the roster panels use.
        .sort((a, b) => b.tier_value - a.tier_value || a.id.localeCompare(b.id))
        .map<ScheduleRosterSprite>((row) => {
          const catalog = getPokemonEntryBySlug(row.pokemon_id);
          return {
            id: row.id,
            name: catalog?.name ?? row.pokemon_id,
            spriteId: catalog?.spriteId ?? 0,
          };
        });
    }
  }

  const resultsByMatch = new Map<string, ScheduleMatchResult[]>();
  if (matchIds.length > 0) {
    const { data: resultRows, error: resultsError } = await supabase
      .from("match_results")
      .select(
        "id, match_id, winner_team_id, replay_url, game_number, pokemon_left_alive, submitted_at, reporter: reporter_user_id (display_name)",
      )
      .in("match_id", matchIds);

    if (resultsError) {
      throw new Error("Match results could not be loaded.");
    }

    for (const row of (resultRows ?? []) as unknown as (Omit<
      ScheduleMatchResult,
      "match_id" | "reporter_name"
    > & {
      match_id: string;
      reporter?: { display_name?: string | null } | null;
    })[]) {
      const current = resultsByMatch.get(row.match_id) ?? [];
      current.push({
        id: row.id,
        winner_team_id: row.winner_team_id,
        replay_url: row.replay_url,
        game_number: row.game_number,
        pokemon_left_alive: row.pokemon_left_alive,
        submitted_at: row.submitted_at,
        reporter_name: row.reporter?.display_name ?? null,
      });
      resultsByMatch.set(row.match_id, current);
    }
  }

  /*
   * Only the still-pending proposal changes what the card has to say, so just that
   * one is read. Asking for every historical row would grow with every reschedule
   * attempt while telling the user nothing extra.
   */
  const pendingProposals = new Map<string, ScheduleProposal>();
  if (matchIds.length > 0) {
    const { data: proposalRows, error: proposalError } = await supabase
      .from("match_scheduling_proposals")
      .select("id, match_id, proposed_by, proposed_at, notes, status, created_at, responded_at")
      .in("match_id", matchIds)
      .eq("status", "pending");

    if (proposalError) {
      throw new Error("Match time proposals could not be loaded.");
    }

    for (const row of (proposalRows ?? []) as (Omit<ScheduleProposal, "match_id"> & {
      match_id: string;
    })[]) {
      pendingProposals.set(row.match_id, {
        id: row.id,
        proposed_by: row.proposed_by,
        proposed_at: row.proposed_at,
        notes: row.notes,
        status: row.status,
        created_at: row.created_at,
        responded_at: row.responded_at,
      });
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
      /*
       * The owner's live display name, not the team's name. `teams.team_name` is
       * a snapshot copied out of `profiles.display_name` when the draft started
       * and is not editable anywhere, so labelling a player with it left every
       * matchup showing the name the member had before they changed it, next to
       * their up-to-date avatar. The team name is kept as the fallback for a
       * profile with no display name set.
       */
      player_1_name:
        row.player_1?.owner?.display_name ?? row.player_1?.team_name ?? "Team 1",
      player_2_name:
        row.player_2?.owner?.display_name ?? row.player_2?.team_name ?? "Team 2",
      player_1_avatar_url: row.player_1?.owner?.avatar_url ?? null,
      player_2_avatar_url: row.player_2?.owner?.avatar_url ?? null,
      player_1_user_id: row.player_1?.owner_user_id ?? "",
      player_2_user_id: row.player_2?.owner_user_id ?? "",
      results: resultsByMatch.get(row.id) ?? [],
      // A forfeit with no recorded filer is attributed to the league owner.
      forfeited_by_name: row.forfeited_by?.display_name ?? ownerDisplayName,
      pending_proposal: pendingProposals.get(row.id) ?? null,
    }),
  );


  return {
    ...base,
    settings,
    teams,
    matches,
    rostersByTeam,
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
 * Offers a date/time to the opponent for a match the user participates in.
 *
 * The match stays unscheduled until the opponent accepts; a time that has not
 * been agreed is never treated as scheduled.
 *
 * @param matchId - The match to propose a time for.
 * @param scheduledAt - The proposed ISO timestamp.
 * @param notes - Optional notes sent along with the proposal.
 * @throws If the RPC rejects the proposal.
 */
export async function proposeMatchTime(
  matchId: string,
  scheduledAt: string,
  notes: string,
): Promise<void> {
  const { error } = await supabase.rpc("propose_match_time", {
    p_match_id: matchId,
    p_scheduled_at: scheduledAt,
    p_notes: notes,
  });

  if (error) {
    throw new Error(error.message || "The match time could not be proposed.");
  }
}

/**
 * Accepts or declines the time the opponent proposed (participants only, and
 * only for a proposal the caller did not make).
 *
 * @param matchId - The match being scheduled.
 * @param accept - True to agree to the proposed time, false to decline it.
 * @returns The match's resulting status, `scheduled` or `unscheduled`.
 * @throws If the RPC rejects the response.
 */
export async function respondToMatchProposal(
  matchId: string,
  accept: boolean,
): Promise<"scheduled" | "unscheduled"> {
  const { data, error } = await supabase.rpc("respond_to_match_proposal", {
    p_match_id: matchId,
    p_accept: accept,
  });

  if (error) {
    throw new Error(error.message || "The proposal could not be answered.");
  }

  return data === "scheduled" ? "scheduled" : "unscheduled";
}

/**
 * Withdraws a pending proposal the user made, leaving the matchup needing a time
 * again.
 *
 * @param matchId - The match to withdraw from.
 * @throws If the RPC rejects the withdrawal.
 */
export async function cancelMatchProposal(matchId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_match_proposal", {
    p_match_id: matchId,
  });

  if (error) {
    throw new Error(error.message || "The proposal could not be withdrawn.");
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
 * Forfeits a match on behalf of one or both players (league owner only).
 *
 * @param matchId - The match to forfeit.
 * @param side - `player_1` or `player_2` forfeits that side and the other wins;
 *   `both` closes the match as a double forfeit with no winner.
 */
export async function ownerForfeitMatch(
  matchId: string,
  side: "player_1" | "player_2" | "both",
): Promise<void> {
  const { error } = await supabase.rpc("owner_forfeit_match", {
    p_match_id: matchId,
    p_side: side,
  });

  if (error) {
    throw new Error(error.message || "The match could not be forfeited.");
  }
}

/**
 * Reverts a forfeited match to its real state (league owner only). The database
 * restores the status from the reported games and any agreed time.
 *
 * @param matchId - The forfeited match to reopen.
 * @throws If the match is not forfeited or the caller is not the league owner.
 */
export async function ownerRevertForfeit(matchId: string): Promise<void> {
  const { error } = await supabase.rpc("owner_revert_forfeit", {
    p_match_id: matchId,
  });

  if (error) {
    throw new Error(error.message || "The forfeit could not be reverted.");
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

/** A run of proposals from one week of the season, for the owner history log. */
export type ProposalHistoryGroup = {
  week_number: number;
  is_playoff: boolean;
  bracket_phase: ProposalHistoryEntry["bracket_phase"];
  entries: ProposalHistoryEntry[];
};

/**
 * Groups the owner proposal log by week, newest week first.
 *
 * The loader already returns the whole log newest first, so this only has to
 * bucket it. Weeks come out in descending order, which for a proposal log reads
 * as "most recent first" the way a member would expect, and each week's entries
 * keep the loader's ordering rather than being re-sorted.
 *
 * @param entries - The log as loaded.
 * @returns One group per week that has at least one proposal, newest week first.
 */
export function groupProposalHistoryByWeek(
  entries: ProposalHistoryEntry[],
): ProposalHistoryGroup[] {
  const groups = new Map<number, ProposalHistoryGroup>();

  for (const entry of entries) {
    const existing = groups.get(entry.week_number);

    if (existing) {
      existing.entries.push(entry);
      continue;
    }

    groups.set(entry.week_number, {
      week_number: entry.week_number,
      is_playoff: entry.is_playoff,
      bracket_phase: entry.bracket_phase,
      entries: [entry],
    });
  }

  return [...groups.values()].sort(
    (a, b) => b.week_number - a.week_number,
  );
}

/**
 * Describes how a match-time offer ended, in the terms the owner cares about.
 *
 * The log's job is to answer "did they agree, and who said no", so a bare status
 * is not enough: an accepted offer names who accepted it, and a pending one says
 * plainly that nobody has answered rather than leaving that to be inferred from
 * a missing name.
 *
 * @param entry - One log row.
 * @returns A short phrase such as "Accepted by Bam".
 */
export function proposalOutcomeLabel(entry: ProposalHistoryEntry): string {
  switch (entry.status) {
    case "accepted":
      return entry.responded_by_name
        ? `Accepted by ${entry.responded_by_name}`
        : "Accepted";
    case "declined":
      return entry.responded_by_name
        ? `Declined by ${entry.responded_by_name}`
        : "Declined";
    case "withdrawn":
      return entry.responded_by_name
        ? `Withdrawn by ${entry.responded_by_name}`
        : "Withdrawn";
    default:
      return "Awaiting a response";
  }
}

/** Tailwind text colour for a proposal's outcome badge. */
export function proposalOutcomeTone(
  status: ProposalHistoryEntry["status"],
): string {
  switch (status) {
    case "accepted":
      return "text-emerald-300 border-emerald-800 bg-emerald-950/40";
    case "declined":
      return "text-rose-300 border-rose-800 bg-rose-950/40";
    case "withdrawn":
      return "text-slate-300 border-slate-700 bg-slate-900";
    default:
      return "text-amber-300 border-amber-800 bg-amber-950/40";
  }
}

/**
 * Labels the week a proposal belongs to.
 *
 * Playoff proposals are keyed to the round they were played in, not to a week
 * number, so calling one "Week 4" would be wrong and "Playoffs" is what the rest
 * of the page already says.
 *
 * @param group - The week group being labelled.
 * @returns A label such as "Week 3" or "Playoffs".
 */
export function proposalWeekLabel(group: {
  week_number: number;
  is_playoff: boolean;
}): string {
  if (group.is_playoff) {
    return "Playoffs";
  }

  return `Week ${group.week_number}`;
}

/** Match statuses that are settled: nothing more will be decided about them. */
const SETTLED_MATCH_STATUSES: ReadonlySet<ScheduleMatch["status"]> = new Set([
  "completed",
  "forfeit",
  "cancelled",
]);

/**
 * Labels the competitive phase a season is in.
 *
 * The phase is derived rather than stored because no single column tracks it:
 * `seasons.status` only covers the draft, `league_settings.current_week` is the
 * progression pointer, and the playoff flags live on individual matches. The
 * trap is reading a missing current week as "the season is over" — a league
 * still in its draft, or one that has not generated a schedule yet, has no
 * current week either, so that reading labelled every new season "Postseason".
 * The postseason now requires the regular season to actually be behind us,
 * which is either the deadline sweep having closed the final week or every
 * regular match already decided (a league that never ran a deadline and simply
 * finished its schedule).
 *
 * @param input - The current week pointer, whether the regular season has been
 *   frozen by the deadline sweep, and the season's non-playoff matches.
 * @returns A label such as "Current week 3", "Preseason", or "Postseason".
 */
export function seasonPhaseLabel(input: {
  currentWeek: number | null;
  regularSeasonCompleted: boolean;
  regularMatches: Pick<ScheduleMatch, "status">[];
}): string {
  const { currentWeek, regularSeasonCompleted, regularMatches } = input;

  // Checked before the week pointer because the sweep deliberately leaves
  // current_week parked on the final week when it freezes the regular season.
  const regularSeasonOver =
    regularSeasonCompleted ||
    (regularMatches.length > 0 &&
      regularMatches.every((match) => SETTLED_MATCH_STATUSES.has(match.status)));

  if (regularSeasonOver) {
    return "Postseason";
  }

  if (currentWeek != null) {
    return `Current week ${currentWeek}`;
  }

  return "Preseason";
}
