/*
 * Weekly match availability data layer for the Pokemon Draft League.
 *
 * Owns the recurring "when am I free to play" week a member declares in user
 * settings: one window per weekday, stored as a wall-clock range alongside the
 * time zone they picked. Availability is stored per day rather than as concrete
 * instants because it recurs every week, so the only conversion the schedule
 * page needs is projecting those wall clocks into the viewer's zone.
 *
 * The projection is lossy in one direction and that is deliberate: a window that
 * lands past midnight once converted is split at the day boundary, so every
 * window the rest of the code handles has a start that is not after its end.
 */
import { supabase } from "@/lib/supabase/client";
import { toZonedParts, zonedTimeToInstant } from "@/lib/datetime";

/** Weekday names indexed by `Date#getDay` (0 = Sunday). */
export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** A member's availability for a single weekday. */
export type DayAvailability = {
  /** Weekday index following `Date#getDay` (0 = Sunday). */
  day_of_week: number;
  /** When true the member never plays on this day, and the times are ignored. */
  is_unavailable: boolean;
  /** Local `HH:MM` the window opens, 24-hour. */
  start_time: string;
  /** Local `HH:MM` the window closes, 24-hour. A value at or before the start wraps past midnight. */
  end_time: string;
};

/** A member's availability for a whole week, always seven entries. */
export type AvailabilityWeek = DayAvailability[];

/**
 * An availability window already resolved into the reader's time zone.
 *
 * `endTime` may be `24:00`, which stands for the end of that weekday; a window
 * that crosses midnight once projected is emitted as two windows split at the
 * boundary so this never has to wrap.
 */
export type AvailabilityWindow = {
  /** Weekday the window falls on in the reader's zone. */
  dayOfWeek: number;
  /** Local `HH:MM` the window opens. */
  startTime: string;
  /** Local `HH:MM` the window closes, or `24:00`. */
  endTime: string;
};

/** A member's scheduling details, as seen from another member's schedule page. */
export type MemberAvailability = {
  /** The IANA time zone the member's stored wall clocks are expressed in. */
  timeZone: string;
  /** The member's week, or null when they have never set one. */
  week: AvailabilityWeek | null;
};

/** Whether a proposed match time lands inside a member's stated availability. */
export type AvailabilityFit = "inside" | "outside" | "unavailable";

/** Default window offered for a day the member has not touched. */
const DEFAULT_START_TIME = "18:00";
const DEFAULT_END_TIME = "23:00";

const MINUTES_PER_DAY = 1440;

/** Matches a valid `HH:MM` wall clock. */
const CLOCK_PATTERN = /^(2[0-3]|[01][0-9]):[0-5][0-9]$/;

/**
 * The week a member starts from: every day open in the evening. Used when a
 * profile has no stored rows yet, so the settings page always renders seven
 * editable days instead of an empty state.
 *
 * @returns A fresh seven-day week.
 */
export function defaultAvailabilityWeek(): AvailabilityWeek {
  return WEEKDAY_LABELS.map((_, day_of_week) => ({
    day_of_week,
    is_unavailable: false,
    start_time: DEFAULT_START_TIME,
    end_time: DEFAULT_END_TIME,
  }));
}

/**
 * Fills a partial set of stored rows out into a complete, ordered week.
 *
 * @param rows - Rows read from `user_availability`, possibly incomplete.
 * @returns Seven days in weekday order, with missing days left at their defaults.
 */
export function normalizeAvailabilityWeek(
  rows: Partial<DayAvailability>[] | null | undefined,
): AvailabilityWeek {
  const byDay = new Map<number, Partial<DayAvailability>>();

  for (const row of rows ?? []) {
    const day = Number(row.day_of_week);

    if (Number.isInteger(day) && day >= 0 && day <= 6) {
      byDay.set(day, { ...byDay.get(day), ...row, day_of_week: day });
    }
  }

  return WEEKDAY_LABELS.map((_, day_of_week) => {
    const row = byDay.get(day_of_week) ?? {};
    const start_time = row.start_time;
    const end_time = row.end_time;

    return {
      day_of_week,
      is_unavailable: Boolean(row.is_unavailable),
      start_time:
        typeof start_time === "string" && CLOCK_PATTERN.test(start_time)
          ? start_time
          : DEFAULT_START_TIME,
      end_time:
        typeof end_time === "string" && CLOCK_PATTERN.test(end_time)
          ? end_time
          : DEFAULT_END_TIME,
    };
  });
}

