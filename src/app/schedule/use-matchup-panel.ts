/*
 * State and actions behind the schedule page's Matchup tab.
 *
 * Owns the matchup selection, the scheduling/reporting/editing forms, the
 * opponent availability lookup, winner predictions and forfeits, and the derived
 * lists the tab renders. The page supplies the loaded payload, the mutation
 * wrapper, and the toast/error setters, so every write still refreshes the page
 * through the same path the other tabs use.
 */
"use client";

import { type ChangeEvent, useCallback, useMemo, useRef, useState } from "react";
import { type UseConfirmResult } from "@/components/confirm-dialog";
import {
  datePartOfInputValue,
  fromZonedInputValue,
  toZonedInputValue,
  toZonedParts,
  todayInZone,
  withInputValueDate,
} from "@/lib/datetime";
import { predictionLockReason, type PredictionLockReason } from "@/lib/predictions";
import { readReplaySummary } from "@/lib/replay-summary";
import {
  availabilityFit,
  dayOfWeekFromDate,
  loadMemberAvailability,
  minutesFromInputValue,
  projectAvailabilityWeek,
  type AvailabilityWindow,
  type MemberAvailability,
} from "@/lib/supabase/availability";
import * as scheduleApi from "@/lib/supabase/schedule";

import { buildGameRows, type GameRow } from "./matchup-cards";

/**
 * Progress of the "Read replay" lookup for the report form: idle before it is
 * requested, then either the read outcome or an error to show under the field.
 */
export type ReplayReadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; note: string | null; winnerResolved: boolean };

/** A week option offered by the Upcoming matches and Match history selectors. */
export type MatchupWeekOption = {
  key: string;
  label: string;
  order: number;
};

/**
 * Inputs the page provides to {@link useMatchupPanel}.
 *
 * `goods` may be null while the league is still loading; every derivation falls
 * back to an empty state until it arrives.
 */
export interface MatchupPanelOptions {
  goods: scheduleApi.SchedulePageGoods | null;
  /** The league's current week, from the deadline pointer or the matches. */
  currentWeek: number | null;
  /** The season's first playoff week, for round labels. */
  firstPlayoffWeek: number | null;
  /** The reader's zone, used for every time input and display. */
  timeZone: string;
  confirm: UseConfirmResult["confirm"];
  /** Runs a write, refreshes the page, and reports whether it succeeded. */
  canRunMutation: (
    mutation: () => Promise<unknown>,
    leagueId: string,
  ) => Promise<boolean>;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  /** Applies any real-time change that was held while a form was open. */
  onFormClosed: () => void;
}

/** Everything the Matchup tab needs, returned by {@link useMatchupPanel}. */
export interface MatchupPanel {
  selectedMatchId: string | null;
  selectedMatch: scheduleApi.ScheduleMatch | null;
  selectMatch: (matchId: string | null) => void;
  myMatch: boolean;
  canAct: boolean;
  canOwnerActs: boolean;
  matchPickerOptions: { id: string; label: string; matchup: string }[];
  firstPlayoffWeek: number | null;
  teamRecord: (teamId: string | null | undefined) => string | null;
  matchFormat: "single" | "best_of_3" | null;
  formatFor: (match: scheduleApi.ScheduleMatch) => "single" | "best_of_3" | null;
  gameRows: GameRow[];
  playerOneRecord: string | null;
  playerTwoRecord: string | null;
  hideSpoilers: boolean;
  setHideSpoilers: (hidden: boolean) => void;
  predictionLock: PredictionLockReason | null;
  predictionPickName: string | null;
  handlePredict: (matchId: string, teamId: string) => Promise<void>;
  schedulingMatchId: string | null;
  scheduleTime: string;
  setScheduleTime: (value: string) => void;
  scheduleNotes: string;
  setScheduleNotes: (value: string) => void;
  scheduleDateRef: React.RefObject<HTMLInputElement | null>;
  isDatePickerOpen: boolean;
  handleOpenDatePicker: () => void;
  handleScheduleDateChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleScheduleDateBlur: () => void;
  openScheduling: () => Promise<void>;
  handleProposeTime: () => Promise<void>;
  closeScheduling: () => void;
  opponent: { userId: string | null; name: string; color: string | null } | null;
  opponentAvailability: MemberAvailability | null;
  opponentWindows: AvailabilityWindow[];
  isLoadingAvailability: boolean;
  availabilityError: boolean;
  scheduleFit: "inside" | "outside" | "unavailable" | null;
  today: number | null;
  pendingProposal: scheduleApi.ScheduleMatch["pending_proposal"];
  proposalIsMine: boolean;
  proposalAuthor: { name: string; color: string | null };
  handleRespondToProposal: (matchId: string, accept: boolean) => Promise<void>;
  handleCancelProposal: (matchId: string) => Promise<void>;
  reportingMatchId: string | null;
  reportGame: string;
  setReportGame: (value: string) => void;
  reportWinner: string;
  setReportWinner: (value: string) => void;
  reportUrl: string;
  setReportUrl: (value: string) => void;
  reportAlive: string;
  setReportAlive: (value: string) => void;
  replayRead: ReplayReadState;
  setReplayRead: (state: ReplayReadState) => void;
  reportDifferential: number | null;
  openReporting: () => void;
  handleReadReplay: () => Promise<void>;
  handleSubmitResult: () => Promise<void>;
  closeReporting: () => void;
  editingResultId: string | null;
  editWinner: string;
  setEditWinner: (value: string) => void;
  editUrl: string;
  setEditUrl: (value: string) => void;
  editAlive: string;
  setEditAlive: (value: string) => void;
  openEditResult: (result: scheduleApi.ScheduleMatchResult) => void;
  handleSaveEditResult: (result: scheduleApi.ScheduleMatchResult) => Promise<void>;
  closeEditing: () => void;
  handleForfeit: () => Promise<void>;
  handleOwnerForfeit: (side: "player_1" | "player_2" | "both") => Promise<void>;
  handleRevertForfeit: () => Promise<void>;
  upcomingWeekOptions: MatchupWeekOption[];
  defaultUpcomingWeekKey: string | null;
  activeUpcomingWeekKey: string | null;
  setUpcomingWeekKey: (key: string) => void;
  historyWeekOptions: MatchupWeekOption[];
  activeHistoryWeekKey: string | null;
  setHistoryWeekKey: (key: string) => void;
  upcomingMatches: scheduleApi.ScheduleMatch[];
  visibleUpcomingMatches: scheduleApi.ScheduleMatch[];
  completedMatches: scheduleApi.ScheduleMatch[];
  visibleCompletedMatches: scheduleApi.ScheduleMatch[];
  /** True while a form is open, so real-time refreshes can be held back. */
  formOpen: boolean;
}

