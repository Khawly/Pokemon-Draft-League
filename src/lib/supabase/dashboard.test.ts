/*
 * Tests for the dashboard's display helpers.
 *
 * These are what a member reads on the dashboard: when a match is, how old a
 * notification is, what a match's status is called, and which week the season is
 * in. Match times are rendered in the reader's chosen zone, so the formatting
 * takes one explicitly rather than reading the machine's.
 */
import { describe, expect, it } from "vitest";

import {
  DECIDED_MATCH_STATUSES,
  OPEN_MATCH_STATUSES,
  deriveCurrentWeek,
  formatMatchTime,
  formatNotificationAge,
  matchStatusLabel,
  selectCurrentWeekMatches,
  type DashboardMatch,
} from "@/lib/supabase/dashboard";

const NEW_YORK = "America/New_York";
const TOKYO = "Asia/Tokyo";

describe("formatMatchTime", () => {
  it("returns an em dash when there is no time yet", () => {
    // "Unscheduled" is a real state now, and it has no time to show.
    expect(formatMatchTime(null, NEW_YORK)).toBe("");
  });

  it("returns an em dash for an unparseable timestamp", () => {
    expect(formatMatchTime("not-a-date", NEW_YORK)).toBe("");
  });

  it("omits the year for a compact match time", () => {
    const formatted = formatMatchTime("2026-10-05T04:00:00.000Z", NEW_YORK);

    expect(formatted).toContain("Oct 5");
    expect(formatted).toContain("12:00 AM");
    expect(formatted).not.toContain("2026");
  });

  it("renders the same instant differently per zone", () => {
    const iso = "2026-10-05T04:00:00.000Z";

    expect(formatMatchTime(iso, NEW_YORK)).toContain("12:00");
    expect(formatMatchTime(iso, TOKYO)).toContain("1:00");
  });
});

describe("formatNotificationAge", () => {
  /** Builds an ISO timestamp the given number of minutes before now. */
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();

  it("calls anything under a minute 'just now'", () => {
    expect(formatNotificationAge(minutesAgo(0), NEW_YORK)).toBe("just now");
  });

  it("counts minutes up to an hour", () => {
    expect(formatNotificationAge(minutesAgo(5), NEW_YORK)).toBe("5m ago");
    expect(formatNotificationAge(minutesAgo(59), NEW_YORK)).toBe("59m ago");
  });

  it("counts hours up to a day", () => {
    expect(formatNotificationAge(minutesAgo(60), NEW_YORK)).toBe("1h ago");
    expect(formatNotificationAge(minutesAgo(23 * 60), NEW_YORK)).toBe("23h ago");
  });

  it("counts days up to a week", () => {
    expect(formatNotificationAge(minutesAgo(24 * 60), NEW_YORK)).toBe("1d ago");
    expect(formatNotificationAge(minutesAgo(6 * 24 * 60), NEW_YORK)).toBe("6d ago");
  });

  it("falls back to a calendar date in the given zone beyond a week", () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const formatted = formatNotificationAge(old, NEW_YORK);

    expect(formatted).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatNotificationAge("not-a-date", NEW_YORK)).toBe("");
  });
});

describe("matchStatusLabel", () => {
  it("names every status the matchup card can show", () => {
    expect(matchStatusLabel("unscheduled")).toBe("Unscheduled");
    expect(matchStatusLabel("scheduled")).toBe("Scheduled");
    expect(matchStatusLabel("in_progress")).toBe("Live");
    expect(matchStatusLabel("completed")).toBe("Final");
    expect(matchStatusLabel("forfeit")).toBe("Forfeit");
    expect(matchStatusLabel("cancelled")).toBe("Cancelled");
  });
});

/** The match statuses matches_status_check allows, per the schema migration. */
const SCHEMA_STATUSES = [
  "unscheduled",
  "scheduled",
  "in_progress",
  "completed",
  "forfeit",
  "cancelled",
] as const;

describe("match status lists", () => {
  it("partitions the schema's status vocabulary exactly once", () => {
    // The regression this guards: a status was added to the database and to the
    // open list was forgotten in, so a freshly generated schedule (all
    // unscheduled) looked like it had no weeks at all.
    const covered = [...OPEN_MATCH_STATUSES, ...DECIDED_MATCH_STATUSES];
    expect([...covered].sort()).toEqual([...SCHEMA_STATUSES].sort());
  });

  it("keeps unscheduled open, since that is what a generated schedule starts as", () => {
    expect(OPEN_MATCH_STATUSES).toContain("unscheduled");
  });
});

