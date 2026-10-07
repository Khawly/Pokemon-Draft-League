/*
 * Tests for the schedule page's pure helpers.
 *
 * These decide how a match reads: the game record beside a player's name, how many
 * games a format needs, and the byes shown before a bracket is generated. The
 * database-backed mutations are exercised through RPCs and RLS instead, which unit
 * tests cannot meaningfully cover.
 */
import { describe, expect, it } from "vitest";

import {
  nextPowerOfTwo,
  winsRequired,
  gameRecord,
  groupProposalHistoryByWeek,
  proposalOutcomeLabel,
  proposalOutcomeTone,
  proposalWeekLabel,
  seasonPhaseLabel,
  type ProposalHistoryEntry,
  type ScheduleMatch,
  type ScheduleMatchResult,
} from "@/lib/supabase/schedule";

/**
 * Builds a match with the given per-team wins.
 *
 * @param player1Wins - Games player one won.
 * @param player2Wins - Games player two won.
 * @returns A match carrying that result set.
 */
function matchWith(player1Wins: number, player2Wins: number): ScheduleMatch {
  const player1 = "team-1";
  const player2 = "team-2";

  const results: ScheduleMatchResult[] = [
    ...Array.from({ length: player1Wins }, (_, index) => ({
      id: `p1-${index}`,
      winner_team_id: player1,
      replay_url: null,
      game_number: index + 1,
      reporter_name: null,
      pokemon_left_alive: null,
      submitted_at: "2026-07-01T00:00:00.000Z",
    })),
    ...Array.from({ length: player2Wins }, (_, index) => ({
      id: `p2-${index}`,
      winner_team_id: player2,
      replay_url: null,
      game_number: player1Wins + index + 1,
      reporter_name: null,
      pokemon_left_alive: null,
      submitted_at: "2026-07-01T00:00:00.000Z",
    })),
  ];

  return {
    forfeited_by_name: null,
    id: "match-1",
    week_number: 1,
    is_playoff: false,
    bracket_phase: null,
    scheduled_at: null,
    status: "in_progress",
    winner_team_id: null,
    notes: null,
    player_1_team_id: player1,
    player_2_team_id: player2,
    player_1_name: "Player One",
    player_2_name: "Player Two",
    player_1_avatar_url: null,
    player_2_avatar_url: null,
    player_1_user_id: "user-1",
    player_2_user_id: "user-2",
    results,
    pending_proposal: null,
  };
}

describe("winsRequired", () => {
  it("needs one win for a single game", () => {
    expect(winsRequired("single")).toBe(1);
  });

  it("needs two wins for a best of three", () => {
    expect(winsRequired("best_of_3")).toBe(2);
  });
});

describe("gameRecord", () => {
  it("returns null when no games have been played", () => {
    // A record of "0-0" would imply a game happened, which is a different claim.
    expect(gameRecord(matchWith(0, 0), "team-1")).toBeNull();
  });

  it("counts a sweep from the leader's side", () => {
    expect(gameRecord(matchWith(2, 0), "team-1")).toBe("2-0");
  });

  it("counts a sweep from the follower's side", () => {
    expect(gameRecord(matchWith(2, 0), "team-2")).toBe("0-2");
  });

  it("counts a split best of three", () => {
    expect(gameRecord(matchWith(2, 1), "team-1")).toBe("2-1");
    expect(gameRecord(matchWith(2, 1), "team-2")).toBe("1-2");
  });

  it("counts a partial game before the match is decided", () => {
    expect(gameRecord(matchWith(1, 0), "team-1")).toBe("1-0");
  });
});

describe("nextPowerOfTwo", () => {
  it("returns the number itself when it is already a power of two", () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(8)).toBe(8);
  });

  it("rounds up to the next power of two", () => {
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(5)).toBe(8);
    expect(nextPowerOfTwo(7)).toBe(8);
  });

  it("matches the byes a playoff field of that size needs", () => {
    // Six teams means an eight-slot bracket, so two byes.
    expect(nextPowerOfTwo(6) - 6).toBe(2);
  });
});

