/*
 * Time zone helpers for the Pokemon Draft League.
 *
 * The league deadline is stored in Postgres as an anchor calendar date plus a
 * local wall-clock time and an IANA time zone, so the client needs to convert
 * between "what the owner typed" and "an absolute instant" in both directions
 * without pulling in a date library. Everything here is built on Intl, which is
 * available in every supported browser and in the Node runtime.
 *
 * The same conversions serve two audiences: the league owner configuring a
 * deadline, and every member reading league timestamps in the time zone they
 * picked in user settings. The last group of helpers bridges the two, turning a
 * stored UTC timestamp into the strings a `datetime-local` input needs and back.
 */

/** Fallback zone list for runtimes without Intl.supportedValuesOf. */
const FALLBACK_TIME_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

/** Local date and time split out of an instant, as input values. */
export type ZonedParts = {
  /** `YYYY-MM-DD` in the target time zone. */
  date: string;
  /** `HH:MM` (24-hour) in the target time zone. */
  time: string;
};

/**
 * Lists the IANA time zones a member can pick, sorted.
 *
 * UTC is added explicitly: `Intl.supportedValuesOf("timeZone")` returns only
 * canonical region identifiers and omits UTC, so without this a member could
 * never select it even though it is the one zone every other fallback assumes.
 *
 * @returns Time zone identifiers suitable for a select input.
 */
export function listTimeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };

  if (typeof intl.supportedValuesOf === "function") {
    try {
      const zones = intl.supportedValuesOf("timeZone");
      if (Array.isArray(zones) && zones.length > 0) {
        return [...new Set([...zones, "UTC"])].sort((a, b) => a.localeCompare(b));
      }
    } catch {
      // Fall through to the curated list.
    }
  }

  return [...FALLBACK_TIME_ZONES].sort((a, b) => a.localeCompare(b));
}

/**
 * Returns the time zone the current browser is in, falling back to UTC.
 *
 * @returns An IANA time zone identifier.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Caches `Intl.DateTimeFormat` instances per option set.
 *
 * Building a formatter is by far the most expensive part of a zone lookup, and a
 * page that renders every time zone (the deadline dropdown) would otherwise pay
 * that cost on each render. Formatters hold no per-call state, so reusing one
 * across instants and renders is safe; only the cache key must capture every
 * option that changes the output.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Returns a cached formatter for the given key, creating it on first use.
 *
 * @param key - Cache key covering the locale and every formatting option.
 * @param options - Options passed to `Intl.DateTimeFormat`.
 * @param locale - Locale, or undefined to use the runtime default.
 * @returns A reusable formatter for that key.
 */
function cachedFormatter(
  key: string,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): Intl.DateTimeFormat {
  const cached = formatterCache.get(key);

  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat(locale, options);
  formatterCache.set(key, formatter);

  return formatter;
}

/** Reads the wall-clock offset of a zone at an instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = cachedFormatter(`offset:${timeZone}`, {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : NaN;
  };

  const year = read("year");
  const month = read("month");
  const day = read("day");
  const hour = read("hour");
  const minute = read("minute");
  const second = read("second");

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return 0;
  }

  return (
    Date.UTC(year, month - 1, day, hour, minute, second) -
    // Truncate to whole seconds: Intl formats at second precision, so an
    // instant carrying milliseconds would otherwise skew the offset.
    Math.floor(instant.getTime() / 1000) * 1000
  );
}

/**
 * Splits an instant into the local date and time of a time zone.
 *
 * @param instant - The absolute instant to convert.
 * @param timeZone - IANA time zone to render it in.
 * @returns The local `date` and 24-hour `time`, or null when the zone is
 *   unknown to the runtime.
 */
export function toZonedParts(instant: Date, timeZone: string): ZonedParts | null {
  try {
    const formatter = cachedFormatter(
      `parts:${timeZone}`,
      {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      },
      "en-CA",
    );

    const parts = formatter.formatToParts(instant);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";

    const year = read("year");
    const month = read("month");
    const day = read("day");
    const hour = read("hour");
    const minute = read("minute");

    if (!year || !month || !day || hour === "" || minute === "") {
      return null;
    }

    return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
  } catch {
    return null;
  }
}

/**
 * Converts a local date + time in a time zone to the absolute instant it refers
 * to.
 *
 * Two passes are made against the zone's offset so daylight-saving transitions
 * resolve correctly, then the result is round-tripped: a local time that does
 * not exist (the spring-forward gap) is rejected with null instead of silently
 * shifting by an hour. An ambiguous local time (the fall-back hour) resolves to
 * its first occurrence.
 *
 * @param date - `YYYY-MM-DD` in the target time zone.
 * @param time - `HH:MM` (24-hour) in the target time zone.
 * @param timeZone - IANA time zone the values are expressed in.
 * @returns The instant, or null when the inputs are invalid or do not exist.
 */
