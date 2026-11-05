/*
 * Unit tests for the matchup prediction lock.
 *
 * The rule decides whether the card offers the picker, and the database enforces
 * the same boundaries. These tests pin the boundaries so the two cannot drift.
 */
import { describe, expect, it } from "vitest";

import {
  predictionIsOpen,
  predictionLockReason,
  type PredictionMatch,
} from "@/lib/predictions";

/** A scheduled match kicking off in the future. */
const MATCH: PredictionMatch = {
  status: "scheduled",
  scheduled_at: "2026-01-10T18:00:00.000Z",
  player_2_team_id: "team-2",
  results: [],
};

/** The instant used as "now" in the tests, before the kickoff above. */
const BEFORE = new Date("2026-01-10T17:59:59.000Z");

describe("predictionLockReason", () => {
  it("stays open before the scheduled time", () => {
    expect(predictionLockReason(MATCH, BEFORE)).toBeNull();
    expect(predictionIsOpen(MATCH, BEFORE)).toBe(true);
  });

  it("closes at the scheduled time", () => {
    expect(
      predictionLockReason(MATCH, new Date("2026-01-10T18:00:00.000Z")),
    ).toBe("time");
  });

  it("closes as soon as a game result exists", () => {
    expect(
      predictionLockReason({ ...MATCH, results: [{}] }, BEFORE),
    ).toBe("result");
  });

  it("closes once a match is in progress", () => {
    expect(
      predictionLockReason({ ...MATCH, status: "in_progress" }, BEFORE),
    ).toBe("result");
  });

  it("closes a completed or forfeited match", () => {
    expect(
      predictionLockReason({ ...MATCH, status: "completed" }, BEFORE),
    ).toBe("closed");
    expect(
      predictionLockReason({ ...MATCH, status: "forfeit" }, BEFORE),
    ).toBe("closed");
  });

  it("stays open without an agreed time until a result lands", () => {
    expect(
      predictionIsOpen(
        { ...MATCH, status: "unscheduled", scheduled_at: null },
        BEFORE,
      ),
    ).toBe(true);
  });

  it("refuses a bye with no second team", () => {
    expect(
      predictionLockReason({ ...MATCH, player_2_team_id: null }, BEFORE),
    ).toBe("bye");
  });
});
