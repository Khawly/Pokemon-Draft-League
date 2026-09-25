/*
 * Weekly league deadline data layer for the Pokemon Draft League.
 *
 * Owns the owner-facing configuration of the recurring weekly deadline (the
 * league format, the first deadline's local date/time/time zone, and the pause
 * state) plus the client-side helpers that mirror the database's recurrence
 * math so the settings page can preview the next deadline without a round trip.
 * Also owns the manual week controls: progressing a week on demand and undoing
 * the most recent progression (whether it came from the button or the deadline).
 * All writes go through SECURITY DEFINER RPCs so validation (time zone, time
 * format, ownership) and the undo bookkeeping stay on the server.
 */
import { supabase } from "@/lib/supabase/client";
import { toZonedParts, zonedTimeToInstant } from "@/lib/datetime";

/** Team size per side; decides the maximum negative differential. */
export type LeagueFormat = "6v6" | "4v4";

/** Games a team must win to take a match. */
export type MatchFormat = "single" | "best_of_3";

/** Deadline/format state for a league's current season. */
export type WeekDeadlineSettings = {
  league_format: LeagueFormat;
  match_format: MatchFormat;
  week_deadline_enabled: boolean;
  /** Calendar date of the first deadline, in the league's time zone. */
  week_deadline_anchor_date: string | null;
  /** Local `HH:MM` of each weekly deadline. */
  week_deadline_time: string;
  week_deadline_timezone: string;
  week_deadline_paused: boolean;
  week_deadline_paused_at: string | null;
  week_deadline_last_advanced_at: string | null;
  /** Matches settled as double losses by the most recent advance. */
  week_deadline_settled_matches: number;
  /** The week the deadline sweep is currently working through. */
  current_week: number;
  regular_season_weeks: number;
  regular_season_completed_at: string | null;
};

type WeekDeadlineRow = {
  league_format?: string | null;
  match_format?: string | null;
  week_deadline_enabled?: boolean | null;
  week_deadline_anchor_date?: string | null;
  week_deadline_time?: string | null;
  week_deadline_timezone?: string | null;
  week_deadline_paused?: boolean | null;
  week_deadline_paused_at?: string | null;
  week_deadline_last_advanced_at?: string | null;
  week_deadline_settled_matches?: number | null;
  current_week?: number | null;
  regular_season_weeks?: number | null;
  regular_season_completed_at?: string | null;
};

/** Fields accepted when configuring the weekly deadline. */
export type WeekDeadlineInput = {
  enabled: boolean;
  /** `YYYY-MM-DD` calendar date of the first deadline. */
  firstDeadlineDate: string;
  /** `HH:MM` 24-hour local time. */
  time: string;
  /** IANA time zone the local time is expressed in. */
  timeZone: string;
};

/** Outcome of nudging the deadline sweep from a client. */
export type WeekDeadlineSweepResult = {
  /** Leagues that advanced a week or opened playoffs on this sweep. */
  leaguesAdvanced: number;
};

/** Statuses the week progression RPC can end on. */
export type WeekProgressStatus =
  | "advanced"
  | "playoffs_started"
  | "playoffs_pending"
  | "regular_season_complete"
  | "no_settings"
  | "not_enabled"
  | "paused"
  | "not_configured"
  | "no_schedule"
  | "not_due";

/** A journalled week progression, as the settings page describes it. */
export type WeekProgressEntry = {
  id: number;
  /** 'manual' for the Progress week button, 'deadline' for the sweep. */
  source: "manual" | "deadline";
  from_week: number;
  to_week: number;
  /** Matches that were settled as double losses. */
  settled_count: number;
  advanced_at: string;
  /** Playoff matches the progression created. */
  playoff_matches: number;
};

/** Week progression state used to describe the Progress/Undo controls. */
export type WeekProgressState = {
  current_week: number;
  total_weeks: number;
  /** Matches of the current week that nobody has reported yet. */
  unreported_matches: number;
  regular_season_completed: boolean;
  playoffs_started: boolean;
  deadline_enabled: boolean;
  deadline_paused: boolean;
  next_deadline: string | null;
  can_progress: boolean;
  can_undo: boolean;
  /** The most recent progression that has not been undone. */
  latest_progress: WeekProgressEntry | null;
};

