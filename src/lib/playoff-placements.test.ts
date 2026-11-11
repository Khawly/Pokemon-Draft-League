/*
 * Tests for playoff placement reconstruction.
 *
 * These pin the rule the E4 badge depends on: a team's final elimination decides
 * its finish, and same-round ties are broken by regular-season seed rather than
 * by bracket slot order.
 */
import { describe, expect, it } from "vitest";
import { computePlayoffPlacements, type PlayoffPlacementMatch } from "./playoff-placements";

/** Builds a settled playoff match with the given winner. */
function match(
  week: number,
  first: string,
  second: string | null,
  winner: string | null,
  phase: PlayoffPlacementMatch["bracket_phase"] = "upper",
  status = "completed",
): PlayoffPlacementMatch {
  return {
    week_number: week,
    bracket_phase: phase,
    bracket_slot: null,
    status,
    winner_team_id: winner,
    player_1_team_id: first,
    player_2_team_id: second,
  };
}

describe("computePlayoffPlacements", () => {
  it("places a single-elimination bracket from champion down", () => {
    const placements = computePlayoffPlacements({
      format: "single_elimination",
      championTeamId: "a",
      standingsOrder: ["a", "b", "c", "d", "e", "f", "g", "h"],
      matches: [
        // Quarterfinals, all in week 1.
        match(1, "a", "h", "a"),
        match(1, "b", "g", "b"),
        match(1, "c", "f", "c"),
        match(1, "d", "e", "d"),
        // Semifinals, week 2. C is the better seed of the two losers.
        match(2, "a", "d", "a"),
        match(2, "b", "c", "b"),
        // Final.
        match(3, "a", "b", "a"),
      ],
    });

    expect(placements.slice(0, 5)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("requires two losses before eliminating a team in double elimination", () => {
    const placements = computePlayoffPlacements({
      format: "double_elimination",
      championTeamId: "a",
      standingsOrder: ["a", "b", "c", "d"],
      matches: [
        // Upper round: one loss each for B and D.
        match(1, "a", "b", "a"),
        match(1, "c", "d", "c"),
        match(2, "a", "c", "a"),
        // D goes out first in week 3.
        match(3, "b", "d", "b", "lower"),
        // C goes out next in week 4.
        match(4, "b", "c", "b", "lower"),
        // B wins the first final, then loses the reset: A is champion.
        match(5, "b", "a", "b", "gf"),
        match(6, "a", "b", "a", "gf"),
      ],
    });

    expect(placements.slice(0, 4)).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores the toilet bracket and unfinished matches", () => {
    const placements = computePlayoffPlacements({
      format: "single_elimination",
      championTeamId: "a",
      standingsOrder: ["a", "b", "c", "d"],
      matches: [
        match(1, "a", "d", "a"),
        match(1, "b", "c", "b"),
        match(2, "a", "b", "a"),
        // A consolation result must not rank D ahead of the real runner-up.
        match(3, "d", "c", "d", "toilet"),
        // An unfinished game eliminates nobody.
        match(3, "c", "d", null, "lower", "scheduled"),
      ],
    });

    expect(placements).toEqual(["a", "b", "c", "d"]);
  });

  it("does not charge a loss for byes or a double forfeit", () => {
    const placements = computePlayoffPlacements({
      format: "single_elimination",
      championTeamId: "a",
      standingsOrder: ["a", "b", "c"],
      matches: [
        // B advances on a bye (no second side).
        match(1, "a", null, "a"),
        match(1, "b", null, "b"),
        // A double forfeit with no winner eliminates nobody.
        match(2, "a", "b", null, "upper", "forfeit"),
        match(3, "a", "b", "a"),
      ],
    });

    expect(placements).toEqual(["a", "b"]);
  });
});
