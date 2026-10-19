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
  isByeMatch,
  proposalWeekLabel,
  firstPlayoffWeekOf,
  inspectManualSchedule,
  matchWeekLabel,
  movesStandings,
  orderMatchesForPicker,
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
      reporter_name_color: null,
      pokemon_left_alive: null,
      submitted_at: "2026-07-01T00:00:00.000Z",
    })),
    ...Array.from({ length: player2Wins }, (_, index) => ({
      id: `p2-${index}`,
      winner_team_id: player2,
      replay_url: null,
      game_number: player1Wins + index + 1,
      reporter_name: null,
      reporter_name_color: null,
      pokemon_left_alive: null,
      submitted_at: "2026-07-01T00:00:00.000Z",
    })),
  ];

  return {
    forfeited_by_name: null,
    forfeited_by_name_color: null,
    id: "match-1",
    week_number: 1,
    is_playoff: false,
    playoff_round_no: null,
    bracket_phase: null,
    bracket_slot: null,
    created_at: "2026-07-01T00:00:00.000Z",
    scheduled_at: null,
    status: "in_progress",
    winner_team_id: null,
    notes: null,
    player_1_team_id: player1,
    player_2_team_id: player2,
player_1_name: "Player One",
    player_2_name: "Player Two",
    player_1_name_color: null,
    player_2_name_color: null,
    player_1_avatar_initials: null,
    player_2_avatar_initials: null,
    player_1_avatar_url: null,
    player_2_avatar_url: null,
    player_1_user_id: "user-1",
    player_2_user_id: "user-2",
    results,
    pending_proposal: null,
  };
}

describe("orderMatchesForPicker", () => {
  const game = (
    week: number,
    phase: "upper" | "lower" | "gf" | "toilet" | null,
    slot: number | null,
    id: string,
    round: number | null = null,
  ) => ({
    week_number: week,
    is_playoff: phase !== null,
    bracket_phase: phase,
    bracket_slot: slot,
    playoff_round_no: round,
    id,
  });

  it("keeps a round together even when it spans weeks", () => {
    // The bug this guards. One press writes the next winners round and the next losers
    // round into different weeks, so a week-ordered list read "Week 3, Week 2, Week 3" --
    // a Playoffs (Week 2) block sitting between two Playoffs (Week 3) blocks.
    const ordered = orderMatchesForPicker([
      game(11, "lower", 1, "round3-losers", 3),
      game(10, "lower", 1, "round2-losers", 2),
      game(8, "upper", 1, "round3-winners", 3),
    ]);

    expect(ordered.map((m) => m.id)).toEqual([
      "round3-winners",
      "round3-losers",
      "round2-losers",
    ]);
  });

  it("puts a round's playoff games above its toilet games", () => {
    // The losers leg is a playoff game for the same round, so the toilet games come after
    // it rather than between it and the winners leg.
    const ordered = orderMatchesForPicker([
      game(8, "toilet", 1, "toilet", 3),
      game(11, "lower", 1, "losers", 3),
      game(8, "upper", 1, "winners", 3),
    ]);

    expect(ordered.map((m) => m.id)).toEqual(["winners", "losers", "toilet"]);
  });

  it("orders the newest round first", () => {
    const ordered = orderMatchesForPicker([
      game(6, "upper", 5, "round1", 1),
      game(8, "upper", 1, "round3", 3),
      game(7, "upper", 1, "round2", 2),
    ]);

    expect(ordered.map((m) => m.id)).toEqual(["round3", "round2", "round1"]);
  });

  it("keeps the regular season below the live bracket, newest week first", () => {
    const ordered = orderMatchesForPicker([
      game(2, null, null, "week2"),
      game(9, "upper", 1, "playoff", 3),
      game(5, null, null, "week5"),
    ]);

    expect(ordered.map((m) => m.id)).toEqual(["playoff", "week5", "week2"]);
  });

  it("sorts a playoff game with no round number after the numbered ones", () => {
    const ordered = orderMatchesForPicker([
      game(6, "upper", 1, "unnumbered", null),
      game(7, "upper", 1, "numbered", 2),
    ]);

    expect(ordered.map((m) => m.id)).toEqual(["numbered", "unnumbered"]);
  });
});