/** What an undo actually reverted. */
export type UndoWeekProgressResult = {
  status: "undone" | "nothing_to_undo" | "stale";
  /** Set when the status is 'stale'. */
  message?: string;
  from_week?: number;
  to_week?: number;
  matches_reopened?: number;
  playoff_matches_deleted?: number;
  notifications_deleted?: number;
  /** True when a still-running, already-passed deadline will settle the week again. */
  will_resettle?: boolean;
};

/**
 * The KO differential a double forfeit charges each team: the games needed to
 * win times the Pokemon per side, negated.
 *
 * @param leagueFormat - Team size per side.
 * @param matchFormat - Games a team must win to take a match.
 * @returns A negative differential (-12 for a 6v6 best-of-3, -8 for 4v4).
 */
export function doubleForfeitDifferential(
  leagueFormat: LeagueFormat,
  matchFormat: MatchFormat,
): number {
  const gamesToWin = matchFormat === "single" ? 1 : 2;
  const teamSize = leagueFormat === "4v4" ? 4 : 6;
  return -(gamesToWin * teamSize);
}

/**
 * Resolves the next weekly deadline instant, mirroring the database recurrence
 * (anchor date plus whole weeks, applied as a local wall clock in the league's
 * time zone).
 *
 * @param settings - The league's deadline settings.
 * @param now - Instant to resolve from; defaults to the current time.
 * @returns The next deadline instant, or null when no deadline is configured.
 */
