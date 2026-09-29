/*
 * Tests for the weekly deadline helpers.
 *
 * The deadline recurs on a wall clock in a fixed time zone, so the arithmetic that
 * finds "the next one" is calendar maths rather than simple date addition and has
 * to stay correct across a daylight saving boundary. The forfeit differential is
 * pure scoring and is pinned because it decides a league's standings.
 */
import { describe, expect, it } from "vitest";

import {
  doubleForfeitDifferential,
  nextDeadlineInstant,
  type WeekDeadlineSettings,
} from "@/lib/supabase/week-deadline";

const NEW_YORK = "America/New_York";

/**
 * Builds deadline settings with the anchor and clock the tests need.
 *
 * @param anchorDate - The first deadline, as `YYYY-MM-DD`.
 * @param time - The local `HH:MM` each deadline falls at.
 * @returns Settings for `nextDeadlineInstant`.
 */
function settings(anchorDate: string, time = "20:00"): WeekDeadlineSettings {
  return {
    league_format: "6v6",
    match_format: "best_of_3",
    week_deadline_enabled: true,
    week_deadline_anchor_date: anchorDate,
    week_deadline_time: time,
    week_deadline_timezone: NEW_YORK,
    week_deadline_paused: false,
    week_deadline_paused_at: null,
    week_deadline_last_advanced_at: null,
    week_deadline_settled_matches: 0,
    current_week: 1,
    regular_season_weeks: 5,
    regular_season_completed_at: null,
  };
}

describe("doubleForfeitDifferential", () => {
  it("charges a 6v6 single game as six Pokémon", () => {
    expect(doubleForfeitDifferential("6v6", "single")).toBe(-6);
  });

  it("charges a 6v6 best of three as two games of six", () => {
    expect(doubleForfeitDifferential("6v6", "best_of_3")).toBe(-12);
  });

  it("scales down for a 4v4 league", () => {
    expect(doubleForfeitDifferential("4v4", "single")).toBe(-4);
    expect(doubleForfeitDifferential("4v4", "best_of_3")).toBe(-8);
  });

  it("is always negative, since it is a penalty", () => {
    for (const leagueFormat of ["6v6", "4v4"] as const) {
      for (const matchFormat of ["single", "best_of_3"] as const) {
        expect(doubleForfeitDifferential(leagueFormat, matchFormat)).toBeLessThan(0);
      }
    }
  });
});

describe("nextDeadlineInstant", () => {
  it("returns null when no first date is configured", () => {
    expect(nextDeadlineInstant(settings(""), new Date("2026-07-01T12:00:00Z"))).toBeNull();
  });

  it("returns the anchor itself while it is still ahead", () => {
    // The anchor is a Monday, and "now" is the Friday before it.
    const next = nextDeadlineInstant(
      settings("2026-07-06", "20:00"),
      new Date("2026-07-03T12:00:00Z"),
    );

    expect(next?.toISOString()).toBe("2026-07-07T00:00:00.000Z");
  });

  it("advances by whole weeks once the anchor has passed", () => {
    // The anchor week has gone, so the next one is the following Monday.
    const next = nextDeadlineInstant(
      settings("2026-07-06", "20:00"),
      new Date("2026-07-08T12:00:00Z"),
    );

    expect(next?.toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });

  it("always returns an instant in the future", () => {
    const now = new Date("2026-07-09T12:00:00Z");

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = nextDeadlineInstant(settings("2026-07-06", "20:00"), now);

      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(now.getTime());
      // At most a week away, never sooner.
      expect(next!.getTime() - now.getTime()).toBeLessThanOrEqual(7 * 86_400_000);
    }
  });

  it("keeps the local clock time across a daylight saving change", () => {
    /*
     * The deadline recurs at 20:00 local. New York leaves daylight saving on
     * 2026-11-01, so the UTC instant of the 20:00 deadline shifts by an hour
     * across that boundary even though the local time never moves.
     */
    const beforeChange = nextDeadlineInstant(
      settings("2026-10-05", "20:00"),
      new Date("2026-10-20T12:00:00Z"),
    );
    const afterChange = nextDeadlineInstant(
      settings("2026-10-05", "20:00"),
      new Date("2026-10-29T12:00:00Z"),
    );

    // The 20:00 deadline on 2026-10-26 is still EDT, which is 00:00 UTC the next
    // day. That deadline is the next one after the chosen "now".
    expect(beforeChange?.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    // 20:00 on 2026-11-02 is EST by then, which is 01:00 UTC the next day.
    expect(afterChange?.toISOString()).toBe("2026-11-03T01:00:00.000Z");
  });
});