/**
 * Groups a match into its Upcoming matches week: one key per week, regular or
 * playoff.
 *
 * The postseason is keyed by week like any other rather than collapsed into one
 * entry, so a bracket spanning several rounds still offers one option per round.
 *
 * @param match - The match to classify.
 * @returns A stable key such as "week-3" or "playoffs-7".
 */
function upcomingWeekKeyOf(match: scheduleApi.ScheduleMatch): string {
  return match.is_playoff
    ? `playoffs-${match.week_number}`
    : `week-${match.week_number}`;
}

/** Whether a match still needs a result. */
function isOpenMatch(match: scheduleApi.ScheduleMatch): boolean {
  return (
    match.status !== "completed" &&
    match.status !== "forfeit" &&
    match.status !== "cancelled"
  );
}

/**
 * The matchup the page opens on: the viewer's match in the first week that still
 * has an open match, falling back to the first match of the season.
 *
 * @param goods - The loaded page payload.
 * @returns The match id to show when the member has not picked one.
 */
function preferredMatchId(goods: scheduleApi.SchedulePageGoods): string | null {
  const regular = goods.matches.filter((match) => !match.is_playoff);
  const weeks = [...new Set(regular.map((match) => match.week_number))].sort(
    (a, b) => a - b,
  );
  const openWeek = weeks.find((week) =>
    regular.some(
      (match) => match.week_number === week && isOpenMatch(match),
    ),
  );
  const pool =
    openWeek != null
      ? regular.filter((match) => match.week_number === openWeek)
      : goods.matches;
  const mine = pool.find(
    (match) =>
      match.player_1_team_id === goods.myTeamId ||
      match.player_2_team_id === goods.myTeamId,
  );
  return (mine ?? pool[0])?.id ?? null;
}

/**
 * Collects the Matchup tab's state, derived values, and actions.
 *
 * @param options - {@link MatchupPanelOptions}
 * @returns The {@link MatchupPanel} the tab renders from.
 */