describe("movesStandings", () => {
  /** A settled match, so the fixture has a winner and a status worth changing. */
  const settled = (): ScheduleMatch => ({
    ...matchWith(2, 0),
    status: "completed",
    winner_team_id: "team-1",
  });

  it("says no when only the scheduling moved", () => {
    // The common realtime event: somebody proposes or accepts a time. Nothing the table is
    // derived from changed, so re-reading it would be two endpoints for nothing.
    const before = settled();
    const after = { ...before, scheduled_at: "2026-08-01T18:00:00.000Z" };

    expect(movesStandings([before], [after])).toBe(false);
  });

  it("says no when only a proposal or a note changed", () => {
    const before = settled();
    const after = {
      ...before,
      notes: "rescheduled",
      pending_proposal: {
        id: "proposal-1",
        proposed_by: "user-1",
        proposed_at: "2026-08-01T18:00:00.000Z",
        notes: null,
        status: "pending" as const,
        created_at: "2026-08-01T12:00:00.000Z",
        responded_at: null,
      },
    };

    expect(movesStandings([before], [after])).toBe(false);
  });

  it("says yes when a result is submitted", () => {
    const before = { ...settled(), status: "in_progress" as const, winner_team_id: null };
    const after = settled();

    expect(movesStandings([before], [after])).toBe(true);
  });

  it("says yes when a game result is edited but the winner does not change", () => {
    // KO differential is read from the per-game rows, so a corrected survivor count moves
    // the table even though the match's own winner is the same.
    const before = settled();
    const after: ScheduleMatch = {
      ...before,
      results: before.results.map((result, index) =>
        index === 0 ? { ...result, pokemon_left_alive: 4 } : result,
      ),
    };

    expect(movesStandings([before], [after])).toBe(true);
  });

  it("says yes when a game is created or removed", () => {
    // A bracket round appearing is what changes the answer the champion function gives.
    const before = settled();
    const added: ScheduleMatch = { ...settled(), id: "match-2" };

    expect(movesStandings([before], [before, added])).toBe(true);
    expect(movesStandings([before, added], [before])).toBe(true);
  });

  it("says yes when the winner changes", () => {
    const before = settled();
    const after: ScheduleMatch = { ...before, winner_team_id: "team-2" };

    expect(movesStandings([before], [after])).toBe(true);
  });

  it("says no for an unchanged set", () => {
    // The steady state: a scheduled time elsewhere in the league moved, and this match did
    // not. Cheap refresh has to survive being handed its own previous answer.
    const before = settled();

    expect(movesStandings([before], [{ ...before }])).toBe(false);
    expect(movesStandings([], [])).toBe(false);
  });
});

