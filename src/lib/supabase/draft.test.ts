/*
 * Tests for the draft arena's pure helpers.
 *
 * The quiet hours resolver is the one with real branching here: it has to
 * re-label stored wall clocks into a reader's zone without ever letting the
 * reader's own clock decide whether the draft is currently held, because that
 * decision belongs to the database in the league's stored zone.
 */

import { describe, expect, it } from "vitest";

import { resolveQuietHours, type DraftGoods } from "@/lib/supabase/draft";

/**
 * Builds the smallest draft payload the resolver reads.
 *
 * Only `settings.quiet_hours_*` is touched by resolveQuietHours, so the rest is
 * filled with inert values rather than a full fixture.
 */
function makeGoods(
  quietHours: {
    enabled?: boolean;
    start?: string | null;
    end?: string | null;
    timeZone?: string | null;
  } = {},
): DraftGoods {
  return {
    league: { id: "league-1", name: "Test", owner_id: "owner-1", number_of_players: 8 },
    season: null,
    settings: {
      draft_format: "snake",
      total_rounds: 20,
      enable_pokemon_costs: true,
      total_token_salary: 33,
      allow_per_team_salary: false,
      pick_time_limit_minutes: 5,
      auto_pick_on_timeout: false,
      skip_player_on_timeout: false,
      quiet_hours_enabled: quietHours.enabled ?? false,
      quiet_hours_start: quietHours.start ?? null,
      quiet_hours_end: quietHours.end ?? null,
      quiet_hours_timezone: quietHours.timeZone ?? null,
    },
    members: [],
    teams: [],
    picks: [],
    poolRows: [],
    priority: [],
    spentByTeam: new Map<string, number>(),
    roundFlags: new Map<number, { autoPick: boolean; skipPick: boolean }>(),
    currentUserId: "user-1",
    userRole: "member",
    myTeamId: null,
  } as DraftGoods;
}

/**
 * Builds an instant whose wall clock in `zone` is the given time.
 *
 * Constructed by trial from a fixed date rather than parsed, because the point of
 * each case is a specific local wall clock and searching for it sidesteps any
 * ambiguity about which side of a DST boundary it falls on.
 */
function instantAtLocal(zone: string, hour: number, minute: number): Date {
  for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const probe = new Date(Date.UTC(2026, 5, 15 + dayOffset, 0, minutes));
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(probe);
      const h = Number(parts.find((p) => p.type === "hour")?.value);
      const m = Number(parts.find((p) => p.type === "minute")?.value);
      if (h % 24 === hour && m === minute) {
        return probe;
      }
    }
  }
  throw new Error(`no probe found for ${hour}:${minute} in ${zone}`);
}

describe("resolveQuietHours", () => {
  it("reports nothing when the league has quiet hours switched off", () => {
    const window = resolveQuietHours(
      makeGoods({ start: "20:00", end: "09:00", timeZone: "UTC" }),
      "UTC",
    );

    expect(window.enabled).toBe(false);
    expect(window.label).toBeNull();
    expect(window.activeNow).toBe(false);
  });

  it("reads nothing when the clocks were never saved", () => {
    // Enabled with null clocks is the state a league is left in if the columns are
    // set but the times are not; showing a window would invent one.
    const window = resolveQuietHours(
      makeGoods({ enabled: true, start: null, end: null, timeZone: "UTC" }),
      "UTC",
    );

    expect(window.enabled).toBe(false);
  });

  it("treats equal bounds as off rather than a 24 hour window", () => {
    // Matches the database helper, which reads equal bounds as "never quiet"; a
    // 24-hour window would hold the draft forever on a typo.
    const window = resolveQuietHours(
      makeGoods({ enabled: true, start: "09:00", end: "09:00", timeZone: "UTC" }),
      "UTC",
    );

    expect(window.enabled).toBe(false);
  });

  it("labels a window that wraps past midnight", () => {
    const window = resolveQuietHours(
      makeGoods({ enabled: true, start: "20:00", end: "09:00", timeZone: "UTC" }),
      "UTC",
    );

    expect(window.enabled).toBe(true);
    expect(window.label).toBe("8:00 PM – 9:00 AM");
  });

  it("is inside a wrapping window late at night and again before dawn", () => {
    const goods = makeGoods({
      enabled: true,
      start: "20:00",
      end: "09:00",
      timeZone: "UTC",
    });

    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 23, 0)).activeNow).toBe(true);
    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 2, 0)).activeNow).toBe(true);
  });

  it("is outside a wrapping window during the day", () => {
    const goods = makeGoods({
      enabled: true,
      start: "20:00",
      end: "09:00",
      timeZone: "UTC",
    });

    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 12, 0)).activeNow).toBe(false);
    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 9, 0)).activeNow).toBe(false);
    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 20, 0)).activeNow).toBe(true);
  });

  it("handles a window that sits inside a single day", () => {
    const goods = makeGoods({
      enabled: true,
      start: "09:00",
      end: "17:00",
      timeZone: "UTC",
    });

    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 12, 0)).activeNow).toBe(true);
    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 20, 0)).activeNow).toBe(false);
    expect(resolveQuietHours(goods, "UTC", instantAtLocal("UTC", 8, 0)).activeNow).toBe(false);
  });

  it("relabels the window into the reader's zone", () => {
    /*
     * Stored as 20:00-09:00 in UTC, which is a 9am-10pm window in New York. The
     * label has to follow the reader or the board tells them the wrong hours.
     */
    const window = resolveQuietHours(
      makeGoods({ enabled: true, start: "20:00", end: "09:00", timeZone: "UTC" }),
      "America/New_York",
    );

    expect(window.label).toBe("4:00 PM – 5:00 AM");
  });

  it("decides activeNow in the stored zone, not the reader's", () => {
    /*
     * 02:00 in UTC is 21:00 the previous evening in New York, so the reader would
     * say the window has not opened yet. The database compares in the stored zone,
     * and the panel has to agree with it or the header contradicts the engine.
     */
    const goods = makeGoods({
      enabled: true,
      start: "20:00",
      end: "09:00",
      timeZone: "UTC",
    });
    const now = instantAtLocal("UTC", 2, 0);

    expect(resolveQuietHours(goods, "UTC", now).activeNow).toBe(true);
    expect(resolveQuietHours(goods, "America/New_York", now).activeNow).toBe(true);
  });
});