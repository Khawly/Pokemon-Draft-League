/*
 * Tests for the weekly availability projection.
 *
 * Availability is a recurring wall clock, so turning it into something a member
 * in another zone can read is the subtlest logic in the app: a window can land on
 * a different weekday, split across midnight, or fall in a daylight saving gap
 * that makes the local time not exist. The cases below are all of those, plus the
 * degenerate range that a midnight boundary can produce.
 */
import { describe, expect, it } from "vitest";

import {
  addDaysToDate,
  availabilityFit,
  availabilityWeeksEqual,
  dateForWeekday,
  dayOfWeekFromDate,
  defaultAvailabilityWeek,
  formatAvailabilityWindow,
  formatClock,
  minutesFromClock,
  minutesFromInputValue,
  normalizeAvailabilityWeek,
  projectAvailabilityWeek,
  windowsForWeekday,
  WEEKDAY_LABELS,
  type AvailabilityWeek,
} from "@/lib/supabase/availability";

const NEW_YORK = "America/New_York";
const LONDON = "Europe/London";
const CHICAGO = "America/Chicago";
const TOKYO = "Asia/Tokyo";

/**
 * Builds a week from a compact description, defaulting everything unspecified.
 *
 * @param days - Per-day overrides keyed by weekday index.
 * @returns A normalized seven-day week.
 */
function week(days: Partial<Record<number, { start?: string; end?: string; off?: boolean }>>): AvailabilityWeek {
  return normalizeAvailabilityWeek(
    WEEKDAY_LABELS.map((_, day_of_week) => {
      const entry = days[day_of_week];

      return {
        day_of_week,
        is_unavailable: entry?.off ?? false,
        start_time: entry?.start ?? "18:00",
        end_time: entry?.end ?? "23:00",
      };
    }),
  );
}

/**
 * Builds a week where only the listed days are available, so an assertion about
 * one day is not polluted by the default window every other day carries.
 *
 * @param days - The days that should be available, with their windows.
 * @returns A normalized seven-day week.
 */
function onlyAvailable(
  days: Record<number, { start?: string; end?: string }>,
): AvailabilityWeek {
  return normalizeAvailabilityWeek(
    WEEKDAY_LABELS.map((_, day_of_week) => ({
      day_of_week,
      is_unavailable: !(day_of_week in days),
      start_time: days[day_of_week]?.start ?? "18:00",
      end_time: days[day_of_week]?.end ?? "23:00",
    })),
  );
}

/** Renders a day's windows as one string, for concise assertions. */
function day(windows: ReturnType<typeof projectAvailabilityWeek>, day: number): string {
  return windowsForWeekday(windows, day)
    .map((window) => formatAvailabilityWindow(window))
    .join(" | ");
}

describe("WEEKDAY_LABELS", () => {
  it("is seven days starting on Sunday", () => {
    expect(WEEKDAY_LABELS).toHaveLength(7);
    expect(WEEKDAY_LABELS[0]).toBe("Sunday");
    expect(WEEKDAY_LABELS[6]).toBe("Saturday");
  });
});

describe("defaultAvailabilityWeek", () => {
  it("offers every day, evening to late", () => {
    const fresh = defaultAvailabilityWeek();

    expect(fresh).toHaveLength(7);
    expect(fresh.every((day) => !day.is_unavailable)).toBe(true);
    expect(fresh[0].start_time).toBe("18:00");
    expect(fresh[0].end_time).toBe("23:00");
  });

  it("returns a fresh object each call so callers cannot share state", () => {
    expect(defaultAvailabilityWeek()).not.toBe(defaultAvailabilityWeek());
  });
});

describe("normalizeAvailabilityWeek", () => {
  it("fills in every day from a partial set", () => {
    const normalized = normalizeAvailabilityWeek([
      { day_of_week: 3, is_unavailable: true },
    ]);

    expect(normalized).toHaveLength(7);
    expect(normalized[3].is_unavailable).toBe(true);
    expect(normalized[4].is_unavailable).toBe(false);
  });

  it("returns defaults for no input at all", () => {
    expect(normalizeAvailabilityWeek(null)).toHaveLength(7);
    expect(normalizeAvailabilityWeek(undefined)).toHaveLength(7);
  });

  it("ignores a weekday index outside 0-6", () => {
    expect(normalizeAvailabilityWeek([{ day_of_week: 9, is_unavailable: true }])).toHaveLength(7);
  });

  it("replaces a malformed time with the default", () => {
    const [monday] = normalizeAvailabilityWeek([
      { day_of_week: 1, start_time: "half past six", end_time: "99:99" },
    ]);

    expect(monday.start_time).toBe("18:00");
    expect(monday.end_time).toBe("23:00");
  });

  it("keeps a valid time as given", () => {
    const normalized = normalizeAvailabilityWeek([
      { day_of_week: 1, start_time: "07:30", end_time: "09:15" },
    ]);

    // Index 1 is Monday, which is the day that was supplied.
    expect(normalized[1].start_time).toBe("07:30");
    expect(normalized[1].end_time).toBe("09:15");
  });
});

