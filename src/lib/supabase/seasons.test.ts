/*
 * Tests for the season helpers' pure logic.
 *
 * The roster-change window is shared by free agent pickups and roster drops, so
 * the boundary between "the owner may work while the season is pending" and
 * "nobody may touch a roster mid-draft" is worth pinning down here rather than
 * relying on each page's inline condition.
 */
import { describe, expect, it } from "vitest";

import { rosterChangesOpen } from "@/lib/supabase/seasons";

describe("rosterChangesOpen", () => {
  it("opens for members once the draft is complete", () => {
    expect(rosterChangesOpen("draft_complete", false)).toBe(true);
  });

  it("opens for owners before the draft begins", () => {
    // The owner pre-assigns or fixes rosters while the season is still pending.
    expect(rosterChangesOpen("draft_pending", true)).toBe(true);
  });

  it("keeps members locked while the draft is pending", () => {
    expect(rosterChangesOpen("draft_pending", false)).toBe(false);
  });

  it("stays closed during the draft for everyone", () => {
    // A pickup or drop here would race the draft engine for the same pool.
    expect(rosterChangesOpen("draft_active", true)).toBe(false);
    expect(rosterChangesOpen("draft_active", false)).toBe(false);
  });

  it("stays closed for archived seasons and when no season exists", () => {
    expect(rosterChangesOpen("archived", true)).toBe(false);
    expect(rosterChangesOpen(null, true)).toBe(false);
    expect(rosterChangesOpen(undefined, true)).toBe(false);
  });
});