export function nextDeadlineInstant(
  settings: Pick<
    WeekDeadlineSettings,
    "week_deadline_anchor_date" | "week_deadline_time" | "week_deadline_timezone"
  >,
  now: Date = new Date(),
): Date | null {
  const { week_deadline_anchor_date, week_deadline_time, week_deadline_timezone } =
    settings;

  if (!week_deadline_anchor_date) {
    return null;
  }

  const localToday = toZonedParts(now, week_deadline_timezone);
  if (!localToday) {
    return null;
  }

  const anchor = new Date(`${week_deadline_anchor_date}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) {
    return null;
  }

  const daysSinceAnchor = Math.floor(
    (Date.UTC(
      Number(localToday.date.slice(0, 4)),
      Number(localToday.date.slice(5, 7)) - 1,
      Number(localToday.date.slice(8, 10)),
    ) -
      anchor.getTime()) /
      86_400_000,
  );

  const elapsedWeeks = Math.max(0, Math.floor(daysSinceAnchor / 7));

  for (const offset of [elapsedWeeks, elapsedWeeks + 1]) {
    const candidate = zonedTimeToInstant(
      addDays(week_deadline_anchor_date, offset * 7),
      week_deadline_time,
      week_deadline_timezone,
    );
    if (candidate && candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }

  return null;
}

/** Adds whole days to a `YYYY-MM-DD` date, returning `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) {
    return date;
  }
  return new Date(base.getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Loads the deadline and league-format state for a league's season.
 *
 * @param leagueId - League whose settings to read.
 * @param seasonId - Season whose settings row to read.
 * @returns The settings, or null when the league has no season or the columns
 *   are missing (the migration has not been applied).
 */
export async function loadWeekDeadlineSettings(
  leagueId: string,
  seasonId: string,
): Promise<WeekDeadlineSettings | null> {
  const { data, error } = await supabase
    .from("league_settings")
    .select(
      "league_format, match_format, week_deadline_enabled, week_deadline_anchor_date, week_deadline_time, week_deadline_timezone, week_deadline_paused, week_deadline_paused_at, week_deadline_last_advanced_at, week_deadline_settled_matches, current_week, regular_season_weeks, regular_season_completed_at",
    )
    .eq("league_id", leagueId)
    .eq("season_id", seasonId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const row = data as WeekDeadlineRow;

  return {
    league_format: (row.league_format as LeagueFormat) ?? "6v6",
    match_format: (row.match_format as MatchFormat) ?? "best_of_3",
    week_deadline_enabled: Boolean(row.week_deadline_enabled),
    week_deadline_anchor_date: row.week_deadline_anchor_date ?? null,
    week_deadline_time: row.week_deadline_time ?? "20:00",
    week_deadline_timezone: row.week_deadline_timezone ?? "UTC",
    week_deadline_paused: Boolean(row.week_deadline_paused),
    week_deadline_paused_at: row.week_deadline_paused_at ?? null,
    week_deadline_last_advanced_at: row.week_deadline_last_advanced_at ?? null,
    week_deadline_settled_matches: Number(row.week_deadline_settled_matches ?? 0),
    current_week: Number(row.current_week ?? 0),
    regular_season_weeks: Number(row.regular_season_weeks ?? 0),
    regular_season_completed_at: row.regular_season_completed_at ?? null,
  };
}

/**
 * Sets the league's team size per side.
 *
 * @param leagueId - League to update.
 * @param leagueFormat - The new format.
 * @throws If the RPC rejects the change.
 */
export async function saveLeagueFormat(
  leagueId: string,
  leagueFormat: LeagueFormat,
): Promise<void> {
  const { error } = await supabase.rpc("set_league_format", {
    p_league_id: leagueId,
    p_league_format: leagueFormat,
  });

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Configures (or clears) the recurring weekly deadline.
 *
 * @param leagueId - League to update.
 * @param input - The deadline configuration to store.
 * @throws If the RPC rejects the configuration.
 */
export async function saveWeekDeadline(
  leagueId: string,
  input: WeekDeadlineInput,
): Promise<void> {
  const { error } = await supabase.rpc("set_week_deadline", {
    p_league_id: leagueId,
    p_enabled: input.enabled,
    p_first_deadline_date: input.firstDeadlineDate || null,
    p_time: input.time,
    p_timezone: input.timeZone,
  });

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Pauses or resumes the weekly deadline. Resuming evaluates the deadline
 * immediately, so a league that is already past it progresses one week.
 *
 * @param leagueId - League to update.
 * @param paused - True to pause, false to resume.
 * @throws If the RPC rejects the change.
 */
export async function setWeekDeadlinePaused(
  leagueId: string,
  paused: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_week_deadline_paused", {
    p_league_id: leagueId,
    p_paused: paused,
  });

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Nudges the deadline sweep from a browser so a week still closes when the
 * app server is not running. The sweep is idempotent and only advances weeks
 * that are already past their deadline.
 *
 * @returns How many leagues advanced on this sweep.
 */
export async function runWeekDeadlineSweep(): Promise<WeekDeadlineSweepResult> {
  const { data, error } = await supabase.rpc("advance_overdue_week_deadlines");

  if (error) {
    throw new Error(error.message);
  }

  return { leaguesAdvanced: Number(data ?? 0) };
}

/**
 * Reads the week progression state that describes the Progress/Undo controls.
 *
 * @param leagueId - League whose state to read.
 * @returns The state, or null when the league has no settings row yet.
 * @throws If the RPC is unavailable (migration not applied) or the caller is
 *   not a member of the league.
 */
export async function loadWeekProgressState(
  leagueId: string,
): Promise<WeekProgressState | null> {
  const { data, error } = await supabase.rpc("week_progress_state", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message);
  }

  const state = data as Partial<WeekProgressState> & { status?: string } | null;

  if (!state || state.status !== "ok") {
    return null;
  }

  return {
    current_week: Number(state.current_week ?? 0),
    total_weeks: Number(state.total_weeks ?? 0),
    unreported_matches: Number(state.unreported_matches ?? 0),
    regular_season_completed: Boolean(state.regular_season_completed),
    playoffs_started: Boolean(state.playoffs_started),
    deadline_enabled: Boolean(state.deadline_enabled),
    deadline_paused: Boolean(state.deadline_paused),
    next_deadline: state.next_deadline ?? null,
    can_progress: Boolean(state.can_progress),
    can_undo: Boolean(state.can_undo),
    latest_progress: state.latest_progress ?? null,
  };
}

/**
 * Closes the current week and moves the league on immediately, without waiting
 * for the deadline. Matches nobody reported become double losses, and closing
 * the final week opens the bracket. The move can be undone afterwards.
 *
 * @param leagueId - League to progress.
 * @returns The status the progression ended on.
 * @throws If the owner-only RPC rejects the progression.
 */
export async function progressLeagueWeek(
  leagueId: string,
): Promise<WeekProgressStatus> {
  const { data, error } = await supabase.rpc("progress_league_week", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data as WeekProgressStatus;
}

/**
 * Reverts the most recent week progression of the league's current season,
 * reopening the matches it settled, removing the notifications it sent, dropping
 * a bracket it opened, and restoring the week pointer and schedule.
 *
 * @param leagueId - League to rewind.
 * @returns What was reverted, or why it could not be.
 * @throws If the owner-only RPC fails.
 */
export async function undoWeekProgress(
  leagueId: string,
): Promise<UndoWeekProgressResult> {
  const { data, error } = await supabase.rpc("undo_league_week_progress", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? { status: "nothing_to_undo" }) as UndoWeekProgressResult;
}