describe("availabilityWeeksEqual", () => {
  it("is true for two defaults", () => {
    expect(availabilityWeeksEqual(defaultAvailabilityWeek(), defaultAvailabilityWeek())).toBe(true);
  });

  it("is false when a day is toggled", () => {
    const edited = defaultAvailabilityWeek();
    edited[2].is_unavailable = true;

    expect(availabilityWeeksEqual(defaultAvailabilityWeek(), edited)).toBe(false);
  });

  it("is false when a time moves", () => {
    const edited = defaultAvailabilityWeek();
    edited[4].start_time = "17:00";

    expect(availabilityWeeksEqual(defaultAvailabilityWeek(), edited)).toBe(false);
  });
});

describe("date helpers", () => {
  it("reads a weekday from a calendar date", () => {
    // 2026-09-27 is a Sunday, the start of the week.
    expect(dayOfWeekFromDate("2026-09-27")).toBe(0);
    expect(dayOfWeekFromDate("2026-10-03")).toBe(6);
  });

  it("returns null for a malformed date", () => {
    expect(dayOfWeekFromDate("2026-13-40")).toBeNull();
    expect(dayOfWeekFromDate("nonsense")).toBeNull();
  });

  it("adds days across a month boundary", () => {
    expect(addDaysToDate("2026-09-28", 7)).toBe("2026-10-05");
    expect(addDaysToDate("2026-10-01", -1)).toBe("2026-09-30");
  });

  it("returns the input unchanged when it cannot be parsed", () => {
    expect(addDaysToDate("nonsense", 3)).toBe("nonsense");
  });

  it("resolves each weekday within the anchor's Sunday-to-Saturday week", () => {
    // The anchor is a Tuesday; the whole week must still come out.
    expect(dateForWeekday("2026-09-29", 0)).toBe("2026-09-27");
    expect(dateForWeekday("2026-09-29", 2)).toBe("2026-09-29");
    expect(dateForWeekday("2026-09-29", 6)).toBe("2026-10-03");
  });

  it("returns the anchor for an out-of-range weekday", () => {
    expect(dateForWeekday("2026-09-29", 9)).toBe("2026-09-29");
  });
});

describe("minutesFromClock", () => {
  it("converts a wall clock to minutes since midnight", () => {
    expect(minutesFromClock("00:00")).toBe(0);
    expect(minutesFromClock("18:00")).toBe(1080);
    expect(minutesFromClock("23:59")).toBe(1439);
  });

  it("treats the day-ending 24:00 as the very end", () => {
    expect(minutesFromClock("24:00")).toBe(1440);
  });

  it("returns NaN for something unparseable", () => {
    expect(Number.isNaN(minutesFromClock("nope"))).toBe(true);
  });
});

describe("minutesFromInputValue", () => {
  it("reads the time half of a datetime-local value", () => {
    expect(minutesFromInputValue("2026-10-05T19:45")).toBe(19 * 60 + 45);
  });

  it("returns null when there is no time part", () => {
    expect(minutesFromInputValue("2026-10-05")).toBeNull();
  });
});

describe("formatClock", () => {
  it("renders a 12-hour clock", () => {
    expect(formatClock("18:00")).toBe("6:00 PM");
    expect(formatClock("00:30")).toBe("12:30 AM");
    expect(formatClock("12:00")).toBe("12:00 PM");
    expect(formatClock("07:05")).toBe("7:05 AM");
  });

  it("names the end of the day rather than rendering a 24th hour", () => {
    expect(formatClock("24:00")).toBe("midnight");
  });

  it("returns an em dash for something unparseable", () => {
    expect(formatClock("nope")).toBe("—");
  });
});

describe("formatAvailabilityWindow", () => {
  it("joins the two ends with a dash", () => {
    expect(formatAvailabilityWindow({ dayOfWeek: 2, startTime: "18:00", endTime: "23:00" })).toBe(
      "6:00 PM – 11:00 PM",
    );
  });

  it("returns an em dash when either end is unparseable", () => {
    expect(formatAvailabilityWindow({ dayOfWeek: 2, startTime: "x", endTime: "23:00" })).toBe("—");
  });
});

