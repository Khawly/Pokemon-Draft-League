/*
 * Tests for the time zone helpers.
 *
 * These guard the conversions the whole app's timestamps depend on. The cases that
 * matter are the awkward ones: a local time that does not exist because the clocks
 * went forward, an ambiguous time that happens twice when they go back, and an
 * instant that renders as a different calendar day on the other side of the world.
 */
import { describe, expect, it } from "vitest";

import {
  browserTimeZone,
  datePartOfInputValue,
  formatDateTimeInZone,
  formatInTimeZone,
  formatTimeZoneLabel,
  fromZonedInputValue,
  listTimeZones,
  timePartOfInputValue,
  timeZoneAcronym,
  timeZoneOffsetLabel,
  toZonedInputValue,
  toZonedParts,
  todayInZone,
  withInputValueDate,
  withInputValueTime,
  zonedTimeToInstant,
} from "@/lib/datetime";

/** New York is UTC-4 in summer and UTC-5 in winter, which is what makes it useful. */
const NEW_YORK = "America/New_York";
/** London is UTC+1 in summer and UTC in winter. */
const LONDON = "Europe/London";
/** Tokyo has no daylight saving, so it is a fixed +9. */
const TOKYO = "Asia/Tokyo";

describe("toZonedParts", () => {
  it("splits an instant into the local date and 24-hour time of a zone", () => {
    // 2026-07-01T02:30Z is 2026-06-30 22:30 in New York, the previous day.
    const parts = toZonedParts(new Date("2026-07-01T02:30:00Z"), NEW_YORK);

    expect(parts).toEqual({ date: "2026-06-30", time: "22:30" });
  });

  it("renders midnight as 00:00 rather than 24:00", () => {
    // 2026-07-01T04:00Z is exactly midnight in New York.
    expect(toZonedParts(new Date("2026-07-01T04:00:00Z"), NEW_YORK)).toEqual({
      date: "2026-07-01",
      time: "00:00",
    });
  });

  it("pads single-digit months, days, hours, and minutes", () => {
    const parts = toZonedParts(new Date("2026-01-05T05:07:00Z"), TOKYO);

    expect(parts?.date).toBe("2026-01-05");
    expect(parts?.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("returns null for a zone the runtime does not know", () => {
    expect(toZonedParts(new Date(), "Not/AZone")).toBeNull();
  });
});

describe("zonedTimeToInstant", () => {
  it("resolves a local wall clock to the right instant", () => {
    // 19:00 in New York during summer is 23:00 UTC.
    const instant = zonedTimeToInstant("2026-07-01", "19:00", NEW_YORK);

    expect(instant?.toISOString()).toBe("2026-07-01T23:00:00.000Z");
  });

  it("follows the zone through a daylight saving change", () => {
    // The same wall clock is a different instant either side of the transition,
    // which is the whole reason a bare local-time conversion is wrong.
    const summer = zonedTimeToInstant("2026-07-01", "12:00", NEW_YORK);
    const winter = zonedTimeToInstant("2026-01-01", "12:00", NEW_YORK);

    expect(summer?.toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(winter?.toISOString()).toBe("2026-01-01T17:00:00.000Z");
  });

  it("rejects a local time that does not exist because the clocks went forward", () => {
    // 2026-03-08 02:30 does not happen in New York; the clock jumps 02:00 -> 03:00.
    expect(zonedTimeToInstant("2026-03-08", "02:30", NEW_YORK)).toBeNull();
  });

  it("resolves an ambiguous time to its first occurrence", () => {
    // 2026-11-01 01:30 happens twice in New York; the earlier one is chosen.
    const instant = zonedTimeToInstant("2026-11-01", "01:30", NEW_YORK);

    expect(instant?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rejects out-of-range components", () => {
    expect(zonedTimeToInstant("2026-13-01", "12:00", UTC)).toBeNull();
    expect(zonedTimeToInstant("2026-01-01", "24:00", UTC)).toBeNull();
    expect(zonedTimeToInstant("2026-01-01", "12:60", UTC)).toBeNull();
  });

  it("rejects a zone the runtime does not know", () => {
    expect(zonedTimeToInstant("2026-01-01", "12:00", "Not/AZone")).toBeNull();
  });
});

/** UTC is spelled out here so the intent of the arithmetic is obvious. */
const UTC = "UTC";

describe("the instant round trip", () => {
  const instant = new Date("2026-07-01T02:30:00Z");

  for (const zone of [UTC, NEW_YORK, LONDON, TOKYO]) {
    it(`survives a round trip through ${zone}`, () => {
      const input = toZonedInputValue(instant.toISOString(), zone);
      const back = fromZonedInputValue(input, zone);

      expect(back).toBe(instant.toISOString());
    });
  }

  it("produces the same wall clock the zone's own formatter reports", () => {
    const input = toZonedInputValue(instant.toISOString(), NEW_YORK);
    const parts = toZonedParts(instant, NEW_YORK);

    expect(input).toBe(`${parts?.date}T${parts?.time}`);
  });
});

describe("toZonedInputValue", () => {
  it("returns an empty string for null", () => {
    expect(toZonedInputValue(null, UTC)).toBe("");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(toZonedInputValue("not-a-date", UTC)).toBe("");
  });

  it("uses the target zone, not the machine's", () => {
    // The same instant is a different wall clock in each zone.
    const iso = "2026-10-05T04:00:00.000Z";

    expect(toZonedInputValue(iso, NEW_YORK)).toBe("2026-10-05T00:00");
    expect(toZonedInputValue(iso, TOKYO)).toBe("2026-10-05T13:00");
    expect(toZonedInputValue(iso, UTC)).toBe("2026-10-05T04:00");
  });
});

describe("fromZonedInputValue", () => {
  it("returns null for an empty or malformed value", () => {
    expect(fromZonedInputValue("", UTC)).toBeNull();
    expect(fromZonedInputValue("2026-01-01", UTC)).toBeNull();
  });

  it("returns null for a local time in a daylight saving gap", () => {
    expect(fromZonedInputValue("2026-03-08T02:30", NEW_YORK)).toBeNull();
  });
});

describe("timeZoneAcronym", () => {
  it("describes a zero offset as plain GMT", () => {
    expect(timeZoneAcronym(UTC)).toBe("GMT");
  });

  it("leaves whole hours unpadded", () => {
    expect(timeZoneAcronym(NEW_YORK)).toBe("GMT-4");
    expect(timeZoneAcronym(LONDON)).toBe("GMT+1");
    expect(timeZoneAcronym(TOKYO)).toBe("GMT+9");
  });

  it("keeps the minutes for a half-hour zone", () => {
    expect(timeZoneAcronym("Asia/Kolkata")).toBe("GMT+5:30");
  });

  it("reflects daylight saving, so the same zone can read either way", () => {
    // January and July are on opposite sides of the New York transition.
    const winter = timeZoneAcronymAt("2026-01-15T12:00:00Z", NEW_YORK);
    const summer = timeZoneAcronymAt("2026-07-15T12:00:00Z", NEW_YORK);

    expect(winter).toBe("GMT-5");
    expect(summer).toBe("GMT-4");
  });

  it("returns an empty string for an unknown zone", () => {
    expect(timeZoneAcronym("Not/AZone")).toBe("");
  });
});

/**
 * Reads an acronym at a specific instant.
 *
 * `timeZoneAcronym` reports the offset in effect now, which is right for a label
 * next to a live clock but untestable across a transition. This re-implements the
 * same arithmetic against a chosen instant so the transition can be checked.
 *
 * @param instantIso - The instant to read the offset at.
 * @param zone - IANA time zone to describe.
 * @returns The acronym at that instant.
 */
function timeZoneAcronymAt(instantIso: string, zone: string): string {
  const parts = toZonedParts(new Date(instantIso), zone);
  const wallClock = Date.UTC(
    Number(parts?.date.slice(0, 4)),
    Number(parts?.date.slice(5, 7)) - 1,
    Number(parts?.date.slice(8, 10)),
    Number(parts?.time.slice(0, 2)),
    Number(parts?.time.slice(3, 5)),
  );
  const offsetMinutes = (wallClock - new Date(instantIso).getTime()) / 60_000;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;

  return minutes === 0
    ? `GMT${sign}${hours}`
    : `GMT${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

describe("timeZoneOffsetLabel", () => {
  it("reports a padded UTC offset", () => {
    expect(timeZoneOffsetLabel(UTC)).toBe("UTC+00:00");
    expect(timeZoneOffsetLabel(NEW_YORK)).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
  });

  it("returns an empty string for an unknown zone", () => {
    expect(timeZoneOffsetLabel("Not/AZone")).toBe("");
  });
});

describe("formatTimeZoneLabel", () => {
  it("combines the identifier with its acronym", () => {
    expect(formatTimeZoneLabel("Asia/Tokyo")).toBe("Asia/Tokyo (GMT+9)");
  });

  it("falls back to the bare identifier for an unknown zone", () => {
    expect(formatTimeZoneLabel("Not/AZone")).toBe("Not/AZone");
  });

  it("falls back to the bare identifier for an empty zone", () => {
    expect(formatTimeZoneLabel("")).toBe("");
  });
});

describe("formatDateTimeInZone", () => {
  it("renders the same instant differently per zone", () => {
    const iso = "2026-10-05T04:00:00.000Z";

    const ny = formatDateTimeInZone(iso, NEW_YORK);
    const tokyo = formatDateTimeInZone(iso, TOKYO);

    expect(ny).toContain("Oct 5");
    expect(ny).toContain("12:00");
    expect(tokyo).toContain("1:00");
  });

  it("returns an em dash for null and unparseable input", () => {
    expect(formatDateTimeInZone(null, UTC)).toBe("—");
    expect(formatDateTimeInZone("not-a-date", UTC)).toBe("—");
  });
});

describe("formatInTimeZone", () => {
  it("includes the zone's short name so a date reads unambiguously", () => {
    const formatted = formatInTimeZone(
      new Date("2026-10-05T04:00:00Z"),
      NEW_YORK,
    );

    expect(formatted).toMatch(/Oct 5, 2026/);
    expect(formatted).toMatch(/EDT|GMT/);
  });

  it("falls back to ISO for an unknown zone rather than throwing", () => {
    expect(formatInTimeZone(new Date("2026-10-05T04:00:00Z"), "Not/AZone")).toBe(
      "2026-10-05T04:00:00.000Z",
    );
  });
});

describe("listTimeZones", () => {
  it("returns a sorted, non-empty list containing UTC", () => {
    const zones = listTimeZones();

    expect(zones.length).toBeGreaterThan(0);
    expect(zones).toContain("UTC");
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
  });
});

describe("browserTimeZone", () => {
  it("returns a usable zone rather than throwing", () => {
    expect(typeof browserTimeZone()).toBe("string");
    expect(browserTimeZone().length).toBeGreaterThan(0);
  });
});

describe("input value halves", () => {
  it("reads the date and time back out of a complete value", () => {
    expect(datePartOfInputValue("2026-07-01T19:30")).toBe("2026-07-01");
    expect(timePartOfInputValue("2026-07-01T19:30")).toBe("19:30");
  });

  it("returns an empty half when only the other one is set", () => {
    // The date-only default is a real state: the form opens on today with no time
    // chosen yet, and the time input must read as empty rather than "undefined".
    expect(datePartOfInputValue("2026-07-01")).toBe("2026-07-01");
    expect(timePartOfInputValue("2026-07-01")).toBe("");
  });

  it("trims seconds so a value with them still yields HH:MM", () => {
    expect(timePartOfInputValue("2026-07-01T19:30:00")).toBe("19:30");
  });

  it("handles an empty value without throwing", () => {
    expect(datePartOfInputValue("")).toBe("");
    expect(timePartOfInputValue("")).toBe("");
  });
});

describe("withInputValueDate", () => {
  it("swaps the date and keeps the time", () => {
    expect(withInputValueDate("2026-07-01T19:30", "2026-07-08")).toBe(
      "2026-07-08T19:30",
    );
  });

  it("keeps a date-only value date-only", () => {
    expect(withInputValueDate("2026-07-01", "2026-07-08")).toBe("2026-07-08");
  });

  it("clears everything when the date input is emptied", () => {
    // Keeping the time here would silently propose the time on a hidden date.
    expect(withInputValueDate("2026-07-01T19:30", "")).toBe("");
  });
});

describe("withInputValueTime", () => {
  it("swaps the time and keeps the date", () => {
    expect(withInputValueTime("2026-07-01T19:30", "20:00")).toBe(
      "2026-07-01T20:00",
    );
  });

  it("holds a time that has no date yet rather than dropping it", () => {
    // The date default arrives on its own, so the time half is edited first here.
    expect(withInputValueTime("", "20:00")).toBe("20:00");
    expect(withInputValueTime("2026-07-01", "20:00")).toBe("2026-07-01T20:00");
  });

  it("clears everything when the time input is emptied", () => {
    // Same reason as the date: a cleared time must not fall back to an old one.
    expect(withInputValueTime("2026-07-01T19:30", "")).toBe("");
  });
});

describe("todayInZone", () => {
  it("returns the calendar day in the given zone, not the device's", () => {
    // 02:30Z is still the previous evening in New York, and already tomorrow in
    // Tokyo. A default built from the device clock would be wrong in both.
    const instant = new Date("2026-07-01T02:30:00Z");

    expect(todayInZone(NEW_YORK, instant)).toBe("2026-06-30");
    expect(todayInZone(TOKYO, instant)).toBe("2026-07-01");
  });

  it("agrees with the date half of the same value's zoned input", () => {
    const instant = new Date("2026-12-31T23:45:00Z");

    expect(todayInZone(LONDON, instant)).toBe(
      datePartOfInputValue(toZonedInputValue(instant.toISOString(), LONDON)),
    );
  });

  it("returns an empty string for an unknown zone rather than today's date", () => {
    // Falling back to the device's day here would hide a broken zone setting.
    expect(todayInZone("Not/AZone")).toBe("");
  });
});

describe("formatDateTimeInZone with an explicit format", () => {
  const LOG_FORMAT: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };

  it("labels the value with the zone's region abbreviation", () => {
    // 21:00Z is 5pm in New York, and a bare wall clock does not say which 5pm it
    // is, which is the whole reason the owner log asks for the zone name.
    const formatted = formatDateTimeInZone(
      "2026-07-01T21:00:00.000Z",
      NEW_YORK,
      LOG_FORMAT,
    );

    expect(formatted).toContain("EDT");
  });

  it("falls back to a GMT offset for a zone with no region abbreviation", () => {
    // Intl handles this itself, so the log does not need a table of its own.
    expect(
      formatDateTimeInZone("2026-07-01T21:00:00.000Z", LONDON, LOG_FORMAT),
    ).toMatch(/GMT\+1/);
  });

  it("uses the locale's clock rather than forcing 24-hour", () => {
    // The rest of the app renders 5:00 PM, so a log showing 17:00 reads as a
    // different app's timestamp rather than the same moment.
    const formatted = formatDateTimeInZone(
      "2026-07-01T21:00:00.000Z",
      NEW_YORK,
      LOG_FORMAT,
    );

    expect(formatted).not.toMatch(/\b17:00\b/);
  });

  it("converts across the day boundary rather than relabelling the text", () => {
    // 03:00Z is 11pm on the previous day in New York. A formatter that ignored
    // the zone would print Jul 1 and be a whole day out.
    const formatted = formatDateTimeInZone(
      "2026-07-01T03:00:00.000Z",
      NEW_YORK,
      LOG_FORMAT,
    );

    expect(formatted).toContain("Jun 30");
    expect(formatted).toContain("EDT");
  });

  it("keeps separate cache entries per format so the default is never reused", () => {
    // Both formats share a zone, so this is where a wrong cache key would hand
    // the log the page's shorter shape, or the page a log line with a zone name.
    const withZone = formatDateTimeInZone(
      "2026-07-01T21:00:00.000Z",
      NEW_YORK,
      LOG_FORMAT,
    );
    const without = formatDateTimeInZone("2026-07-01T21:00:00.000Z", NEW_YORK);

    expect(withZone).toContain("EDT");
    expect(without).not.toContain("EDT");
    expect(without).not.toContain("Wednesday");
  });

  it("returns an em dash for a zone Intl cannot use instead of throwing", () => {
    // A corrupt timezone on a profile should cost one label, not the whole page.
    expect(formatDateTimeInZone("2026-07-01T21:00:00.000Z", "Not/AZone")).toBe(
      "—",
    );
  });
});