/**
 * Compares two weeks field by field so the settings page can tell whether the
 * availability section has unsaved edits.
 *
 * @param left - The saved week.
 * @param right - The week currently in the form.
 * @returns True when every day matches.
 */
export function availabilityWeeksEqual(
  left: AvailabilityWeek,
  right: AvailabilityWeek,
): boolean {
  return normalizeAvailabilityWeek(left).every((day, index) => {
    const other = right[index];

    return (
      other &&
      day.day_of_week === other.day_of_week &&
      day.is_unavailable === other.is_unavailable &&
      day.start_time === other.start_time &&
      day.end_time === other.end_time
    );
  });
}

/**
 * Loads the signed-in member's own availability week.
 *
 * @param userId - The profile to read.
 * @returns The stored week, or the default week when nothing has been saved.
 */
export async function loadOwnAvailabilityWeek(
  userId: string,
): Promise<AvailabilityWeek> {
  const { data, error } = await supabase
    .from("user_availability")
    .select("day_of_week, is_unavailable, start_time, end_time")
    .eq("user_id", userId)
    .order("day_of_week", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return normalizeAvailabilityWeek(data as Partial<DayAvailability>[] | null);
}

/**
 * Saves a member's whole week in one statement.
 *
 * All seven rows are upserted together against the `(user_id, day_of_week)`
 * primary key, so a day the member opened and left unchanged is still refreshed
 * and no row is ever orphaned. Values are range-checked here as well as by the
 * table's CHECK constraints so a bad entry fails with a readable message instead
 * of a Postgres error.
 *
 * @param userId - The profile to write.
 * @param week - The seven days to store.
 * @throws If a day carries a malformed time or the week is not seven days.
 */
export async function saveAvailabilityWeek(
  userId: string,
  week: AvailabilityWeek,
): Promise<void> {
  const normalized = normalizeAvailabilityWeek(week);

  for (const day of normalized) {
    if (!CLOCK_PATTERN.test(day.start_time) || !CLOCK_PATTERN.test(day.end_time)) {
      throw new Error(
        `Availability for ${WEEKDAY_LABELS[day.day_of_week]} must use a 24-hour time like 18:00.`,
      );
    }
  }

  const { error } = await supabase.from("user_availability").upsert(
    normalized.map((day) => ({
      user_id: userId,
      day_of_week: day.day_of_week,
      is_unavailable: day.is_unavailable,
      start_time: day.start_time,
      end_time: day.end_time,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "user_id,day_of_week" },
  );

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Loads the scheduling details of other members, for the opponent availability
 * panel on the schedule page.
 *
 * Profiles and availability are read together because the two are meaningless
 * apart: a wall clock is only interpretable alongside the zone it was typed in.
 *
 * @param userIds - Members whose details are needed.
 * @returns Each member's time zone and week, keyed by user id. Members who have
 *   set no availability are present with a null week.
 */
export async function loadMemberAvailability(
  userIds: string[],
): Promise<Record<string, MemberAvailability>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];

  if (uniqueIds.length === 0) {
    return {};
  }

  const [profilesResult, availabilityResult] = await Promise.all([
    supabase.from("profiles").select("id, timezone").in("id", uniqueIds),
    supabase
      .from("user_availability")
      .select("user_id, day_of_week, is_unavailable, start_time, end_time")
      .in("user_id", uniqueIds),
  ]);

  if (profilesResult.error || availabilityResult.error) {
    throw new Error(
      profilesResult.error?.message ??
        availabilityResult.error?.message ??
        "Member availability could not be loaded.",
    );
  }

  const rowsByUser = new Map<string, Partial<DayAvailability>[]>();

  for (const row of (availabilityResult.data ?? []) as (Partial<DayAvailability> & {
    user_id: string;
  })[]) {
    const existing = rowsByUser.get(row.user_id) ?? [];
    existing.push(row);
    rowsByUser.set(row.user_id, existing);
  }

  const result: Record<string, MemberAvailability> = {};

  for (const profile of (profilesResult.data ?? []) as {
    id: string;
    timezone: string | null;
  }[]) {
    const rows = rowsByUser.get(profile.id);

    result[profile.id] = {
      timeZone: profile.timezone?.trim() || "UTC",
      week: rows && rows.length > 0 ? normalizeAvailabilityWeek(rows) : null,
    };
  }

  return result;
}

/**
 * The weekday of a `YYYY-MM-DD` calendar date, without any zone maths: the date
 * is already a plain calendar day, so UTC arithmetic on it is exact.
 *
 * @param date - A `YYYY-MM-DD` calendar date.
 * @returns The weekday index (0 = Sunday), or null for a malformed date.
 */
export function dayOfWeekFromDate(date: string): number | null {
  const parsed = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  return parsed.getUTCDay();
}

/**
 * Adds whole days to a `YYYY-MM-DD` date, returning `YYYY-MM-DD`.
 *
 * @param date - The starting calendar date.
 * @param days - Days to move, which may be negative.
 * @returns The shifted calendar date, or the input when it cannot be parsed.
 */
export function addDaysToDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Date(parsed.getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The calendar date of a given weekday within the Sunday-to-Saturday week that
 * contains an anchor date.
 *
 * @param anchorDate - A `YYYY-MM-DD` date anywhere inside the desired week.
 * @param dayOfWeek - Weekday index to resolve (0 = Sunday).
 * @returns The matching calendar date, or the anchor when the weekday is invalid.
 */
export function dateForWeekday(anchorDate: string, dayOfWeek: number): string {
  const anchorDay = dayOfWeekFromDate(anchorDate);

  if (anchorDay == null || dayOfWeek < 0 || dayOfWeek > 6) {
    return anchorDate;
  }

  return addDaysToDate(anchorDate, dayOfWeek - anchorDay);
}

/**
 * Rewrites an absolute window as one or two windows on the reader's calendar.
 *
 * A converted window normally stays on one day, but a wide enough offset
 * difference can push it past midnight; it is then split at the boundary so the
 * rest of the code never has to reason about a window that wraps.
 *
 * A split is only worth emitting if it has length. A window whose end lands
 * exactly on midnight leaves an empty trailing piece, and a window that collapses
 * entirely leaves an empty single piece; both are dropped rather than rendered as
 * a zero-length "12:00 AM - 12:00 AM" row that would read as a real window.
 */
function pushProjectedWindow(
  windows: AvailabilityWindow[],
  startInstant: Date,
  endInstant: Date,
  toTimeZone: string,
): boolean {
  const start = toZonedParts(startInstant, toTimeZone);
  const end = toZonedParts(endInstant, toTimeZone);

  if (!start || !end) {
    return false;
  }

  const startDay = dayOfWeekFromDate(start.date);
  const endDay = dayOfWeekFromDate(end.date);

  if (startDay == null || endDay == null) {
    return false;
  }

  if (startDay === endDay) {
    if (start.time !== end.time) {
      windows.push({
        dayOfWeek: startDay,
        startTime: start.time,
        endTime: end.time,
      });
    }
    return true;
  }

  // The leading piece always has length: a window that starts at exactly midnight
  // and ends on the next day legitimately fills the whole day.
  windows.push({
    dayOfWeek: startDay,
    startTime: start.time,
    endTime: "24:00",
  });

  if (end.time !== "00:00") {
    windows.push({
      dayOfWeek: endDay,
      startTime: "00:00",
      endTime: end.time,
    });
  }

  return true;
}

/**
 * Projects a member's stored week into the reader's time zone.
 *
 * A recurring wall clock is resolved against the calendar week containing
 * `anchorDate` (Sunday through Saturday), then converted instant by instant, so
 * a member in one region sees the same free time the owner of those windows
 * declared. When a window falls in a daylight-saving gap on the sampled week and
 * therefore has no instant, the stored wall clock is passed through unchanged as
 * a best effort rather than dropping the day.
 *
 * @param week - The member's week, in their own time zone.
 * @param fromTimeZone - The zone the stored wall clocks are expressed in.
 * @param toTimeZone - The zone to present them in.
 * @param anchorDate - A `YYYY-MM-DD` date inside the week to project.
 * @returns The projected windows, ordered by weekday then start time.
 */
export function projectAvailabilityWeek(
  week: AvailabilityWeek,
  fromTimeZone: string,
  toTimeZone: string,
  anchorDate: string,
): AvailabilityWindow[] {
  const windows: AvailabilityWindow[] = [];

  for (const day of normalizeAvailabilityWeek(week)) {
    if (day.is_unavailable) {
      continue;
    }

    const date = dateForWeekday(anchorDate, day.day_of_week);
    const startInstant = zonedTimeToInstant(date, day.start_time, fromTimeZone);

    if (!startInstant) {
      windows.push({
        dayOfWeek: day.day_of_week,
        startTime: day.start_time,
        endTime: day.end_time,
      });
      continue;
    }

    // An end at or before the start means the window wraps past midnight, so
    // resolve it on the following day instead of producing a negative range.
    let endInstant = zonedTimeToInstant(date, day.end_time, fromTimeZone);

    if (endInstant && endInstant.getTime() <= startInstant.getTime()) {
      const wrapped = zonedTimeToInstant(
        addDaysToDate(date, 1),
        day.end_time,
        fromTimeZone,
      );

      if (wrapped && wrapped.getTime() > startInstant.getTime()) {
        endInstant = wrapped;
      }
    }

    if (!endInstant || !pushProjectedWindow(windows, startInstant, endInstant, toTimeZone)) {
      windows.push({
        dayOfWeek: day.day_of_week,
        startTime: day.start_time,
        endTime: day.end_time,
      });
    }
  }

  return windows.sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek || minutesFromClock(a.startTime) - minutesFromClock(b.startTime),
  );
}

/**
 * The windows that fall on one weekday.
 *
 * @param windows - Projected availability windows.
 * @param dayOfWeek - Weekday index to filter by (0 = Sunday).
 * @returns The windows on that day, in start order.
 */
export function windowsForWeekday(
  windows: AvailabilityWindow[],
  dayOfWeek: number,
): AvailabilityWindow[] {
  return windows.filter((window) => window.dayOfWeek === dayOfWeek);
}

/**
 * Converts an `HH:MM` wall clock to minutes since midnight, accepting the
 * day-ending `24:00` the projection produces.
 *
 * @param clock - A `HH:MM` string, or `24:00`.
 * @returns Minutes since midnight, or null when the value is unparseable.
 */
export function minutesFromClock(clock: string): number {
  if (clock === "24:00") {
    return MINUTES_PER_DAY;
  }

  const [hour, minute] = clock.split(":").map(Number);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return Number.NaN;
  }

  return hour * 60 + minute;
}

/**
 * Minutes since midnight for a `datetime-local` value's time half.
 *
 * @param inputValue - A `YYYY-MM-DDTHH:MM` input value.
 * @returns The minutes, or null when the value carries no usable time.
 */
export function minutesFromInputValue(inputValue: string): number | null {
  const [, time] = inputValue.split("T");

  if (!time) {
    return null;
  }

  const minutes = minutesFromClock(time.slice(0, 5));

  return Number.isFinite(minutes) ? minutes : null;
}

/**
 * Decides whether a proposed match time falls inside a member's availability.
 *
 * @param windows - The member's projected windows.
 * @param dayOfWeek - Weekday of the proposed match, in the reader's zone.
 * @param minutes - Minutes since midnight of the proposed match, in the reader's
 *   zone. The window's closing edge is exclusive, so a match starting exactly
 *   when the window shuts is reported as outside.
 * @returns Whether the time is inside, outside, or on a day they never play.
 */
export function availabilityFit(
  windows: AvailabilityWindow[],
  dayOfWeek: number,
  minutes: number,
): AvailabilityFit {
  const dayWindows = windowsForWeekday(windows, dayOfWeek);

  if (dayWindows.length === 0) {
    return "unavailable";
  }

  return dayWindows.some(
    (window) =>
      minutes >= minutesFromClock(window.startTime) &&
      minutes < minutesFromClock(window.endTime),
  )
    ? "inside"
    : "outside";
}

/**
 * Renders a wall clock for display, e.g. `6:00 PM`.
 *
 * @param clock - A `HH:MM` string, or the day-ending `24:00`.
 * @returns A 12-hour label, or the em dash when the value is unparseable.
 */
export function formatClock(clock: string): string {
  const minutes = minutesFromClock(clock);

  if (!Number.isFinite(minutes)) {
    return "—";
  }

  if (minutes === MINUTES_PER_DAY) {
    return "midnight";
  }

  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * Renders one availability window, e.g. `6:00 PM – 11:00 PM`.
 *
 * @param window - The window to render.
 * @returns The label, or an em dash when either end is unparseable.
 */
export function formatAvailabilityWindow(window: AvailabilityWindow): string {
  const start = formatClock(window.startTime);
  const end = formatClock(window.endTime);

  if (start === "—" || end === "—") {
    return "—";
  }

  return `${start} – ${end}`;
}