describe("inspectManualSchedule", () => {
  const teams = ["a", "b", "c", "d"];
  const game = (week: number, x: string, y: string) => ({
    week,
    player_1_team_id: x,
    player_2_team_id: y,
  });

  it("accepts a complete round robin and reports nobody resting", () => {
    const { problems, restingByWeek } = inspectManualSchedule(
      [game(1, "a", "b"), game(1, "c", "d"), game(2, "a", "c"), game(2, "b", "d")],
      2,
      teams,
    );

    expect(problems).toEqual([]);
    expect(restingByWeek.get(1)).toEqual([]);
    expect(restingByWeek.get(2)).toEqual([]);
  });

  it("names the teams resting in a week", () => {
    // A bye is invisible in the rows, so it has to be reported explicitly or an owner
    // cannot tell a deliberate rest from a team they forgot to schedule.
    const { problems, restingByWeek } = inspectManualSchedule(
      [game(1, "a", "b")],
      3,
      teams,
    );

    expect(problems).toEqual([]);
    expect(restingByWeek.get(1)).toEqual(["c", "d"]);
    expect(restingByWeek.get(2)).toEqual(teams);
    expect(restingByWeek.get(3)).toEqual(teams);
  });

  it("rejects a team scheduled twice in the same week", () => {
    const { problems } = inspectManualSchedule(
      [game(1, "a", "b"), game(1, "a", "c")],
      1,
      teams,
    );

    expect(problems).toContain("Week 1 schedules the same team twice.");
  });

  it("allows the same pairing in different weeks", () => {
    // A rematch is a scheduling decision, not an error.
    const { problems } = inspectManualSchedule(
      [game(1, "a", "b"), game(2, "a", "b")],
      2,
      teams,
    );

    expect(problems).toEqual([]);
  });

  it("rejects a team paired with itself", () => {
    const { problems } = inspectManualSchedule([game(1, "a", "a")], 1, teams);

    expect(problems).toContain("Week 1 pairs a team with itself.");
  });

  it("rejects a week outside the season", () => {
    const { problems } = inspectManualSchedule([game(4, "a", "b")], 3, teams);

    expect(problems[0]).toContain("outside a 3 week season");
  });

  it("rejects a matchup with a side missing", () => {
    const { problems } = inspectManualSchedule([game(1, "a", "")], 1, teams);

    expect(problems).toContain("Week 1 has a matchup with a team missing.");
  });

  it("reports each distinct problem once", () => {
    // Three rows pairing the same team in week one should not produce the same sentence
    // three times and bury everything else.
    const { problems } = inspectManualSchedule(
      [game(1, "a", "b"), game(1, "a", "c"), game(1, "a", "d")],
      1,
      teams,
    );

    expect(problems.filter((p) => p === "Week 1 schedules the same team twice.")).toHaveLength(
      1,
    );
  });
});

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
    proposed_by_name_color: null,
    responded_at: "2026-07-01T20:00:00.000Z",
    responded_by: "user-b",
    responded_by_name: "Bam",
    responded_by_name_color: null,
    player_1_name: "Khawly",
    player_2_name: "Bam",
    player_1_name_color: null,
    player_2_name_color: null,
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

describe("isByeMatch", () => {
  it("treats a match with only one side as a bye", () => {
    // A bracket padded out for byes, and any game whose other side was knocked out by a
    // double forfeit, leaves a match with one team and no opponent. The advance settles
    // those so the bracket can move on, which makes them real rows.
    expect(isByeMatch({ player_2_team_id: null })).toBe(true);
    expect(isByeMatch({ player_2_team_id: "team-b" })).toBe(false);
  });
});