export function zonedTimeToInstant(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  // Treat the wall clock as if it were UTC first, then subtract the zone offset.
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = new Date(wallClock);

  for (let pass = 0; pass < 2; pass += 1) {
    let offset: number;

    try {
      offset = zoneOffsetMs(instant, timeZone);
    } catch {
      // An unknown zone makes Intl throw while building the formatter. Callers
      // treat null as "this cannot be expressed", so a bad stored zone must not
      // take down the page that is trying to use it.
      return null;
    }

    const corrected = new Date(wallClock - offset);
    if (corrected.getTime() === instant.getTime()) {
      break;
    }
    instant = corrected;
  }

  const roundTrip = toZonedParts(instant, timeZone);
  if (!roundTrip || roundTrip.date !== date || roundTrip.time !== time) {
    return null;
  }

  return instant;
}

/**
 * Formats an instant for display in a specific time zone.
 *
 * @param instant - The instant to render.
 * @param timeZone - IANA time zone to render it in.
 * @returns A localized date-time string including the zone's short name.
 */
export function formatInTimeZone(
  instant: Date,
  timeZone: string,
): string {
  try {
    return cachedFormatter(`display:${timeZone}`, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(instant);
  } catch {
    return instant.toISOString();
  }
}

/**
 * Formats a stored timestamp as the date and time a member in `timeZone` reads.
 *
 * Every league page routes its timestamps through here so that a user's chosen
 * zone, rather than the browser's, decides what "8:00 PM" means to them. The
 * shape deliberately matches the short `month/day hour:minute` form the pages
 * already used; the zone itself is stated once per page rather than on every
 * value.
 *
 * @param value - An ISO timestamp, or null.
 * @param timeZone - IANA time zone to render it in.
 * @param options - Optional `Intl.DateTimeFormat` options to override the default
 *   shape. A view that has to disambiguate two timestamps from different weeks,
 *   such as the owner proposal log, needs the weekday and cannot rely on the
 *   abbreviated default. The zone is always applied, so an override cannot shift
 *   a value out of the reader's zone.
 * @returns The formatted date-time, or an em dash when there is no usable value.
 */
export function formatDateTimeInZone(
  value: string | null,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) {
    return "—";
  }

  const instant = new Date(value);

  if (Number.isNaN(instant.getTime())) {
    return "—";
  }

  try {
    return cachedFormatter(
      `pageDateTime:${timeZone}:${options ? JSON.stringify(options) : "default"}`,
      {
        timeZone,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...options,
      },
    ).format(instant);
  } catch {
    /*
     * An unusable zone makes Intl throw a RangeError. Returning the em dash
     * keeps the documented contract for "no usable value" true, and means a
     * corrupt timezone on a profile degrades one label instead of taking the
     * page down. This mirrors zonedTimeToInstant, which returns null rather than
     * throwing for the same reason.
     */
    return "—";
  }
}

/**
 * Converts a stored timestamp into a `datetime-local` input value read in
 * `timeZone`.
 *
 * `datetime-local` has no zone of its own, so a naive implementation would hand
 * back the browser's wall clock and silently shift the saved instant for anyone
 * who picked a zone that is not their device's.
 *
 * @param value - An ISO timestamp, or null.
 * @param timeZone - IANA time zone the input is expressed in.
 * @returns A `YYYY-MM-DDTHH:MM` string, or an empty string when unavailable.
 */
export function toZonedInputValue(
  value: string | null,
  timeZone: string,
): string {
  if (!value) {
    return "";
  }

  const instant = new Date(value);

  if (Number.isNaN(instant.getTime())) {
    return "";
  }

  const parts = toZonedParts(instant, timeZone);

  return parts ? `${parts.date}T${parts.time}` : "";
}

/**
 * Converts a `datetime-local` input value typed in `timeZone` back to an ISO
 * timestamp.
 *
 * @param value - A `YYYY-MM-DDTHH:MM` input value.
 * @param timeZone - IANA time zone the input is expressed in.
 * @returns The ISO timestamp, or null when the value is empty or falls in a
 *   daylight-saving gap where that local time does not exist.
 */
export function fromZonedInputValue(
  value: string,
  timeZone: string,
): string | null {
  if (!value) {
    return null;
  }

  const [date, time] = value.split("T");

  if (!date || !time) {
    return null;
  }

  return zonedTimeToInstant(date, time.slice(0, 5), timeZone)?.toISOString() ?? null;
}

