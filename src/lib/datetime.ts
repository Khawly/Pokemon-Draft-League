/*
 * Time zone helpers for the Pokemon Draft League.
 *
 * The league deadline is stored in Postgres as an anchor calendar date plus a
 * local wall-clock time and an IANA time zone, so the client needs to convert
 * between "what the owner typed" and "an absolute instant" in both directions
 * without pulling in a date library. Everything here is built on Intl, which is
 * available in every supported browser and in the Node runtime.
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
 * Lists the IANA time zones the owner can pick, sorted, with the runtime's
 * browser/ICU zone list when available and a small curated list otherwise.
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
        return [...zones].sort((a, b) => a.localeCompare(b));
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
    const offset = zoneOffsetMs(instant, timeZone);
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
