/*
 * Tests for the league sub-navigation's route metadata.
 *
 * The tab list is shared by the global sub-navigation and the dashboard's own
 * links, so a duplicate slug or a missing league id would send two different
 * surfaces to the same wrong place.
 */
import { describe, expect, it } from "vitest";

import { LEAGUE_TABS, routeFor } from "@/lib/league-routes";

describe("routeFor", () => {
  it("attaches the selected league as a query parameter", () => {
    expect(routeFor("teams", "league-1")).toBe("/teams?leagueId=league-1");
  });

  it("falls back to the bare route without a league", () => {
    expect(routeFor("teams", null)).toBe("/teams");
    expect(routeFor("teams")).toBe("/teams");
  });
});

describe("LEAGUE_TABS", () => {
  it("leads with the dashboard", () => {
    expect(LEAGUE_TABS[0]).toEqual({ label: "Dashboard", slug: "dashboard" });
  });

  it("has a unique slug for every tab", () => {
    const slugs = LEAGUE_TABS.map((tab) => tab.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("covers every league page the sub-navigation offers", () => {
    expect(LEAGUE_TABS.map((tab) => tab.slug)).toEqual([
      "dashboard",
      "draftboard",
      "teams",
      "pokemon",
      "schedule",
      "trades",
      "rules",
      "hall-of-fame",
    ]);
  });
});
