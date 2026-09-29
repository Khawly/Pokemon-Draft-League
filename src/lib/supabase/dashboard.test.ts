/*
 * Tests for the dashboard's display helpers.
 *
 * These are what a member reads on the dashboard: when a match is, how old a
 * notification is, and what a match's status is called. Match times are rendered
 * in the reader's chosen zone, so the formatting takes one explicitly rather than
 * reading the machine's.
 */
import { describe, expect, it } from "vitest";

import {
  formatMatchTime,
  formatNotificationAge,
  matchStatusLabel,
} from "@/lib/supabase/dashboard";

const NEW_YORK = "America/New_York";
const TOKYO = "Asia/Tokyo";

describe("formatMatchTime", () => {
  it("returns an em dash when there is no time yet", () => {
    // "Unscheduled" is a real state now, and it has no time to show.
    expect(formatMatchTime(null, NEW_YORK)).toBe("—");
  });

  it("returns an em dash for an unparseable timestamp", () => {
    expect(formatMatchTime("not-a-date", NEW_YORK)).toBe("—");
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