export function useMatchupPanel({
  goods,
  currentWeek,
  firstPlayoffWeek,
  timeZone,
  confirm,
  canRunMutation,
  setError,
  setNotice,
  onFormClosed,
}: MatchupPanelOptions): MatchupPanel {
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [upcomingWeekKey, setUpcomingWeekKey] = useState<string | null>(null);
  const [historyWeekKey, setHistoryWeekKey] = useState<string | null>(null);
  const [schedulingMatchId, setSchedulingMatchId] = useState<string | null>(
    null,
  );
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleNotes, setScheduleNotes] = useState("");
  const scheduleDateRef = useRef<HTMLInputElement>(null);
  const datePickerOpenRef = useRef(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [opponentAvailability, setOpponentAvailability] =
    useState<MemberAvailability | null>(null);
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(false);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [reportingMatchId, setReportingMatchId] = useState<string | null>(null);
  const [reportGame, setReportGame] = useState("1");
  const [reportWinner, setReportWinner] = useState("");
  const [reportUrl, setReportUrl] = useState("");
  const [reportAlive, setReportAlive] = useState("");
  const [replayRead, setReplayRead] = useState<ReplayReadState>({
    status: "idle",
  });
  const [hideSpoilers, setHideSpoilers] = useState(true);
  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [editWinner, setEditWinner] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editAlive, setEditAlive] = useState("");

  const selectedMatch = useMemo(() => {
    if (!goods) {
      return null;
    }

    const picked = goods.matches.find((match) => match.id === selectedMatchId);

    if (picked) {
      return picked;
    }

    const preferred = preferredMatchId(goods);

    return goods.matches.find((match) => match.id === preferred) ?? null;
  }, [goods, selectedMatchId]);

  const myMatch = useMemo(
    () =>
      goods && selectedMatch
        ? selectedMatch.player_1_team_id === goods.myTeamId ||
          selectedMatch.player_2_team_id === goods.myTeamId
        : false,
    [goods, selectedMatch],
  );

  /*
   * Whether the selected matchup still accepts a winner pick. The database
   * enforces the same rule on write; this copy drives the card's buttons and the
   * explanation shown when they are closed.
   */
  const predictionLock = useMemo(
    () => (selectedMatch ? predictionLockReason(selectedMatch) : null),
    [selectedMatch],
  );

  const predictionSides = useMemo(() => {
    if (!selectedMatch) {
      return [];
    }

    return [
      {
        teamId: selectedMatch.player_1_team_id,
        name: selectedMatch.player_1_name,
      },
      ...(selectedMatch.player_2_team_id
        ? [
            {
              teamId: selectedMatch.player_2_team_id,
              name: selectedMatch.player_2_name,
            },
          ]
        : []),
    ];
  }, [selectedMatch]);

  const predictionPickName = useMemo(
    () =>
      predictionSides.find(
        (side) => side.teamId === selectedMatch?.my_prediction_team_id,
      )?.name ?? null,
    [predictionSides, selectedMatch?.my_prediction_team_id],
  );

  const canAct = useMemo(
    () =>
      Boolean(
        goods &&
        goods.isCurrentSeason &&
        selectedMatch &&
        myMatch &&
        selectedMatch.status !== "completed" &&
        selectedMatch.status !== "forfeit" &&
        selectedMatch.status !== "cancelled",
      ),
    [goods, selectedMatch, myMatch],
  );

  /*
   * The league owner's actions on any open match, including one between two other
   * teams: file a result (Add Replay, for matches they do not play) and forfeit
   * either player or both. Scheduling stays with the participants (canAct).
   */
  const canOwnerActs = useMemo(
    () =>
      Boolean(
        goods?.canEditMatchups &&
        goods?.isCurrentSeason &&
        selectedMatch &&
        selectedMatch.status !== "completed" &&
        selectedMatch.status !== "forfeit" &&
        selectedMatch.status !== "cancelled",
      ),
    [goods?.canEditMatchups, goods?.isCurrentSeason, selectedMatch],
  );

  /**
   * A team's season record as "W-L", resolved against the standings already on
   * the page so each matchup card can show it beside the player's name.
   *
   * @param teamId - The team whose record is wanted.
   * @returns The record, or null when the standings do not include the team.
   */
  const teamRecord = useCallback(
    (teamId: string | null | undefined) => {
      if (!teamId) {
        return null;
      }

      const standing = goods?.standings.find((row) => row.team_id === teamId);
      return standing ? `${standing.wins}-${standing.losses}` : null;
    },
    [goods?.standings],
  );

  /**
   * The member on the other side of the selected matchup, or null when the
   * viewer is not a participant and therefore has no opponent to schedule with.
   *
   * Carries the opponent's stored name colour alongside their name so the places
   * that name them render it in the colour they picked.
   */
  const opponent = useMemo(() => {
    if (!goods || !selectedMatch || !myMatch) {
      return null;
    }

    const isPlayerOne = selectedMatch.player_1_team_id === goods.myTeamId;

    return {
      userId: isPlayerOne
        ? selectedMatch.player_2_user_id
        : selectedMatch.player_1_user_id,
      name: isPlayerOne
        ? selectedMatch.player_2_name
        : selectedMatch.player_1_name,
      color: isPlayerOne
        ? selectedMatch.player_2_name_color
        : selectedMatch.player_1_name_color,
    };
  }, [goods, selectedMatch, myMatch]);

  const pendingProposal = selectedMatch?.pending_proposal ?? null;

  const proposalIsMine = Boolean(
    pendingProposal && pendingProposal.proposed_by === goods?.currentUserId,
  );

  /**
   * Who to name as the proposer, whichever side of the matchup they are on, with
   * the colour they picked when the name is theirs.
   *
   * "You" and "Your opponent" are addressed in the second person rather than by
   * name, so they carry no colour.
   */
  const proposalAuthor = useMemo<{ name: string; color: string | null }>(() => {
    if (!pendingProposal) {
      return { name: "Your opponent", color: null };
    }

    if (proposalIsMine) {
      return { name: "You", color: null };
    }

    if (pendingProposal.proposed_by === selectedMatch?.player_1_user_id) {
      return {
        name: selectedMatch?.player_1_name ?? "Your opponent",
        color: selectedMatch?.player_1_name_color ?? null,
      };
    }

    return {
      name: opponent?.name ?? "Your opponent",
      color: opponent?.color ?? null,
    };
  }, [pendingProposal, proposalIsMine, selectedMatch, opponent]);

  /*
   * The opponent's week projected into the reader's zone. The week sampled is
   * the calendar week the reader is currently in, because a recurring window has
   * no league-week date of its own and the offset between two zones is what
   * actually moves a window between weekdays.
   */
  const opponentWindows = useMemo<AvailabilityWindow[]>(() => {
    if (!opponentAvailability?.week) {
      return [];
    }

    const anchorDate = toZonedParts(new Date(), timeZone)?.date ?? "";

    if (!anchorDate) {
      return [];
    }

    return projectAvailabilityWeek(
      opponentAvailability.week,
      opponentAvailability.timeZone,
      timeZone,
      anchorDate,
    );
  }, [opponentAvailability, timeZone]);

  const today = useMemo(
    () => dayOfWeekFromDate(toZonedParts(new Date(), timeZone)?.date ?? ""),
    [timeZone],
  );

  /**
   * Whether the time currently typed into the scheduling form lands inside the
   * opponent's stated availability. Null while no time is chosen, or when the
   * opponent has not declared a week to check against.
   */
  const scheduleFit = useMemo(() => {
    if (!opponent || !opponentAvailability?.week) {
      return null;
    }

    const day = dayOfWeekFromDate(datePartOfInputValue(scheduleTime));
    const minutes = minutesFromInputValue(scheduleTime);

    if (day == null || minutes == null) {
      return null;
    }

    return availabilityFit(opponentWindows, day, minutes);
  }, [scheduleTime, opponent, opponentAvailability, opponentWindows]);

  /*
   * The signed contribution this game will make to the signed-in user's
   * differential, mirroring season_standings: the winning team adds the
   * survivor count and the losing team subtracts it. Shown read-only so the
   * sign is visible without anyone typing a negative count by hand.
   */
  const reportDifferential = useMemo(() => {
    if (!selectedMatch || !reportWinner || !reportAlive.trim()) {
      return null;
    }
    // Only meaningful for a participant; owners viewing a match are neither side.
    if (
      goods?.myTeamId !== selectedMatch.player_1_team_id &&
      goods?.myTeamId !== selectedMatch.player_2_team_id
    ) {
      return null;
    }
    const count = Number(reportAlive);
    if (!Number.isInteger(count) || count < 0 || count > 6) {
      return null;
    }
    return reportWinner === goods.myTeamId ? count : -count;
  }, [selectedMatch, reportWinner, reportAlive, goods]);

  const playerOneRecord = selectedMatch
    ? scheduleApi.gameRecord(selectedMatch, selectedMatch.player_1_team_id)
    : null;
  const playerTwoRecord = selectedMatch
    ? selectedMatch.player_2_team_id
      ? scheduleApi.gameRecord(selectedMatch, selectedMatch.player_2_team_id)
      : null
    : null;

  const matchFormat = useMemo(() => {
    if (!goods?.settings || !selectedMatch) {
      return null;
    }
    return selectedMatch.is_playoff
      ? goods.settings.playoff_match_format
      : goods.settings.match_format;
  }, [goods, selectedMatch]);

  /*
   * Games to list for the card: the real results, plus a mirrored third game
   * when a best-of-3 was decided in two. Shared with the match history card so
   * both render a sweep the same way.
   */
  const gameRows = useMemo<GameRow[]>(
    () => (selectedMatch ? buildGameRows(selectedMatch, matchFormat) : []),
    [selectedMatch, matchFormat],
  );

  const formatFor = useCallback(
    (match: scheduleApi.ScheduleMatch) =>
      match.is_playoff
        ? (goods?.settings?.playoff_match_format ?? null)
        : (goods?.settings?.match_format ?? null),
    [goods?.settings],
  );

  const completedMatches = useMemo(
    () =>
      (goods?.matches ?? []).filter(
        (match) =>
          (match.status === "completed" || match.status === "forfeit") &&
          // A bye is settled as a win so the bracket can move on, but it has no opponent
          // and is not a result anyone played. It stays on the bracket, which draws from
          // the season's whole match list, and out of the matchup lists here.
          !scheduleApi.isByeMatch(match),
      ),
    [goods?.matches],
  );

  const upcomingMatches = useMemo(() => {
    if (!goods) {
      return [];
    }
    const open = goods.matches.filter(
      (match) => isOpenMatch(match) && !scheduleApi.isByeMatch(match),
    );
    return [...open].sort((a, b) => {
      const aMine =
        a.player_1_team_id === goods.myTeamId ||
        a.player_2_team_id === goods.myTeamId;
      const bMine =
        b.player_1_team_id === goods.myTeamId ||
        b.player_2_team_id === goods.myTeamId;
      if (aMine !== bMine) {
        return aMine ? -1 : 1;
      }
      const aTime = a.scheduled_at
        ? new Date(a.scheduled_at).getTime()
        : Number.MAX_SAFE_INTEGER;
      const bTime = b.scheduled_at
        ? new Date(b.scheduled_at).getTime()
        : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  }, [goods]);

  /*
   * The games offered by the Week / matchup picker, latest round first.
   *
   * The picker lists every game in the season rather than one week at a time, so
   * the order is sorted here: weeks run latest to earliest because the game being
   * looked for is almost always in the current or most recent round, and a
   * playoff round sorts after every regular one.
   */
  const matchPickerMatches = useMemo(
    () =>
      scheduleApi.orderMatchesForPicker(
        (goods?.matches ?? []).filter((match) => !scheduleApi.isByeMatch(match)),
      ),
    [goods?.matches],
  );

  const matchPickerOptions = useMemo(
    () =>
      matchPickerMatches.map((match) => ({
        id: match.id,
        label: scheduleApi.matchWeekLabel(match, firstPlayoffWeek),
        matchup: `${match.player_1_name} vs ${match.player_2_name}`,
      })),
    [matchPickerMatches, firstPlayoffWeek],
  );

  /*
   * The week selector on the Upcoming matches panel. Options are only the weeks
   * that still have an open match, latest first, so the round a member has to
   * play next is the default rather than something at the bottom.
   */
  const upcomingWeekOptions = useMemo(() => {
    const options = new Map<string, MatchupWeekOption>();
    for (const match of upcomingMatches) {
      const key = upcomingWeekKeyOf(match);
      if (!options.has(key)) {
        options.set(key, {
          key,
          label: scheduleApi.matchWeekLabel(match, firstPlayoffWeek),
          // Playoff rounds continue past every regular one, so the latest round is the
          // highest number in either sequence.
          order: match.week_number,
        });
      }
    }
    return [...options.values()].sort((a, b) => b.order - a.order);
  }, [upcomingMatches, firstPlayoffWeek]);

  // The current week is the default; falls back to the first week with open matches.
  const defaultUpcomingWeekKey = useMemo(() => {
    const current = currentWeek != null ? `week-${currentWeek}` : null;
    if (
      current &&
      upcomingWeekOptions.some((option) => option.key === current)
    ) {
      return current;
    }
    return upcomingWeekOptions[0]?.key ?? null;
  }, [currentWeek, upcomingWeekOptions]);

  // A user's pick wins only while that week is still among the options.
  const activeUpcomingWeekKey =
    upcomingWeekKey != null &&
    upcomingWeekOptions.some((option) => option.key === upcomingWeekKey)
      ? upcomingWeekKey
      : defaultUpcomingWeekKey;

  const visibleUpcomingMatches = useMemo(
    () =>
      activeUpcomingWeekKey == null
        ? []
        : upcomingMatches.filter(
            (match) => upcomingWeekKeyOf(match) === activeUpcomingWeekKey,
          ),
    [upcomingMatches, activeUpcomingWeekKey],
  );

  /*
   * The week selector on the Match history card. Options are only the weeks with
   * a closed match, most recent first, so the default is the round a reader
   * asking "what happened last" is looking for.
   */
  const historyWeekOptions = useMemo(() => {
    const options = new Map<string, MatchupWeekOption>();
    for (const match of completedMatches) {
      const key = upcomingWeekKeyOf(match);
      if (!options.has(key)) {
        options.set(key, {
          key,
          label: scheduleApi.matchWeekLabel(match, firstPlayoffWeek),
          order: match.week_number,
        });
      }
    }
    return [...options.values()].sort((a, b) => b.order - a.order);
  }, [completedMatches, firstPlayoffWeek]);

  const defaultHistoryWeekKey = historyWeekOptions[0]?.key ?? null;

  // A user's pick wins only while that week still has a completed match.
  const activeHistoryWeekKey =
    historyWeekKey != null &&
    historyWeekOptions.some((option) => option.key === historyWeekKey)
      ? historyWeekKey
      : defaultHistoryWeekKey;

  const visibleCompletedMatches = useMemo(
    () =>
      activeHistoryWeekKey == null
        ? []
        : completedMatches.filter(
            (match) => upcomingWeekKeyOf(match) === activeHistoryWeekKey,
          ),
    [completedMatches, activeHistoryWeekKey],
  );

  /*
   * True while the member is part-way through one of the tab's forms. A refresh
   * replaces the matches, which re-derives the selected matchup, so refetching
   * underneath an open form could move them off the matchup they are filling in
   * and lose what they typed.
   */
  const formOpen =
    (schedulingMatchId != null && schedulingMatchId === selectedMatch?.id) ||
    (reportingMatchId != null && reportingMatchId === selectedMatch?.id) ||
    editingResultId != null;

  /** Picks a matchup and closes any form the previous one had open. */
  const selectMatch = useCallback((matchId: string | null) => {
    setSelectedMatchId(matchId);
    setSchedulingMatchId(null);
    setReportingMatchId(null);
    setEditingResultId(null);
  }, []);

  const closeScheduling = useCallback(() => {
    setSchedulingMatchId(null);
    setOpponentAvailability(null);
    setAvailabilityError(false);
    // A change held while the form was open is applied now that the member is
    // done editing.
    onFormClosed();
  }, [onFormClosed]);

  const closeReporting = useCallback(() => {
    setReportingMatchId(null);
    onFormClosed();
  }, [onFormClosed]);

  const closeEditing = useCallback(() => {
    setEditingResultId(null);
    onFormClosed();
  }, [onFormClosed]);

  /**
   * Toggles the native date picker.
   *
   * `showPicker()` can open the calendar but there is no matching call to close
   * it, so closing is done by blurring the input, which is what dismisses the
   * browser's popup. The button's `mousedown` is prevented so that pressing it
   * does not blur the input first, which would clear the open flag before this
   * runs and make the button reopen the calendar it had just closed.
   *
   * `showPicker()` also throws rather than degrading when the browser has not
   * implemented it, when the input is not pickable, or when it is called outside
   * a user gesture. Focusing and clicking the input is the fallback that still
   * reaches the browser's own picker.
   */
  function handleOpenDatePicker() {
    const input = scheduleDateRef.current;

    if (!input) {
      return;
    }

    if (datePickerOpenRef.current) {
      datePickerOpenRef.current = false;
      setIsDatePickerOpen(false);
      input.blur();
      return;
    }

    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        datePickerOpenRef.current = true;
        setIsDatePickerOpen(true);
        return;
      } catch {
        // Not implemented or not permitted here; use the fallback below.
      }
    }

    input.focus();
    input.click();
  }

  /** Applies a date chosen from the calendar, keeping any time already set. */
  function handleScheduleDateChange(event: ChangeEvent<HTMLInputElement>) {
    // The browser dismisses the calendar itself once a day is chosen, so the
    // open state has to be cleared here or the next button press would try to
    // close a popup that is already gone.
    datePickerOpenRef.current = false;
    setIsDatePickerOpen(false);
    setScheduleTime(withInputValueDate(scheduleTime, event.target.value));
  }

  /** Marks the calendar closed when focus leaves the field for any other reason. */
  function handleScheduleDateBlur() {
    datePickerOpenRef.current = false;
    setIsDatePickerOpen(false);
  }

  /**
   * Opens the scheduling form for the selected matchup and pulls in the
   * opponent's availability so the chosen time can be checked against it.
   *
   * When the viewer already has a pending proposal the form opens on that time,
   * because sending a new proposal withdraws the old one. Otherwise the date
   * defaults to today in the reader's zone and the time is left blank: today is
   * almost always right, whereas guessing an hour would quietly bias every
   * proposal toward the same time of day.
   *
   * The availability read is best effort: a failure leaves the form usable, it
   * just cannot advise on the proposed time.
   */
  async function openScheduling() {
    if (!selectedMatch) {
      return;
    }

    const staged =
      selectedMatch.pending_proposal?.proposed_at ?? selectedMatch.scheduled_at;

    setSchedulingMatchId(selectedMatch.id);
    // A picker left open from a previous form would make the first press on the
    // button try to close a calendar that is not there.
    datePickerOpenRef.current = false;
    setIsDatePickerOpen(false);
    setScheduleTime(
      staged ? toZonedInputValue(staged, timeZone) : todayInZone(timeZone),
    );
    setScheduleNotes(
      selectedMatch.pending_proposal?.notes ?? selectedMatch.notes ?? "",
    );
    setOpponentAvailability(null);
    setAvailabilityError(false);

    if (!opponent?.userId) {
      return;
    }

    setIsLoadingAvailability(true);

    try {
      const availability = await loadMemberAvailability([opponent.userId]);
      setOpponentAvailability(availability[opponent.userId] ?? null);
    } catch {
      setOpponentAvailability(null);
      setAvailabilityError(true);
    } finally {
      setIsLoadingAvailability(false);
    }
  }

  /** Sends the form's time to the opponent as a proposal to accept or decline. */
  async function handleProposeTime() {
    if (!goods || !selectedMatch) {
      return;
    }

    const proposedAt = fromZonedInputValue(scheduleTime, timeZone);

    if (!proposedAt) {
      setError("Choose a valid date and time to propose.");
      return;
    }

    await canRunMutation(
      () =>
        scheduleApi.proposeMatchTime(
          selectedMatch.id,
          proposedAt,
          scheduleNotes,
        ),
      goods.league.id,
    );
    setSchedulingMatchId(null);
    setOpponentAvailability(null);
    setAvailabilityError(false);
    setNotice("Time proposed. Your opponent has to accept it.");
  }

  /** Accepts or declines the time the opponent proposed. */
  async function handleRespondToProposal(matchId: string, accept: boolean) {
    if (!goods) {
      return;
    }

    const responded = await confirm({
      title: accept ? "Accept this match time?" : "Decline this match time?",
      detail: accept
        ? "The match is scheduled and both of you will see the agreed time"
        : "The matchup goes back to needing a time, and the other player is told",
      confirmLabel: accept ? "Accept time" : "Decline",
      tone: accept ? "default" : "danger",
    });

    if (!responded) {
      return;
    }

    await canRunMutation(
      () => scheduleApi.respondToMatchProposal(matchId, accept),
      goods.league.id,
    );
    setNotice(
      accept ? "Match time agreed. The match is scheduled." : "Time declined.",
    );
  }

  /** Withdraws the viewer's own pending proposal. */
  async function handleCancelProposal(matchId: string) {
    if (!goods) {
      return;
    }

    const withdrew = await confirm({
      title: "Withdraw your proposed time?",
      detail:
        "The proposal is removed and the matchup goes back to needing a time",
      confirmLabel: "Withdraw",
      tone: "danger",
    });

    if (!withdrew) {
      return;
    }

    await canRunMutation(
      () => scheduleApi.cancelMatchProposal(matchId),
      goods.league.id,
    );
    setNotice("Proposal withdrawn.");
  }

  function openReporting() {
    if (!selectedMatch || !matchFormat) {
      return;
    }
    setReportingMatchId(selectedMatch.id);
    const taken = new Set(
      selectedMatch.results.map((result) => result.game_number),
    );
    let firstMissing = 1;
    while (taken.has(firstMissing) && firstMissing <= 3) {
      firstMissing += 1;
    }
    setReportGame(String(firstMissing));
    setReportWinner("");
    setReportUrl("");
    setReportAlive("");
    setReplayRead({ status: "idle" });
  }

  /**
   * Reads the pasted replay link and fills in the winner and survivor count.
   *
   * The count is written unsigned and the winner carries the sign, matching what
   * `season_standings` expects; a negative value here would flip both teams'
   * differentials.
   */
  async function handleReadReplay() {
    if (!selectedMatch || !reportUrl.trim()) {
      return;
    }
    setReplayRead({ status: "loading" });
    try {
      const summary = await readReplaySummary(
        reportUrl.trim(),
        selectedMatch.id,
      );
      if (summary.winnerTeamId) {
        setReportWinner(summary.winnerTeamId);
      }
      if (summary.pokemonLeftAlive != null) {
        setReportAlive(String(summary.pokemonLeftAlive));
      }
      setReplayRead({
        status: "done",
        note: summary.note,
        winnerResolved: Boolean(summary.winnerTeamId),
      });
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "That replay could not be read.",
      );
      setReplayRead({ status: "idle" });
    }
  }

  async function handleSubmitResult() {
    if (!goods || !selectedMatch || !reportWinner) {
      return;
    }
    const alive = reportAlive.trim() ? Number(reportAlive) : null;
    await canRunMutation(
      () =>
        scheduleApi.submitGameResult(
          selectedMatch.id,
          Number(reportGame),
          reportWinner,
          reportUrl.trim(),
          alive,
        ),
      goods.league.id,
    );
    setReportingMatchId(null);
    setNotice("Result submitted.");
  }

  /**
   * Saves the member's winner pick for a matchup.
   *
   * The full refresh after the write re-reads both the match's pick and the
   * standings, so the card and the PP column agree without a second code path.
   *
   * @param matchId - The matchup being predicted.
   * @param teamId - The team the member picked to win.
   */
  async function handlePredict(matchId: string, teamId: string) {
    if (!goods) {
      return;
    }

    const saved = await canRunMutation(
      () => scheduleApi.setMatchPrediction(matchId, teamId),
      goods.league.id,
    );

    if (saved) {
      setNotice("Prediction saved.");
    }
  }

  function openEditResult(result: scheduleApi.ScheduleMatchResult) {
    setEditingResultId(result.id);
    setEditWinner(result.winner_team_id);
    setEditUrl(result.replay_url ?? "");
    setEditAlive(
      result.pokemon_left_alive != null
        ? String(result.pokemon_left_alive)
        : "",
    );
  }

  async function handleSaveEditResult(
    result: scheduleApi.ScheduleMatchResult,
  ) {
    if (!goods) {
      return;
    }
    const alive = editAlive.trim() ? Number(editAlive) : null;
    await canRunMutation(
      () =>
        scheduleApi.updateGameResult(
          result.id,
          editWinner,
          editUrl.trim(),
          alive,
        ),
      goods.league.id,
    );
    setEditingResultId(null);
    setNotice("Result updated.");
  }

  async function handleForfeit() {
    if (!goods || !selectedMatch) {
      return;
    }
    const forfeitedTo =
      selectedMatch.player_1_team_id === goods.myTeamId
        ? selectedMatch.player_2_name
        : selectedMatch.player_1_name;

    const forfeiting = await confirm({
      title: "Forfeit this match?",
      detail: `${forfeitedTo} takes the win and the loss is recorded against your KO differential`,
      confirmLabel: "Forfeit",
      tone: "danger",
    });

    if (!forfeiting) {
      return;
    }
    await canRunMutation(
      () => scheduleApi.forfeitMatch(selectedMatch.id),
      goods.league.id,
    );
    setNotice("Match forfeited.");
  }

  /**
   * Owner forfeit of the selected match: one player (who takes the loss and the
   * forfeit KO penalty) or both. Confirmed first, since it cannot be undone here.
   *
   * @param side - `player_1` or `player_2` forfeits that side; `both` for a double forfeit.
   */
  async function handleOwnerForfeit(side: "player_1" | "player_2" | "both") {
    if (!goods || !selectedMatch) {
      return;
    }
    const p1 = selectedMatch.player_1_name;
    const p2 = selectedMatch.player_2_name;

    const forfeiting = await confirm({
      title:
        side === "both"
          ? "Forfeit both players?"
          : `Forfeit ${side === "player_1" ? p1 : p2}?`,
      detail:
        side === "both"
          ? `${p1} and ${p2} both take the loss and the forfeit KO penalty. Nobody wins this match.`
          : side === "player_1"
            ? `${p1} takes the loss and the forfeit KO penalty. ${p2} takes the win.`
            : `${p2} takes the loss and the forfeit KO penalty. ${p1} takes the win.`,
      confirmLabel: "Forfeit",
      tone: "danger",
    });

    if (!forfeiting) {
      return;
    }
    await canRunMutation(
      () => scheduleApi.ownerForfeitMatch(selectedMatch.id, side),
      goods.league.id,
    );
    setNotice("Match forfeited.");
  }

  /**
   * Owner revert of a forfeited match: returns it to its reported or agreed state.
   * Confirmed first, since it discards who forfeited and who won by forfeit.
   */
  async function handleRevertForfeit() {
    if (!goods || !selectedMatch) {
      return;
    }

    const reverting = await confirm({
      title: "Revert this forfeit?",
      detail:
        "The match returns to its reported games or agreed time, and the forfeit penalty is removed from the standings.",
      confirmLabel: "Revert forfeit",
      tone: "danger",
    });

    if (!reverting) {
      return;
    }
    await canRunMutation(
      () => scheduleApi.ownerRevertForfeit(selectedMatch.id),
      goods.league.id,
    );
    setNotice("Forfeit reverted.");
  }

  return {
    selectedMatchId: selectedMatch?.id ?? null,
    selectedMatch,
    selectMatch,
    myMatch,
    canAct,
    canOwnerActs,
    matchPickerOptions,
    firstPlayoffWeek,
    teamRecord,
    matchFormat,
    formatFor,
    gameRows,
    playerOneRecord,
    playerTwoRecord,
    hideSpoilers,
    setHideSpoilers,
    predictionLock,
    predictionPickName,
    handlePredict,
    schedulingMatchId,
    scheduleTime,
    setScheduleTime,
    scheduleNotes,
    setScheduleNotes,
    scheduleDateRef,
    isDatePickerOpen,
    handleOpenDatePicker,
    handleScheduleDateChange,
    handleScheduleDateBlur,
    openScheduling,
    handleProposeTime,
    closeScheduling,
    opponent,
    opponentAvailability,
    opponentWindows,
    isLoadingAvailability,
    availabilityError,
    scheduleFit,
    today,
    pendingProposal,
    proposalIsMine,
    proposalAuthor,
    handleRespondToProposal,
    handleCancelProposal,
    reportingMatchId,
    reportGame,
    setReportGame,
    reportWinner,
    setReportWinner,
    reportUrl,
    setReportUrl,
    reportAlive,
    setReportAlive,
    replayRead,
    setReplayRead,
    reportDifferential,
    openReporting,
    handleReadReplay,
    handleSubmitResult,
    closeReporting,
    editingResultId,
    editWinner,
    setEditWinner,
    editUrl,
    setEditUrl,
    editAlive,
    setEditAlive,
    openEditResult,
    handleSaveEditResult,
    closeEditing,
    handleForfeit,
    handleOwnerForfeit,
    handleRevertForfeit,
    upcomingWeekOptions,
    defaultUpcomingWeekKey,
    activeUpcomingWeekKey,
    setUpcomingWeekKey,
    historyWeekOptions,
    activeHistoryWeekKey,
    setHistoryWeekKey,
    upcomingMatches,
    visibleUpcomingMatches,
    completedMatches,
    visibleCompletedMatches,
    formOpen,
  };
}