/**
 * Extracts the `YYYY-MM-DD` half of a `datetime-local` value.
 *
 * The schedule form drives a date input and a time input from one string so the
 * two halves cannot disagree, which means each needs to read its own part back
 * out rather than holding separate state.
 *
 * @param value - A `YYYY-MM-DDTHH:MM` input value, possibly incomplete.
 * @returns The date part, or an empty string when the value has no date.
 */
export function datePartOfInputValue(value: string): string {
  return value.split("T")[0] ?? "";
}

/**
 * Extracts the `HH:MM` half of a `datetime-local` value.
 *
 * @param value - A `YYYY-MM-DDTHH:MM` input value, possibly incomplete.
 * @returns The time part, or an empty string when the value has no time.
 */
export function timePartOfInputValue(value: string): string {
  return value.split("T")[1]?.slice(0, 5) ?? "";
}

/**
 * Replaces the date half of a `datetime-local` value, keeping the time.
 *
 * @param value - The current input value, whose time is preserved.
 * @param date - A `YYYY-MM-DD` date from a date input.
 * @returns The recombined input value, or an empty string when the date is empty,
 *   since a cleared date input must not leave a stale date behind.
 */
export function withInputValueDate(value: string, date: string): string {
  if (!date) {
    return "";
  }

  const time = timePartOfInputValue(value);

  return time ? `${date}T${time}` : date;
}

/**
 * Replaces the time half of a `datetime-local` value, keeping the date.
 *
 * @param value - The current input value, whose date is preserved.
 * @param time - An `HH:MM` time from a time input.
 * @returns The recombined input value, or an empty string when the time is empty,
 *   since a cleared time input must not leave a stale time behind.
 */
export function withInputValueTime(value: string, time: string): string {
  if (!time) {
    return "";
  }

  const date = datePartOfInputValue(value);

  return date ? `${date}T${time}` : time;
}

/**
 * Today's date in a given time zone, as a `YYYY-MM-DD` string.
 *
 * Used to seed a date input with a sensible default. Going through
 * `toZonedInputValue` matters here: a user who set a zone that is not their
 * device's is proposing a wall clock in that zone, so "today" has to be today
 * there rather than on the device, which can be a different day entirely.
 *
 * @param timeZone - IANA time zone to resolve the day in.
 * @param now - The instant to resolve, defaulting to the current time.
 * @returns A `YYYY-MM-DD` string, or an empty string when the zone is unknown.
 */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return datePartOfInputValue(toZonedInputValue(now.toISOString(), timeZone));
}

/**
 * Formats the UTC offset of a time zone right now, e.g. `UTC-04:00`.
 *
 * @param timeZone - IANA time zone to describe.
 * @returns The offset label, or an empty string when unknown.
 */
export function timeZoneOffsetLabel(timeZone: string): string {
  try {
    const offset = zoneOffsetMs(new Date(), timeZone);
    const sign = offset < 0 ? "-" : "+";
    const total = Math.round(Math.abs(offset) / 60_000);
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

/**
 * Describes a time zone by the GMT offset it is on right now, e.g. `GMT+1`,
 * `GMT+5:30`, or plain `GMT` for zero.
 *
 * This is the acronym people actually recognise on a clock, and it is computed
 * from the zone's own offset rather than read from `Intl`. Intl's `short` zone
 * name is not usable here: it returns a region abbreviation where one exists
 * (`EDT`, `BST`, `JST`) and a GMT offset where one does not, so the same column
 * would mix two formats, and the `shortGMT` option many runtimes support is
 * rejected outright by others.
 *
 * The offset is the one in effect now, so a zone that observes daylight saving
 * reads `GMT+1` in summer and `GMT` in winter.
 *
 * @param timeZone - IANA time zone to describe.
 * @returns The acronym, or an empty string when the zone is unknown.
 */
export function timeZoneAcronym(timeZone: string): string {
  let offset: number;

  try {
    offset = zoneOffsetMs(new Date(), timeZone);
  } catch {
    return "";
  }

  if (offset === 0) {
    return "GMT";
  }

  const sign = offset < 0 ? "-" : "+";
  const totalMinutes = Math.round(Math.abs(offset) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  // Whole hours stay unpadded so the common case reads "GMT+1" rather than
  // "GMT+01:00"; a half-hour zone has to show the minutes to be unambiguous.
  return minutes === 0
    ? `GMT${sign}${hours}`
    : `GMT${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Renders a time zone the way the settings picker and the pages that announce
 * the reader's zone do: the identifier followed by its GMT acronym, e.g.
 * `Europe/London (GMT+1)`.
 *
 * @param timeZone - IANA time zone to describe.
 * @returns The combined label, or the bare identifier when it is unknown.
 */
export function formatTimeZoneLabel(timeZone: string): string {
  const acronym = timeZoneAcronym(timeZone);
  return acronym ? `${timeZone} (${acronym})` : timeZone;
}

