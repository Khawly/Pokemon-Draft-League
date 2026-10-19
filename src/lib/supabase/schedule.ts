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
import { loadSeason } from "@/lib/supabase/seasons";
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
  /** Whether admins may act on matchup cards (the owner always may). */
  admins_edit_matchups: boolean;
  /** Whether the teams that miss the playoff field play a consolation bracket. */
  enable_toilet_bowl: boolean;
};

/** A team slot in the season with its owner's resolved display info. */
export type ScheduleTeam = {
  id: string;
  owner_user_id: string;
  team_name: string;
  owner_name: string | null;
  owner_avatar_url: string | null;
  /** The owner's stored name colour, passed through raw for render-time normalization. */
  owner_name_color: string | null;
  /** The owner's stored avatar initials, raw, or null when they have none set. */
  owner_avatar_initials: string | null;
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
  /** The reporter's stored name colour, raw, or null when they have none set. */
  reporter_name_color: string | null;
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
  /**
   * Which press of Advance Playoffs created this game, or null for a regular-season
   * game or one written before the column existed. One press can create games in several
   * weeks and in two phases at once, so this is what the bracket round label counts.
   */
  playoff_round_no: number | null;
  bracket_phase: "upper" | "lower" | "gf" | "toilet" | null;

/**
   * Position of this game within its round, as written by the bracket generator.
   *
   * A game whose feeder was a double forfeit is never created, so a round can hold fewer
   * rows than its template has games. That makes ordinal position unreliable for pairing
   * games to the bracket, and this is what the pairing is keyed on instead.
   */
  bracket_slot: number | null;

  /** Row creation time; orders a round's games when the bracket slot is absent. */
  created_at: string;
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
  /**
   * Null on a playoff game that was settled as a bye, where the opponent was eliminated
   * by a double forfeit and the remaining team advanced without playing.
   */
  player_2_team_id: string | null;
  player_1_name: string;
  /** Reads "Bye" on a one-sided playoff game, rather than naming a team that never was. */
  player_2_name: string;
  /** Each side's stored name colour, raw, or null when the owner has none set. */
  player_1_name_color: string | null;
  player_2_name_color: string | null;
  player_1_avatar_url: string | null;
  player_2_avatar_url: string | null;
  /** Each side's stored avatar initials, raw, or null when the owner has none set. */
  player_1_avatar_initials: string | null;
  player_2_avatar_initials: string | null;
  player_1_user_id: string;
  player_2_user_id: string;
  results: ScheduleMatchResult[];
  /**
   * Display name of whoever filed the forfeit. Falls back to the league owner's
   * name when no filer was recorded; null only if that name is unset too.
   */
  forfeited_by_name: string | null;
  /**
   * The forfeit filer's stored name colour, raw. Null when no filer was recorded
   * or the owner has none set; a forfeit attributed to the league owner leaves it
   * null rather than guessing the filer's colour.
   */
  forfeited_by_name_color: string | null;
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
  /** The proposer's stored name colour, raw, or null when they have none set. */
  proposed_by_name_color: string | null;
  /** Null until the offer is answered; a proposal cannot answer itself. */
  responded_at: string | null;
  responded_by: string | null;
  /** Display name of whoever answered, or null while still pending. */
  responded_by_name: string | null;
  /** The responder's stored name colour, raw, or null while still pending. */
  responded_by_name_color: string | null;
  /** The two participants, as the owner sees them named. */
  player_1_name: string;
  player_2_name: string;
  /** Each participant's stored name colour, raw, or null when unset. */
  player_1_name_color: string | null;
  player_2_name_color: string | null;
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
 * A signature of everything about a match that feeds the standings table.
 *
 * The standings are derived from settled matches and from the per-game results behind
 * their KO differential, so a change to any of those makes the table stale and a change to
 * anything else does not. Naming that set here keeps the comparison below honest: adding a
 * field to what the table reads without adding it here would silently leave the table
 * behind.
 */
function standingsSignature(match: ScheduleMatch): string {
  const results = match.results
    .map(
      (result) =>
        `${result.id}:${result.winner_team_id}:${result.pokemon_left_alive ?? ""}`,
    )
    .join(",");

  return `${match.status}:${match.winner_team_id ?? ""}:${results}`;
}

/**
 * Whether a change to the season's matches could have moved the standings or the champion.
 *
 * Used to decide how much a realtime update has to re-read. A scheduling change, a
 * proposal, or a note being added all leave the table exactly as it was, and those are the
 * common case; a result landing is what moves it. Re-reading two more endpoints for every
 * one of them is most of what made a realtime update cost a dozen requests.
 *
 * Compares the whole set rather than only the matches present in both, so a game being
 * created or removed counts as a move: a bracket round appearing changes what the champion
 * function would answer.
 *
 * @param before - The matches the page was showing.
 * @param after - The matches just read.
 * @returns True when the standings and champion are worth re-reading.
 */
export function movesStandings(
  before: ScheduleMatch[],
  after: ScheduleMatch[],
): boolean {
  if (before.length !== after.length) {
    return true;
  }

  const previous = new Map(
    before.map((match) => [match.id, standingsSignature(match)]),
  );

  for (const match of after) {
    const signature = previous.get(match.id);

    // A match that was not there before.
    if (signature === undefined) {
      return true;
    }

    if (signature !== standingsSignature(match)) {
      return true;
    }

    previous.delete(match.id);
  }

  // Anything left over was in the old set and is not in the new one.
  return previous.size > 0;
}

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
  player_1_name_color: string | null;
  player_2_name_color: string | null;
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
 * Resolves a user id to one of the match's participants' stored name colours.
 *
 * The mirror of {@link participantName}, and resolved the same way for the same
 * reason: a user id that is not one of the two participants cannot be given a
 * colour either, so it reads as unset rather than as someone else's.
 */
function participantNameColor(
  userId: string | null,
  participants: ProposalParticipants,
): string | null {
  if (!userId) {
    return null;
  }

  if (userId === participants.player_1_user_id) {
    return participants.player_1_name_color;
  }

  if (userId === participants.player_2_user_id) {
    return participants.player_2_name_color;
  }

  return null;
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
      player_1_name_color: row.player_1?.owner?.name_color ?? null,
      player_2_name_color: row.player_2?.owner?.name_color ?? null,
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
        player_1_name_color: participants.player_1_name_color,
        player_2_name_color: participants.player_2_name_color,
        player_1_user_id: participants.player_1_user_id,
        player_2_user_id: participants.player_2_user_id,
        proposed_by_name:
          participantName(row.proposed_by, participants) ?? "Unknown",
        proposed_by_name_color: participantNameColor(
          row.proposed_by,
          participants,
        ),
        responded_by_name: participantName(row.responded_by, participants),
        responded_by_name_color: participantNameColor(
          row.responded_by,
          participants,
        ),
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
  "id, week_number, is_playoff, playoff_round_no, bracket_phase, bracket_slot, scheduled_at, status, winner_team_id, notes, created_at, player_1_team_id, player_2_team_id, player_1: player_1_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url, name_color, avatar_initials)), player_2: player_2_team_id (team_name, owner_user_id, owner: owner_user_id (display_name, avatar_url, name_color, avatar_initials)), forfeited_by: forfeited_by_user_id (display_name, name_color)";

/**
 * The same match read, with each match's results and pending proposal embedded.
 *
 * Resolving the relationships in one request rather than three is what makes the cheap
 * refresh affordable. Reading the two child tables separately needs the match ids first,
 * so it is a sequential round trip each, and those three requests were the bulk of what a
 * realtime update cost when the page reloaded its whole payload.
 *
 * The proposal embed is filtered to pending at the query, so the payload carries the one
 * row a card can act on rather than every reschedule attempt ever made against the match.
 * PostgREST applies `proposals.status` to the embed rather than to the parent, so matches
 * with no pending offer still come back, with an empty array.
 */
const MATCHES_WITH_LIVE_SELECT = `${MATCHES_WITH_PARTICIPANTS_SELECT}, results:match_results (id, winner_team_id, replay_url, game_number, pokemon_left_alive, submitted_at, reporter: reporter_user_id (display_name, name_color)), proposals:match_scheduling_proposals (id, proposed_by, proposed_at, notes, status, created_at, responded_at)`;

/** A played game of a match, as it arrives embedded in a match read. */
type EmbeddedResult = Omit<
  ScheduleMatchResult,
  "match_id" | "reporter_name" | "reporter_name_color"
> & {
  reporter?: {
    display_name?: string | null;
    name_color?: string | null;
  } | null;
};

/** A scheduling proposal, as it arrives embedded in a match read. */
type EmbeddedProposal = Omit<ScheduleProposal, "match_id">;

/** The live part of the schedule page: what a match changing can move. */
export type ScheduleLiveData = {
  matches: ScheduleMatch[];
  standings: StandingsRow[];
  championTeamId: string | null;
};

/** Narrows a raw standings RPC row to the shape the page renders. */
function toStandingsRows(data: unknown): StandingsRow[] {
  return ((data ?? []) as StandingsRow[]).map((row) => ({
    team_id: row.team_id,
    team_name: row.team_name,
    wins: Number(row.wins),
    losses: Number(row.losses),
    ko_diff: Number(row.ko_diff),
  }));
}

/**
 * Loads every match in the season with its results and pending proposal attached.
 *
 * @param leagueId - League whose matches to read.
 * @param seasonId - Season to read them for.
 * @param ownerDisplayName - The league owner's name, used to attribute a forfeit filed
 *   before attribution was recorded. Passed in rather than read again, because it is the
 *   owner's profile and does not change while the page is open.
 * @returns The season's matches, ordered by week then creation.
 * @throws If the read fails.
 */
export async function loadScheduleMatches(
  leagueId: string,
  seasonId: string,
  ownerDisplayName: string | null,
): Promise<ScheduleMatch[]> {
  const { data: matchRows, error: matchError } = await supabase
    .from("matches")
    .select(MATCHES_WITH_LIVE_SELECT)
    .eq("league_id", leagueId)
    .eq("season_id", seasonId)
    // Narrows the embedded proposals, not the matches: see MATCHES_WITH_LIVE_SELECT.
    .eq("proposals.status", "pending")
    .order("week_number", { ascending: true })
    .order("created_at", { ascending: true });

  if (matchError) {
    throw new Error("Matches could not be loaded.");
  }

  return ((matchRows ?? []) as unknown as ScheduleMatchRow[]).map(
    (row): ScheduleMatch => {
      /*
       * Results arrive embedded and unordered. Sorted by game number so a card lists
       * game 1 before game 2 without the renderer having to know to do it, which is what
       * the separate read happened to produce by insertion order.
       */
      const results = (row.results ?? [])
        .map(
          (result): ScheduleMatchResult => ({
            id: result.id,
            winner_team_id: result.winner_team_id,
            replay_url: result.replay_url,
            game_number: result.game_number,
            pokemon_left_alive: result.pokemon_left_alive,
            submitted_at: result.submitted_at,
            reporter_name: result.reporter?.display_name ?? null,
            reporter_name_color: result.reporter?.name_color ?? null,
          }),
        )
        .sort((a, b) => a.game_number - b.game_number);

      // Only the pending offer changes what the card has to say; the rest of the log is
      // the owner-only history panel's business.
      const pending =
        (row.proposals ?? []).find(
          (proposal) => proposal.status === "pending",
        ) ?? null;

      return {
        id: row.id,
        week_number: row.week_number,
        is_playoff: row.is_playoff,
        playoff_round_no: row.playoff_round_no ?? null,
        bracket_phase: row.bracket_phase,
        bracket_slot: row.bracket_slot,
        scheduled_at: row.scheduled_at,
        created_at: row.created_at,
        status: row.status,
        winner_team_id: row.winner_team_id,
        notes: row.notes,
        player_1_team_id: row.player_1_team_id,
        player_2_team_id: row.player_2_team_id,
        /*
         * The owner's live display name, not the team's name. `teams.team_name` is a
         * snapshot copied out of `profiles.display_name` when the draft started and is not
         * editable anywhere, so labelling a player with it left every matchup showing the
         * name the member had before they changed it, next to their up-to-date avatar. The
         * team name is kept as the fallback for a profile with no display name set.
         */
        player_1_name:
          row.player_1?.owner?.display_name ?? row.player_1?.team_name ?? "Team 1",
        player_2_name:
          row.player_2?.owner?.display_name ??
          row.player_2?.team_name ??
          // A one-sided playoff game is a bye: the opponent dropped out by double
          // forfeit, so there is no team here to name.
          (row.player_2_team_id ? "Team 2" : "Bye"),
        player_1_name_color: row.player_1?.owner?.name_color ?? null,
        player_2_name_color: row.player_2?.owner?.name_color ?? null,
        player_1_avatar_url: row.player_1?.owner?.avatar_url ?? null,
        player_2_avatar_url: row.player_2?.owner?.avatar_url ?? null,
        player_1_avatar_initials: row.player_1?.owner?.avatar_initials ?? null,
        player_2_avatar_initials: row.player_2?.owner?.avatar_initials ?? null,
        player_1_user_id: row.player_1?.owner_user_id ?? "",
        player_2_user_id: row.player_2?.owner_user_id ?? "",
        results,
        // A forfeit with no recorded filer is attributed to the league owner.
        forfeited_by_name: row.forfeited_by?.display_name ?? ownerDisplayName,
        // Only the recorded filer's colour is carried; the owner fallback above names the
        // owner without knowing whose colour that would be.
        forfeited_by_name_color: row.forfeited_by?.name_color ?? null,
        pending_proposal: pending
          ? {
              id: pending.id,
              proposed_by: pending.proposed_by,
              proposed_at: pending.proposed_at,
              notes: pending.notes,
              status: pending.status,
              created_at: pending.created_at,
              responded_at: pending.responded_at,
            }
          : null,
      };
    },
  );
}

/**
 * Loads the standings table and the champion.
 *
 * The two are read together because they move together: both are derived from settled
 * playoff and regular matches, so a caller that needs one after a result almost always
 * needs the other.
 *
 * @param leagueId - League whose standings to read.
 * @param seasonId - Season that owns the champion.
 * @returns The ranked rows and the champion team id, or null while the bracket runs.
 * @throws If the standings read fails.
 */
export async function loadScheduleStandings(
  leagueId: string,
  seasonId: string,
): Promise<{
  standings: StandingsRow[];
  championTeamId: string | null;
  crownedMemberIds: string[];
}> {
  const [standingsResult, championResult, crownResult] = await Promise.all([
    // Scoped to the season on screen rather than to the newest one: looking back at an
    // older season should rank that season's results.
    supabase.rpc("season_standings_for", {
      p_league_id: leagueId,
      p_season_id: seasonId,
    }),
    // Not fatal on its own: a champion banner is one line on the page.
    supabase.rpc("playoff_champion", {
      p_league_id: leagueId,
      p_season_id: seasonId,
    }),
    /*
     * Members who wear the crown in this season's view: the winner of the most recent
     * decided season, which is this one once its final is played and the previous winner
     * until then. Loaded here rather than on its own because a result that moves the
     * standings is exactly what can decide a champion.
     */
    supabase.rpc("crowned_members", {
      p_league_id: leagueId,
      p_season_id: seasonId,
    }),
  ]);

  if (standingsResult.error) {
    throw new Error("Standings could not be loaded.");
  }

  return {
    standings: toStandingsRows(standingsResult.data),
    championTeamId: (championResult.data as string | null) ?? null,
    crownedMemberIds: crownResult.error
      ? []
      : ((crownResult.data ?? []) as { user_id: string }[]).map(
          (row) => row.user_id,
        ),
  };
}

/** Complete schedule page payload for a league. */
export type SchedulePageGoods = {
  /**
   * The bracket's full shape, including games that do not exist yet.
   *
   * Null on the initial skeleton before the league resolves.
   */
  playoffTemplate?: SchedulePlayoffTemplate | null;
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
  /**
   * Whether the viewer may act on matchup cards: submit results, forfeit, revert,
   * and read replays. The owner always may; admins only when the league has the
   * "Admins can edit all matchup cards" setting on.
   */
  canEditMatchups: boolean;
  myTeamId: string | null;
  /** Team id of the champion, or null while the tournament runs or nobody won it. */
  championTeamId: string | null;
  /** Member ids who should show the champion crown in this season's view. */
  crownedMemberIds: string[];
  /**
   * The league owner's display name.
   *
   * Carried so a cheap match refresh can attribute a forfeit filed before attribution was
   * recorded without re-reading the owner's profile, which does not change while the page
   * is open.
   */
  ownerDisplayName: string | null;
};

type ScheduleMatchRow = {
  forfeited_by?: {
    display_name?: string | null;
    name_color?: string | null;
  } | null;
  id: string;
  week_number: number;
  is_playoff: boolean;
  /**
   * Which press of Advance Playoffs created this game, or null for a regular-season
   * game or one written before the column existed.
   */
  playoff_round_no: number | null;
  bracket_phase: ScheduleMatch["bracket_phase"];
  bracket_slot: number | null;
  created_at: string;
  scheduled_at: string | null;
  status: ScheduleMatch["status"];
  winner_team_id: string | null;
  notes: string | null;
  player_1_team_id: string;
  player_2_team_id: string | null;
  /** Played games, embedded by {@link MATCHES_WITH_LIVE_SELECT}. */
  results?: EmbeddedResult[] | null;
  /** Every proposal for the match; only the pending one is kept. */
  proposals?: EmbeddedProposal[] | null;
  player_1?: {
    team_name?: string;
    owner_user_id?: string;
    owner?: {
      display_name?: string | null;
      avatar_url?: string | null;
      name_color?: string | null;
      avatar_initials?: string | null;
    } | null;
  } | null;
  player_2?: {
    team_name?: string;
    owner_user_id?: string;
    owner?: {
      display_name?: string | null;
      avatar_url?: string | null;
      name_color?: string | null;
      avatar_initials?: string | null;
    } | null;
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
  seasonId?: string | null,
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

  const { data: seasonRow, error: seasonError } = await loadSeason<ScheduleSeason>(
    leagueId,
    "id, season_number, status, name",
    seasonId,
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
    canEditMatchups: false,
    isStaff: false,
    myTeamId: null,
    championTeamId: null,
    crownedMemberIds: [],
    ownerDisplayName: null,
  };

  if (!season) {
    return base;
  }

  const [settingsResult, teamResult, memberResult, standingsAndChampion] =
    await Promise.all([
      supabase
        .from("league_settings")
        .select(
          "regular_season_weeks, match_format, playoff_team_count, playoff_match_format, playoff_format, enable_pokemon_costs, total_token_salary, allow_per_team_salary, total_rounds, admins_edit_matchups, enable_toilet_bowl",
        )
        .eq("season_id", season.id)
        .maybeSingle(),
      supabase
        .from("teams")
        .select(
          "id, owner_user_id, team_name, profiles: owner_user_id (display_name, avatar_url, name_color, avatar_initials)",
        )
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("draft_position", { ascending: true, nullsFirst: false }),
      supabase
        .from("league_members")
        .select("user_id, role")
        .eq("league_id", leagueId)
        .eq("is_active", true),
      /*
       * The standings and the champion, from the functions that decide them.
       *
       * The champion used to be worked out on the page by picking a finished final, and
       * falling back to "the last completed winners game" for a league with no finals.
       * That fallback is a single elimination rule, and in a double elimination bracket it
       * matches the first completed game of the first round, so the banner named a
       * champion one round into the tournament. A settled bye is indistinguishable from a
       * completed game that way, which is how it surfaced as soon as a bye appeared.
       */
      loadScheduleStandings(leagueId, season.id),
    ]);

  /*
   * The champion read is deliberately not fatal inside loadScheduleStandings, but a
   * standings failure is. A champion banner is one line on the page, and refusing to load
   * the whole schedule because the function that names the champion failed would be a poor
   * trade; the standings table is the page.
   */
  if (settingsResult.error || teamResult.error || memberResult.error) {
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
    admins_edit_matchups: boolean;
    enable_toilet_bowl: boolean;
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
        admins_edit_matchups: settingsRow.admins_edit_matchups === true,
        enable_toilet_bowl: settingsRow.enable_toilet_bowl === true,
      }
    : null;

  const teams = ((teamResult.data ?? []) as {
    id: string;
    owner_user_id: string;
    team_name: string;
    profiles?: {
      display_name?: string | null;
      avatar_url?: string | null;
      name_color?: string | null;
      avatar_initials?: string | null;
    } | null;
  }[]).map(
    (row): ScheduleTeam => ({
      id: row.id,
      owner_user_id: row.owner_user_id,
      team_name: row.team_name,
      owner_name: row.profiles?.display_name ?? null,
      owner_avatar_url: row.profiles?.avatar_url ?? null,
      owner_name_color: row.profiles?.name_color ?? null,
      owner_avatar_initials: row.profiles?.avatar_initials ?? null,
    }),
  );

  const members = ((memberResult.data ?? []) as {
    user_id: string;
    role: "owner" | "admin" | "member";
  }[]) ?? [];

  const myMembership = members.find((member) => member.user_id === user.id);
  const userRole = myMembership?.role ?? null;
  const myTeam = teams.find((team) => team.owner_user_id === user.id);

  const standings = standingsAndChampion.standings;

  /*
   * The league owner's display name, used to attribute a forfeit whose filer was not
   * recorded (forfeits filed before attribution existed). A missing profile or a failed
   * read just leaves the name unset rather than failing the page.
   */
  const { data: ownerProfile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", league.owner_id)
    .maybeSingle();
  const ownerDisplayName =
    (ownerProfile as { display_name?: string | null } | null)?.display_name ?? null;

  const matches = await loadScheduleMatches(
    leagueId,
    season.id,
    ownerDisplayName,
  );

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

  return {
    ...base,
    settings,
    teams,
    matches,
    rostersByTeam,
    standings,
    championTeamId: standingsAndChampion.championTeamId,
    crownedMemberIds: standingsAndChampion.crownedMemberIds,
    ownerDisplayName,
    // Loaded with everything else so the playoffs tab can draw the whole bracket on
    // first render, rather than only the rounds that have been generated.
    playoffTemplate: await loadPlayoffTemplate(leagueId),
    userRole,
    isOwner: userRole === "owner",
    canEditMatchups:
      userRole === "owner" ||
      (userRole === "admin" && settings?.admins_edit_matchups === true),
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
 * Saves an owner-supplied regular season schedule (owner only).
 *
 * Replaces any existing schedule for the season, exactly as the random generator does, so
 * the two paths cannot leave the season in different shapes. Refused outright if the
 * pairings are not a valid schedule; see the database function for the rules.
 *
 * @param leagueId - The league whose schedule to save.
 * @param config - The schedule configuration to persist alongside the pairings.
 * @param matchups - The pairings, one per game.
 * @returns The number of regular season matches written.
 */
export async function saveManualSchedule(
  leagueId: string,
  config: Pick<
    ScheduleSettings,
    | "regular_season_weeks"
    | "match_format"
    | "playoff_team_count"
    | "playoff_match_format"
    | "playoff_format"
  >,
  matchups: ManualScheduleGame[],
): Promise<number> {
  const { data, error } = await supabase.rpc("save_manual_schedule", {
    p_league_id: leagueId,
    p_weeks: config.regular_season_weeks,
    p_match_format: config.match_format,
    p_playoff_team_count: config.playoff_team_count,
    p_playoff_match_format: config.playoff_match_format,
    p_playoff_format: config.playoff_format,
    p_matchups: matchups,
  });

  if (error) {
    throw new Error(error.message || "The schedule could not be saved.");
  }

  return Number(data ?? 0);
}

/** One game in an owner-supplied schedule. */
export type ManualScheduleGame = {
  week: number;
  player_1_team_id: string;
  player_2_team_id: string;
};

/**
 * Checks an owner-supplied schedule before it is saved.
 *
 * The database refuses a bad schedule anyway, but it can only say that one row is wrong.
 * Checking here lets the editor name every problem at once and, more usefully, lets it
 * say which teams are resting in a week rather than leaving the owner to work that out
 * from a list of pairings.
 *
 * @param games - The pairings as entered.
 * @param weeks - How many weeks the season runs.
 * @param teamIds - Every team eligible to be scheduled.
 * @returns The problems found, and the teams resting each week.
 */
export function inspectManualSchedule(
  games: ManualScheduleGame[],
  weeks: number,
  teamIds: string[],
): {
  problems: string[];
  restingByWeek: Map<number, string[]>;
  scheduledByWeek: Map<number, Set<string>>;
} {
  const problems: string[] = [];
  const scheduledByWeek = new Map<number, Set<string>>();

  for (const game of games) {
    if (game.week < 1 || game.week > weeks) {
      problems.push(`A matchup is in week ${game.week}, outside a ${weeks} week season.`);
      continue;
    }

    if (!game.player_1_team_id || !game.player_2_team_id) {
      problems.push(`Week ${game.week} has a matchup with a team missing.`);
      continue;
    }

    if (game.player_1_team_id === game.player_2_team_id) {
      problems.push(`Week ${game.week} pairs a team with itself.`);
      continue;
    }

    const week = scheduledByWeek.get(game.week) ?? new Set<string>();
    scheduledByWeek.set(game.week, week);

    for (const teamId of [game.player_1_team_id, game.player_2_team_id]) {
      if (week.has(teamId)) {
        problems.push(`Week ${game.week} schedules the same team twice.`);
      }
      week.add(teamId);
    }
  }

  // A team that is not in the week's set has the week off, which is allowed and worth
  // showing rather than hiding behind the absence of a row.
  const restingByWeek = new Map<number, string[]>();
  for (let week = 1; week <= weeks; week += 1) {
    const scheduled = scheduledByWeek.get(week) ?? new Set<string>();
    restingByWeek.set(
      week,
      teamIds.filter((teamId) => !scheduled.has(teamId)),
    );
  }

  return { problems: [...new Set(problems)], restingByWeek, scheduledByWeek };
}

/**
 * Advances the playoff bracket by one round (owner only). Each call creates the
 * next round whose participants are known, then stops until results come in.
 *
 * @param leagueId - The league whose playoff bracket to advance.
 * @returns The number of playoff matches created.
 */
/**
 * One game in the bracket, whether or not it has been created yet.
 *
 * The template comes from `playoff_bracket_template`, so the whole tournament is
 * described even when only the first round exists as real matches. `feeder_a` and
 * `feeder_b` are the text a slot shows while it is empty, such as `seed 1` or
 * `W(G5)`, and `team_a`/`team_b` carry a team id only when that side is a seed that
 * is already known.
 */
export type SchedulePlayoffTemplateRow = {
  game_label: string;
  phase: "upper" | "lower" | "gf" | "toilet";
  round_no: number;
  week: number;
  /**
   * Position within its round, matching the `bracket_slot` the generator stores.
   *
   * Nullable because a template written before this column existed has no value, and the
   * bracket falls back to pairing rows to games by their order in the round.
   */
  slot: number | null;
  feeder_a: string;
  feeder_b: string;
  team_a: string | null;
  team_b: string | null;
  is_grand_final: boolean;
  is_reset: boolean;
};

export type SchedulePlayoffTemplate = {
  /** Every game the bracket will contain, in bracket order. */
  rows: SchedulePlayoffTemplateRow[];
  /**
   * Why no template was produced, when the bracket is not defined for this league.
   * Null on success.
   */
  unavailableReason: string | null;
};

/**
 * Loads the full shape of the bracket for the schedule page.
 *
 * A league whose playoff field this bracket does not cover raises from the RPC. That
 * is reported as a reason rather than thrown, because a schedule page with no bracket
 * still has a schedule to show, and a league-wide exception would blank the page over
 * a missing playoff feature.
 *
 * @param leagueId - The league whose bracket should be described.
 * @returns The template rows, or the reason none could be produced.
 */
export async function loadPlayoffTemplate(
  leagueId: string,
): Promise<SchedulePlayoffTemplate> {
  /*
   * Both brackets in one call site. The consolation bracket's template is empty when the
   * setting is off, so merging costs nothing for a league that does not use it, and the
   * sheet draws the two from one list.
   */
  const [playoff, toilet] = await Promise.all([
    supabase.rpc("playoff_bracket_template", { p_league_id: leagueId }),
    supabase.rpc("toilet_bracket_template", { p_league_id: leagueId }),
  ]);

  if (playoff.error) {
    return { rows: [], unavailableReason: playoff.error.message };
  }

  // A failed consolation read is not worth failing the bracket over: the playoff sheet is
  // the page, and the extra section simply does not appear.
  const toiletRows = toilet.error
    ? []
    : ((toilet.data ?? []) as SchedulePlayoffTemplateRow[]);

  return {
    rows: [...((playoff.data ?? []) as SchedulePlayoffTemplateRow[]), ...toiletRows],
    unavailableReason: null,
  };
}

/**
 * The order a member reads a round's games in: the playoff brackets, then the consolation.
 *
 * The winners bracket, the losers bracket and the finals are all "the playoffs", so they
 * come before the Toilet Bowl. Their relative order is the order the brackets are drawn in
 * on the sheet.
 */
const PICKER_PHASE_ORDER: Record<string, number> = {
  upper: 0,
  lower: 1,
  gf: 2,
  toilet: 3,
};

/** The fields the matchup picker orders by. */
export type PickerOrderedMatch = {
  week_number: number;
  is_playoff: boolean;
  bracket_phase?: "upper" | "lower" | "gf" | "toilet" | null;
  bracket_slot?: number | null;
  playoff_round_no?: number | null;
};

/**
 * Orders the games for the Week / matchup picker.
 *
 * By the round the game belongs to, newest first, then the playoff brackets, then that
 * round's Toilet Bowl games, then slot.
 *
 * Round rather than week, because the labels count rounds: heading these games by their
 * week split a round across the list. One press writes the next winners round into one
 * week and the next losers round into another, so a week-ordered list read "Week 3, Week
 * 2, Week 3" -- a Playoffs (Week 2) block sitting between two Playoffs (Week 3) blocks.
 * Grouping by round keeps every game of a round together and the labels in sequence.
 *
 * Within a round the playoff brackets lead and the Toilet Bowl follows, so a consolation
 * game never sits inside the playoff matchups. Ordering the phase the other way -- toilet
 * second, before the losers leg -- put the Toilet Bowl in the middle of a round, which is
 * the same complaint one level down.
 *
 * Regular-season games have no round number, so they keep their week ordering below the
 * live bracket once the postseason has started.
 *
 * @param matches - The games to order.
 * @returns A new array in picker order.
 */
export function orderMatchesForPicker<T extends PickerOrderedMatch>(
  matches: T[],
): T[] {
  return [...matches].sort((a, b) => {
    // A live bracket above a finished regular season.
    if (a.is_playoff !== b.is_playoff) {
      return a.is_playoff ? -1 : 1;
    }

    if (!a.is_playoff) {
      return b.week_number - a.week_number;
    }

    const roundA = a.playoff_round_no ?? null;
    const roundB = b.playoff_round_no ?? null;

    if (roundA !== roundB) {
      // A game written before the column existed has no round; it goes last rather than
      // sorting as though it were round zero.
      if (roundA === null) return 1;
      if (roundB === null) return -1;
      return roundB - roundA;
    }

    const byPhase =
      (PICKER_PHASE_ORDER[a.bracket_phase ?? ""] ?? 9) -
      (PICKER_PHASE_ORDER[b.bracket_phase ?? ""] ?? 9);

    if (byPhase !== 0) {
      return byPhase;
    }

    return (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0);
  });
}

/**
 * Turns the consolation bracket on or off (owner only).
 *
 * @param leagueId - The league to change.
 * @param enabled - Whether the non-playoff teams should play their own bracket.
 * @returns The stored value.
 */
export async function setToiletBowl(
  leagueId: string,
  enabled: boolean,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("set_toilet_bowl", {
    p_league_id: leagueId,
    p_enabled: enabled,
  });

  if (error) {
    throw new Error(error.message || "The consolation bracket setting could not be saved.");
  }

  return Boolean(data);
}

/**
 * Advances the playoff bracket by one step.
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
 * Deletes the playoff bracket so it can be rebuilt from current standings.
 *
 * Destructive, and the caller is expected to confirm first: every playoff match and
 * its results go, along with the frozen seed list. Without this a bracket that has
 * already been played cannot be advanced again, because generate_playoff_round reads
 * the existing games as the current round.
 *
 * @param leagueId - The league whose bracket should be cleared.
 * @returns How many playoff matches were removed.
 * @throws If the RPC rejects the request.
 */
export async function resetPlayoffBracket(
  leagueId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("reset_playoff_bracket", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message || "The playoff bracket could not be reset.");
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
 * True when a match is a bye rather than a game two sides are meant to play.
 *
 * A bracket padded out for byes, and any game whose other side was knocked out by a
 * double forfeit, leaves a match with one team and no opponent. The advance settles those
 * as a win so the bracket can move on, which makes them real rows in `matches`, and they
 * are drawn on the bracket where the rest of the tournament is drawn.
 *
 * They are not matchups, though. There is nobody to play, so listing one in a matchup list
 * offers the member an opponent who does not exist and a result they did not earn.
 *
 * @param match - The match to classify.
 * @returns True when the match has only one side.
 */
export function isByeMatch(match: {
  player_2_team_id: string | null;
}): boolean {
  return match.player_2_team_id === null;
}

/** A match reduced to the fields that week labelling reads. */
export type WeekLabelledMatch = {
  week_number: number;
  is_playoff: boolean;
  /** Which bracket the match belongs to, so a consolation game is not called a playoff. */
  bracket_phase?: "upper" | "lower" | "gf" | "toilet" | null;
  /**
   * Which press of Advance Playoffs created this game, or null for a game written
   * before the column existed.
   */
  playoff_round_no?: number | null;
};

/**
 * The first playoff week of a season, which the postseason counts its weeks from.
 *
 * Playoff games carry the same `week_number` column as the regular season and simply
 * continue past it, so a twelve team bracket on a five week season runs weeks six to
 * seventeen. That numbering is an internal id rather than something to show a member:
 * nobody thinks of the first round of the bracket as "week 6" when the league was five
 * weeks long.
 *
 * Taken from the season's whole match list rather than from whichever subset a panel
 * happens to be showing, so the numbering does not shift as rounds are played. The first
 * round is over and dropped from the proposal log long before the final is proposed, and
 * numbering from what was left would relabel the final as week 1.
 *
 * @param matches - Every match in the season.
 * @returns The earliest playoff week, or null when the postseason has not started.
 */
export function firstPlayoffWeekOf(
  matches: WeekLabelledMatch[],
): number | null {
  let earliest: number | null = null;

  for (const match of matches) {
    if (!match.is_playoff) continue;
    if (earliest === null || match.week_number < earliest) {
      earliest = match.week_number;
    }
  }

  return earliest;
}

/**
 * Labels the week a match belongs to, as a member would count it.
 *
 * A regular-season week is its own number.
 *
 * A playoff game is counted by the press of Advance Playoffs that created it, not by its
 * stored week and not by its round within a bracket. One press writes several rounds at
 * once -- after the opening round it creates the next winners round and the first losers
 * round together -- so counting by week would split one set of new matchups across two
 * labels, and counting by bracket round is not comparable between the winners and losers
 * brackets, which run their rounds in parallel. A member sees one set of matchups appear
 * and it should read as one round.
 *
 * Falls back to counting from the first playoff week for a game written before the press
 * was recorded, and to a bare "Playoffs" when there is no first week to count from.
 *
 * @param match - The match being labelled.
 * @param firstPlayoffWeek - The season's first playoff week, or null if none has started.
 * @returns A label such as "Week 3" or "Playoffs (Week 2)".
 */
export function matchWeekLabel(
  match: WeekLabelledMatch,
  firstPlayoffWeek: number | null,
): string {
  if (!match.is_playoff) {
    return `Week ${match.week_number}`;
  }

  /*
   * The consolation bracket is also a playoff match -- it is built by the same advance,
   * carries is_playoff and lives in the same table -- so testing only that flag called a
   * Toilet Bowl game a playoff. The phase is what separates them.
   */
  const isToilet = match.bracket_phase === "toilet";
  const bracket = isToilet ? "Toilet Bowl" : "Playoffs";

  if (!isToilet && match.playoff_round_no != null) {
    return `${bracket} (Week ${match.playoff_round_no})`;
  }

  if (firstPlayoffWeek === null) {
    return bracket;
  }

  return `${bracket} (Week ${match.week_number - firstPlayoffWeek + 1})`;
}

/**
 * Labels the week a proposal belongs to.
 *
 * @param group - The week group being labelled.
 * @param firstPlayoffWeek - The season's first playoff week, or null if none has started.
 * @returns A label such as "Week 3" or "Playoffs (Week 2)".
 */
export function proposalWeekLabel(
  group: WeekLabelledMatch,
  firstPlayoffWeek: number | null,
): string {
  return matchWeekLabel(group, firstPlayoffWeek);
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