describe("proposalWeekLabel", () => {
  it("labels a regular week by its number", () => {
    expect(proposalWeekLabel({ week_number: 3, is_playoff: false }, 6)).toBe(
      "Week 3",
    );
  });

  it("counts a playoff week from the first one rather than using its stored number", () => {
    // A five week league runs its bracket over weeks six onwards. That number is an
    // internal id: the opening round is not "week 6" to anyone reading the page.
    expect(
      proposalWeekLabel({ week_number: 6, is_playoff: true }, 6),
    ).toBe("Playoffs (Week 1)");
    expect(
      proposalWeekLabel({ week_number: 11, is_playoff: true }, 6),
    ).toBe("Playoffs (Week 6)");
  });

  it("counts a playoff game by the press that created it", () => {
    // One press writes several rounds at once: after the opening round it creates the
    // next winners round and the first losers round together. Those land in different
    // stored weeks, and counting by week would split one set of new matchups across two
    // labels. Counting by bracket round is no better, because the winners and losers
    // brackets run their rounds in parallel and their round numbers are unrelated.
    const fromPress = { playoff_round_no: 2 };

    // Week 7 is the second winners round and week 10 the first losers round. One press
    // created both, so both read as round 2.
    expect(matchWeekLabel({ week_number: 7, is_playoff: true, ...fromPress }, 6)).toBe(
      "Playoffs (Week 2)",
    );
    expect(matchWeekLabel({ week_number: 10, is_playoff: true, ...fromPress }, 6)).toBe(
      "Playoffs (Week 2)",
    );
  });

  it("ignores the first playoff week once a game records its press", () => {
    // The stored number is only a fallback for games written before the column existed,
    // so a press must win over it even when the two disagree.
    expect(
      matchWeekLabel(
        { week_number: 11, is_playoff: true, playoff_round_no: 3 },
        6,
      ),
    ).toBe("Playoffs (Week 3)");
  });

  it("labels a toilet bowl game by its bracket, not as a playoff", () => {
    // The consolation bracket is also is_playoff, so the flag alone is not enough to say
    // which bracket a game is in. Every toilet game was reading as a playoff in the
    // matchup picker because of it.
    expect(
      matchWeekLabel(
        { week_number: 7, is_playoff: true, bracket_phase: "toilet" },
        6,
      ),
    ).toBe("Toilet Bowl (Week 2)");
  });

  it("still counts a toilet game from the first playoff week", () => {
    // A toilet game has no press number of its own, so the week is what dates it.
    expect(
      matchWeekLabel(
        { week_number: 6, is_playoff: true, bracket_phase: "toilet" },
        6,
      ),
    ).toBe("Toilet Bowl (Week 1)");
  });

  it("labels a playoff game by its bracket even when a press number exists", () => {
    expect(
      matchWeekLabel(
        { week_number: 7, is_playoff: true, bracket_phase: "upper", playoff_round_no: 2 },
        6,
      ),
    ).toBe("Playoffs (Week 2)");
  });

  it("leaves a regular-season game on its own number even if it has a press", () => {
    expect(
      matchWeekLabel(
        { week_number: 3, is_playoff: false, playoff_round_no: 2 },
        6,
      ),
    ).toBe("Week 3");
  });

  it("falls back to a bare Playoffs before the postseason has a first week", () => {
    // The only case with nothing to count from. Without the fallback this would read
    // "Playoffs (Week 4)" off a week number belonging to the regular season.
    expect(proposalWeekLabel({ week_number: 4, is_playoff: true }, null)).toBe(
      "Playoffs",
    );
  });
});

describe("firstPlayoffWeekOf", () => {
  it("finds the earliest playoff week across the season", () => {
    const matches = [
      { week_number: 1, is_playoff: false },
      { week_number: 5, is_playoff: false },
      { week_number: 11, is_playoff: true },
      { week_number: 6, is_playoff: true },
      { week_number: 7, is_playoff: true },
    ];

    expect(firstPlayoffWeekOf(matches)).toBe(6);
  });

  it("returns null while the postseason has not started", () => {
    expect(
      firstPlayoffWeekOf([
        { week_number: 1, is_playoff: false },
        { week_number: 5, is_playoff: false },
      ]),
    ).toBeNull();
    expect(firstPlayoffWeekOf([])).toBeNull();
  });

  it("numbers the same way whatever subset of the season it is given", () => {
    // The reason it takes the whole season rather than the panel's own matches. The
    // proposal log drops the opening round long before the final is proposed, so
    // numbering from what was left would relabel the final as week 1.
    const whole = [
      { week_number: 6, is_playoff: true },
      { week_number: 16, is_playoff: true },
    ];
    const tail = [{ week_number: 16, is_playoff: true }];

    expect(matchWeekLabel(tail[0], firstPlayoffWeekOf(whole))).toBe(
      "Playoffs (Week 11)",
    );
    expect(matchWeekLabel(tail[0], firstPlayoffWeekOf(tail))).toBe(
      "Playoffs (Week 1)",
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