describe("projectAvailabilityWeek", () => {
  it("leaves a window alone when the zone does not change", () => {
    const windows = projectAvailabilityWeek(week({}), NEW_YORK, NEW_YORK, "2026-09-29");

    expect(day(windows, 2)).toBe("6:00 PM – 11:00 PM");
  });

  it("skips a day marked unavailable", () => {
    const windows = projectAvailabilityWeek(
      week({ 1: { off: true }, 2: { off: true } }),
      NEW_YORK,
      NEW_YORK,
      "2026-09-29",
    );

    expect(day(windows, 1)).toBe("");
    expect(day(windows, 2)).toBe("");
  });

  it("shifts the window by the difference between the zones", () => {
    // 19:00-23:00 New York is 00:00-04:00 London. London runs ahead of that
    // wall clock, so the whole window moves onto the next weekday.
    const windows = projectAvailabilityWeek(
      onlyAvailable({ 2: { start: "19:00", end: "23:00" } }),
      NEW_YORK,
      LONDON,
      "2026-09-29",
    );

    expect(day(windows, 2)).toBe("");
    expect(day(windows, 3)).toBe("12:00 AM – 4:00 AM");
  });

  it("splits a window that lands past midnight into two readable parts", () => {
    // 18:00-23:00 New York is 23:00-04:00 London, which straddles midnight in
    // the reader's zone. It must be emitted as two same-day pieces rather than one
    // range that wraps.
    const windows = projectAvailabilityWeek(
      onlyAvailable({ 2: { start: "18:00", end: "23:00" } }),
      NEW_YORK,
      LONDON,
      "2026-09-29",
    );

    expect(windowsForWeekday(windows, 2)).toEqual([
      { dayOfWeek: 2, startTime: "23:00", endTime: "24:00" },
    ]);
    expect(windowsForWeekday(windows, 3)).toEqual([
      { dayOfWeek: 3, startTime: "00:00", endTime: "04:00" },
    ]);
  });

  it("does not emit a zero-length window when one ends exactly at midnight", () => {
    // 19:00-23:00 Chicago is 20:00-00:00 New York, landing exactly on the day
    // boundary. Splitting that would leave an empty "12:00 AM - 12:00 AM" day.
    const windows = projectAvailabilityWeek(
      onlyAvailable({ 2: { start: "19:00", end: "23:00" } }),
      CHICAGO,
      NEW_YORK,
      "2026-09-29",
    );

    expect(day(windows, 2)).toBe("8:00 PM – midnight");
    expect(day(windows, 3)).toBe("");
    for (const window of windows) {
      expect(minutesFromClock(window.endTime)).toBeGreaterThan(
        minutesFromClock(window.startTime),
      );
    }
  });

  it("treats an end at or before the start as running past midnight", () => {
    // 22:00 to 02:00 is an overnight window, not an empty one.
    const windows = projectAvailabilityWeek(
      onlyAvailable({ 2: { start: "22:00", end: "02:00" } }),
      NEW_YORK,
      NEW_YORK,
      "2026-09-29",
    );

    expect(day(windows, 2)).toBe("10:00 PM – midnight");
    expect(day(windows, 3)).toBe("12:00 AM – 2:00 AM");
  });

  it("passes a window through unchanged when its local time does not exist", () => {
    // 02:30 on the spring-forward date never happens in New York, so there is no
    // instant to convert. The day is kept rather than silently dropped.
    const windows = projectAvailabilityWeek(
      onlyAvailable({ 0: { start: "02:30", end: "04:30" } }),
      NEW_YORK,
      TOKYO,
      "2026-03-08",
    );

    expect(day(windows, 0)).toBe("2:30 AM – 4:30 AM");
  });

  it("returns windows ordered by weekday then start time", () => {
    const windows = projectAvailabilityWeek(
      onlyAvailable({
        0: { start: "20:00", end: "22:00" },
        1: { start: "09:00", end: "11:00" },
        2: { start: "14:00", end: "16:00" },
      }),
      NEW_YORK,
      NEW_YORK,
      "2026-09-27",
    );

    expect(windows.map((window) => window.dayOfWeek)).toEqual([0, 1, 2]);
  });
});

describe("windowsForWeekday", () => {
  it("returns only that weekday's windows", () => {
    const windows = projectAvailabilityWeek(
      onlyAvailable({ 4: {} }),
      NEW_YORK,
      NEW_YORK,
      "2026-09-29",
    );

    expect(windowsForWeekday(windows, 4)).toHaveLength(1);
    expect(windowsForWeekday(windows, 6)).toHaveLength(0);
  });
});

describe("availabilityFit", () => {
  // Only Tuesday has a window, so Wednesday is a genuine "never plays" day and
  // "outside" and "unavailable" cannot be confused.
  const windows = projectAvailabilityWeek(
    onlyAvailable({ 2: { start: "18:00", end: "23:00" } }),
    NEW_YORK,
    NEW_YORK,
    "2026-09-29",
  );

  it("reports inside for a time within the window", () => {
    expect(availabilityFit(windows, 2, 19 * 60)).toBe("inside");
  });

  it("treats the opening edge as inclusive", () => {
    expect(availabilityFit(windows, 2, 18 * 60)).toBe("inside");
  });

  it("treats the closing edge as exclusive", () => {
    expect(availabilityFit(windows, 2, 23 * 60)).toBe("outside");
  });

  it("reports outside for a time before the window on an available day", () => {
    expect(availabilityFit(windows, 2, 9 * 60)).toBe("outside");
  });

  it("reports unavailable for a day with no window at all", () => {
    expect(availabilityFit(windows, 3, 12 * 60)).toBe("unavailable");
  });

  it("distinguishes outside from unavailable", () => {
    expect(availabilityFit(windows, 2, 12 * 60)).toBe("outside");
    expect(availabilityFit(windows, 3, 12 * 60)).toBe("unavailable");
  });
});