describe("groupProposalHistoryByWeek", () => {
  const entry = (
    overrides: Partial<ProposalHistoryEntry> = {},
  ): ProposalHistoryEntry => ({
    id: "p-1",
    match_id: "m-1",
    week_number: 3,
    is_playoff: false,
    bracket_phase: null,
    status: "accepted",
    proposed_at: "2026-07-01T19:00:00.000Z",
    notes: null,
    proposed_by: "user-a",
    proposed_by_name: "Khawly",
    responded_at: "2026-07-01T20:00:00.000Z",
    responded_by: "user-b",
    responded_by_name: "Bam",
    player_1_name: "Khawly",
    player_2_name: "Bam",
    player_1_user_id: "user-a",
    player_2_user_id: "user-b",
    created_at: "2026-07-01T18:00:00.000Z",
    ...overrides,
  });

  it("puts the newest week first", () => {
    const groups = groupProposalHistoryByWeek([
      entry({ id: "a", week_number: 2 }),
      entry({ id: "b", week_number: 5 }),
      entry({ id: "c", week_number: 3 }),
    ]);

    expect(groups.map((group) => group.week_number)).toEqual([5, 3, 2]);
  });

  it("collects every proposal from the same week into one group", () => {
    // A rescheduled matchup can be offered several times in one week, and the
    // owner needs to see all of them together rather than in separate sections.
    const groups = groupProposalHistoryByWeek([
      entry({ id: "a", week_number: 3, status: "declined" }),
      entry({ id: "b", week_number: 3, status: "accepted" }),
      entry({ id: "c", week_number: 2 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].entries.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("keeps the order the log arrived in within a week", () => {
    // The loader already returns newest first; re-sorting would be redundant and
    // would risk disagreeing with it.
    const groups = groupProposalHistoryByWeek([
      entry({ id: "newest", week_number: 1 }),
      entry({ id: "middle", week_number: 1 }),
      entry({ id: "oldest", week_number: 1 }),
    ]);

    expect(groups[0].entries.map((row) => row.id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("carries the week and bracket detail onto the group", () => {
    const [group] = groupProposalHistoryByWeek([
      entry({ week_number: 4, is_playoff: true, bracket_phase: "lower" }),
    ]);

    expect(group.is_playoff).toBe(true);
    expect(group.bracket_phase).toBe("lower");
  });

  it("returns nothing for an empty log", () => {
    expect(groupProposalHistoryByWeek([])).toEqual([]);
  });
});

describe("proposalOutcomeLabel", () => {
  const entry = (
    overrides: Partial<ProposalHistoryEntry>,
  ): ProposalHistoryEntry =>
    ({
      id: "p-1",
      status: "pending",
      responded_by_name: null,
      ...overrides,
    }) as ProposalHistoryEntry;

  it("names who accepted", () => {
    expect(
      proposalOutcomeLabel(
        entry({ status: "accepted", responded_by_name: "Bam" }),
      ),
    ).toBe("Accepted by Bam");
  });

  it("names who declined", () => {
    expect(
      proposalOutcomeLabel(
        entry({ status: "declined", responded_by_name: "Bam" }),
      ),
    ).toBe("Declined by Bam");
  });

  it("names who withdrew", () => {
    // A withdrawal is the proposer retracting their own offer, so the name is
    // the person who pulled it rather than the person who refused it.
    expect(
      proposalOutcomeLabel(
        entry({ status: "withdrawn", responded_by_name: "Khawly" }),
      ),
    ).toBe("Withdrawn by Khawly");
  });

  it("says a pending offer is waiting rather than showing no name", () => {
    expect(proposalOutcomeLabel(entry({ status: "pending" }))).toBe(
      "Awaiting a response",
    );
  });

  it("falls back to the bare status when the responder cannot be named", () => {
    expect(
      proposalOutcomeLabel(entry({ status: "accepted", responded_by_name: null })),
    ).toBe("Accepted");
  });
});

describe("proposalOutcomeTone", () => {
  it("gives each outcome a distinct colour", () => {
    const tones = ["accepted", "declined", "withdrawn", "pending"].map(
      (status) => proposalOutcomeTone(status as ProposalHistoryEntry["status"]),
    );

    expect(new Set(tones).size).toBe(4);
  });

  it("returns Tailwind classes rather than a raw colour", () => {
    expect(proposalOutcomeTone("accepted")).toContain("text-");
  });
});

describe("proposalWeekLabel", () => {
  it("labels a regular week by its number", () => {
    expect(proposalWeekLabel({ week_number: 3, is_playoff: false })).toBe(
      "Week 3",
    );
  });

  it("labels a playoff proposal as Playoffs", () => {
    // A playoff round is not a week, so "Week 4" would be a lie even though the
    // underlying week_number is a real value.
    expect(proposalWeekLabel({ week_number: 4, is_playoff: true })).toBe(
      "Playoffs",
    );
  });
});

describe("seasonPhaseLabel", () => {
  const match = (status: ScheduleMatch["status"]) => ({ status });

  it("calls a league with no schedule and no week the preseason", () => {
    // A league still in its draft has no current week, which used to be read as
    // the postseason.
    expect(
      seasonPhaseLabel({
        currentWeek: null,
        regularSeasonCompleted: false,
        regularMatches: [],
      }),
    ).toBe("Preseason");
  });

  it("calls a league in the middle of the regular season its current week", () => {
    expect(
      seasonPhaseLabel({
        currentWeek: 3,
        regularSeasonCompleted: false,
        regularMatches: [match("completed"), match("scheduled")],
      }),
    ).toBe("Current week 3");
  });

  it("calls a frozen regular season the postseason even with a parked week", () => {
    // The deadline sweep leaves current_week on the final week when it closes
    // the regular season out, so completion has to win over the pointer.
    expect(
      seasonPhaseLabel({
        currentWeek: 8,
        regularSeasonCompleted: true,
        regularMatches: [match("completed")],
      }),
    ).toBe("Postseason");
  });

  it("calls a fully decided schedule the postseason without a deadline", () => {
    // A league that never ran a weekly deadline never has the completion flag
    // set, so an all-settled schedule is the only signal it is over.
    expect(
      seasonPhaseLabel({
        currentWeek: null,
        regularSeasonCompleted: false,
        regularMatches: [
          match("completed"),
          match("forfeit"),
          match("cancelled"),
        ],
      }),
    ).toBe("Postseason");
  });

  it("stays in the preseason while any regular match is undecided", () => {
    expect(
      seasonPhaseLabel({
        currentWeek: null,
        regularSeasonCompleted: false,
        regularMatches: [match("completed"), match("unscheduled")],
      }),
    ).toBe("Preseason");
  });
});