/** Minimal match for the week derivation, which only reads three fields. */
function match(
  week_number: number,
  status: DashboardMatch["status"],
  is_playoff = false,
) {
  return { week_number, status, is_playoff };
}

describe("deriveCurrentWeek", () => {
  it("reports week 1 for a schedule that was just generated", () => {
    // generate_schedule inserts every matchup unscheduled, because the
    // matches_default_unscheduled trigger rewrites a 'scheduled' row that has no
    // scheduled_at. This is the case that used to read as "Schedule not set".
    const matches = [
      match(1, "unscheduled"),
      match(1, "unscheduled"),
      match(2, "unscheduled"),
      match(2, "unscheduled"),
    ];
    expect(deriveCurrentWeek(matches)).toBe(1);
  });

  it("advances past a week whose matches are all decided", () => {
    const matches = [
      match(1, "completed"),
      match(1, "completed"),
      match(2, "unscheduled"),
      match(3, "unscheduled"),
    ];
    expect(deriveCurrentWeek(matches)).toBe(2);
  });

  it("counts a forfeit as decided", () => {
    const matches = [match(1, "forfeit"), match(2, "scheduled")];
    expect(deriveCurrentWeek(matches)).toBe(2);
  });

  it("counts a cancelled match as decided", () => {
    const matches = [match(1, "cancelled"), match(2, "in_progress")];
    expect(deriveCurrentWeek(matches)).toBe(2);
  });

  it("returns null once every regular match is decided", () => {
    const matches = [
      match(1, "completed"),
      match(2, "forfeit"),
      match(3, "cancelled"),
    ];
    expect(deriveCurrentWeek(matches)).toBeNull();
  });

  it("returns null when the league has no schedule yet", () => {
    expect(deriveCurrentWeek([])).toBeNull();
  });

  it("ignores playoff rounds, which never decide a regular-season week", () => {
    // A live bracket with every regular match already decided is postseason, not
    // "week 5".
    const matches = [
      match(1, "completed"),
      match(2, "completed"),
      match(5, "scheduled", true),
      match(5, "scheduled", true),
    ];
    expect(deriveCurrentWeek(matches)).toBeNull();
  });

  it("does not let an out-of-order payload report the wrong week", () => {
    // The payload is ordered by overall_pick in a snake draft, so week 4 can
    // arrive before week 1.
    const matches = [match(4, "scheduled"), match(1, "scheduled"), match(3, "scheduled")];
    expect(deriveCurrentWeek(matches)).toBe(1);
  });
});

/** A fixture match; selectCurrentWeekMatches only reads the week number. */
function weekMatch(id: string, week_number: number, is_playoff = false) {
  return { id, week_number, is_playoff } as unknown as DashboardMatch;
}

describe("selectCurrentWeekMatches", () => {
  it("shows only the current week's matchups", () => {
    const open = [
      weekMatch("w1a", 1),
      weekMatch("w1b", 1),
      weekMatch("w2a", 2),
      weekMatch("w2b", 2),
      weekMatch("w3a", 3),
    ];

    const shown = selectCurrentWeekMatches(open, 2);

    expect(shown.map((match) => match.id)).toEqual(["w2a", "w2b"]);
  });

  it("keeps the whole week, not a capped preview", () => {
    // The panel used to slice the list to three, which hid the rest of a large
    // league's week behind a scroll the member could not reason about.
    const open = Array.from({ length: 9 }, (_, i) => weekMatch(`m${i}`, 4));

    expect(selectCurrentWeekMatches(open, 4)).toHaveLength(9);
  });

  it("returns everything once the regular season is over, so playoffs still show", () => {
    const open = [
      weekMatch("gf", 9, true),
      weekMatch("upper", 7, true),
    ];

    expect(selectCurrentWeekMatches(open, null)).toEqual(open);
  });

  it("returns nothing when the current week has no open matchups left", () => {
    expect(selectCurrentWeekMatches([weekMatch("w1a", 1)], 3)).toEqual([]);
  });

  it("preserves the order it was given, so the panel's sorting is not undone", () => {
    const open = [weekMatch("late", 2), weekMatch("early", 2)];

    expect(selectCurrentWeekMatches(open, 2).map((m) => m.id)).toEqual([
      "late",
      "early",
    ]);
  });
});
