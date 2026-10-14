import { describe, expect, it } from "vitest";

import {
  bracketSideIsBye,
  bracketSideTeam,
  feederLabel,
  feederReference,
  roundsFor,
  rowsForUnlistedGames,
  type BracketTemplateRow,
} from "./playoff-bracket-shape";

/** Builds template-shaped rows for a bracket of the given size. */
function shape(phases: Array<[string, number]>): Array<{ phase: string; round_no: number }> {
  return phases.map(([phase, round_no]) => ({ phase, round_no }));
}

/** Builds one full template row. */
function row(
  game_label: string,
  phase: BracketTemplateRow["phase"],
  round_no: number,
  week: number,
  slot: number | null = null,
): BracketTemplateRow {
  return {
    game_label,
    phase,
    round_no,
    week,
    slot,
    feeder_a: "seed 1",
    feeder_b: "seed 8",
    team_a: null,
    team_b: null,
    is_grand_final: phase === "gf",
    is_reset: false,
  };
}

describe("rowsForUnlistedGames", () => {
  /** A twelve team template: four winners rounds, six losers rounds, then the finals. */
  const template: BracketTemplateRow[] = [
    ...["G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G14", "G15"].map(
      (label, i) => row(label, "upper", Math.floor(i / 4) + 1, 6 + Math.floor(i / 4)),
    ),
    ...["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11"].map(
      (label, i) => row(label, "lower", [5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 10][i], 10 + [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 5][i]),
    ),
    row("GF1", "gf", 11, 16),
  ];

  it("gives a losers game one past the template its own row", () => {
    // The case this exists for. A double forfeit puts two teams on their first loss from
    // one winners game, so the losers round it feeds comes out a game wider than the
    // structure predicted. That game is real and has to be drawn.
    const [extra] = rowsForUnlistedGames(template, [
      { bracket_phase: "lower", week_number: 10, bracket_slot: 3 },
    ]);

    // L12, carrying on from L11, the last game the template previewed.
    expect(extra.game_label).toBe("L12");
    expect(extra.round_no).toBe(5);
    expect(extra.week).toBe(10);
  });

  it("puts the extra game in the column the template already uses for that week", () => {
    // Not simply the end of the phase: week 11 is the third losers round, so an extra
    // game there belongs beside that round's previewed games rather than below them all.
    const [extra] = rowsForUnlistedGames(template, [
      { bracket_phase: "lower", week_number: 11, bracket_slot: 2 },
    ]);

    expect(extra.round_no).toBe(6);
  });

  it("labels a game in the winners bracket with that phase's prefix and numbering", () => {
    // The winners bracket is laid out by the template and should never overrun it, but
    // the prefix has to be the phase's own if it ever does, or a losers label would appear
    // among the winners games.
    const [extra] = rowsForUnlistedGames(template, [
      { bracket_phase: "upper", week_number: 7, bracket_slot: 5 },
    ]);

    expect(extra.game_label).toBe("G16");
  });

  it("drops a match whose phase is missing or unrecognised", () => {
    // A row cannot be placed without knowing its column, and guessing would put the game
    // somewhere arbitrary.
    const rows = rowsForUnlistedGames(template, [
      { bracket_phase: null, week_number: 10, bracket_slot: 3 },
      { bracket_phase: "qualifying", week_number: 10, bracket_slot: 4 },
    ]);

    expect(rows).toEqual([]);
  });

  it("returns one row per game it is handed", () => {
    // Deciding which games are unlisted is the caller's job, so this only has to build a
    // row for each of the ones it is given, in bracket order.
    const rows = rowsForUnlistedGames(template, [
      { bracket_phase: "lower", week_number: 13, bracket_slot: 3 },
      { bracket_phase: "lower", week_number: 10, bracket_slot: 3 },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.round_no)).toEqual([5, 8]);
    expect(rows.map((r) => r.week)).toEqual([10, 13]);
  });

  it("numbers several extras without colliding, and per phase", () => {
    const rows = rowsForUnlistedGames(template, [
      { bracket_phase: "lower", week_number: 10, bracket_slot: 3 },
      { bracket_phase: "upper", week_number: 7, bracket_slot: 5 },
      { bracket_phase: "lower", week_number: 12, bracket_slot: 3 },
    ]);

    expect(rows.map((r) => r.game_label).sort()).toEqual(["G16", "L12", "L13"]);
  });
});

describe("roundsFor", () => {
  it("collects a phase's rounds in order", () => {
    const rows = shape([
      ["upper", 1],
      ["upper", 2],
      ["lower", 3],
      ["upper", 3],
      ["lower", 4],
    ]);

    expect(roundsFor(rows, "upper")).toEqual([1, 2, 3]);
    expect(roundsFor(rows, "lower")).toEqual([3, 4]);
  });

  it("sorts rounds that arrive out of order", () => {
    const rows = shape([
      ["upper", 4],
      ["upper", 1],
      ["upper", 3],
    ]);

    expect(roundsFor(rows, "upper")).toEqual([1, 3, 4]);
  });

  it("returns nothing for a phase the bracket does not have", () => {
    // A single elimination bracket has no losers bracket, and a two team one has no
    // grand final, so an empty phase has to render as nothing rather than as a blank
    // heading.
    const rows = shape([["upper", 1]]);

    expect(roundsFor(rows, "lower")).toEqual([]);
    expect(roundsFor(rows, "gf")).toEqual([]);
  });

  it("does not assume a fixed number of rounds", () => {
    // The bug this guards: the component carried a list written down for a twelve team
    // bracket, so a four team bracket lost its final column and a twenty team one lost a
    // round. Both must come back whole.
    const small = shape([
      ["upper", 1],
      ["upper", 2],
      ["lower", 3],
      ["lower", 4],
      ["gf", 5],
    ]);
    const large = shape([
      ["upper", 1],
      ["upper", 2],
      ["upper", 3],
      ["upper", 4],
      ["upper", 5],
      ["lower", 6],
      ["lower", 7],
      ["lower", 8],
      ["lower", 9],
      ["lower", 10],
      ["gf", 11],
      ["gf", 12],
    ]);

    expect(roundsFor(small, "upper")).toEqual([1, 2]);
    expect(roundsFor(small, "gf")).toEqual([5]);
    expect(roundsFor(large, "upper")).toEqual([1, 2, 3, 4, 5]);
    expect(roundsFor(large, "lower")).toEqual([6, 7, 8, 9, 10]);
  });
});

describe("bracket slot numbering", () => {
  it("keeps padded positions in a round where seeds hold byes", () => {
    // The bug this guards. A twelve team field pads to sixteen, and seeds one to four
    // hold byes, so the first round's real games sit at slots five to eight rather than
    // one to four. Anything that assumes a round numbers its games from one -- pairing a
    // preview row to a match by its position in the list, say -- matches nothing in that
    // round, and the games then get drawn a second time as unlisted extras. The duplicate
    // matchups the members saw were exactly this.
    const first = [
      row("G5", "upper", 1, 6, 5),
      row("G6", "upper", 1, 6, 6),
      row("G7", "upper", 1, 6, 7),
      row("G8", "upper", 1, 6, 8),
    ];

    expect(first.map((r) => r.slot)).toEqual([5, 6, 7, 8]);
    expect(first.map((r) => r.slot)).not.toEqual([1, 2, 3, 4]);
  });

  it("numbers a full round from one when nothing is padded", () => {
    // The other case, so the fix is not mistaken for "always offset by four".
    const second = [
      row("G9", "upper", 2, 7, 1),
      row("G10", "upper", 2, 7, 2),
      row("G11", "upper", 2, 7, 3),
      row("G12", "upper", 2, 7, 4),
    ];

    expect(second.map((r) => r.slot)).toEqual([1, 2, 3, 4]);
  });

  it("carries slot through to an unlisted game's row", () => {
    // An extra game keeps its own slot, so the two are never confused for each other when
    // the bracket pairs rows to matches.
    const [extra] = rowsForUnlistedGames(
      [row("L1", "lower", 5, 10, 1), row("L2", "lower", 5, 10, 2)],
      [{ bracket_phase: "lower", week_number: 10, bracket_slot: 3 }],
    );

    expect(extra.slot).toBe(3);
  });

  it("leaves a bye slot empty rather than resolving the feeder into it", () => {
    // The reported bug. L2 was created as "Test Bot 20 vs <bye>" because the losers pool
    // held an odd number of teams, but the template still describes that slot as
    // "L(G7) / L(G8)". Treating the created match's empty side as "no team yet" and
    // falling back to the feeder resolved L(G8) to that game's loser and drew a team
    // into a slot nobody is playing.
    const resolveFeeder = () => "team-22";

    expect(bracketSideTeam(true, "team-20", null, resolveFeeder)).toBe("team-20");
    expect(bracketSideTeam(true, null, null, resolveFeeder)).toBeNull();
  });

  it("does not even ask the feeder when a created game settles the slot", () => {
    // The feeder is not merely overridden, it is not consulted: resolving one reads
    // another game's result, and doing that for a slot the match already answers is both
    // wasted work and a chance to show the wrong team.
    let asked = false;

    bracketSideTeam(true, null, null, () => {
      asked = true;
      return "team-22";
    });

    expect(asked).toBe(false);
  });

  it("still resolves the feeder for a slot with no game yet", () => {
    // The case the feeder text exists for: before a game is created the sheet shows what
    // is due there, which is the whole reason the bracket is drawn from the template.
    expect(bracketSideTeam(false, null, null, () => "team-22")).toBe("team-22");
    expect(bracketSideTeam(false, null, "seed-3", () => "team-22")).toBe("seed-3");
    expect(bracketSideTeam(false, null, null, () => null)).toBeNull();
  });

  it("tells a bye apart from a slot still to come", () => {
    // Both have no team, but one is decided and the other is not, and they read
    // differently: "Bye" versus the feeder saying who is due.
    expect(bracketSideIsBye(true, null)).toBe(true);
    expect(bracketSideIsBye(true, "team-20")).toBe(false);
    expect(bracketSideIsBye(false, null)).toBe(false);
  });
});

describe("feederReference", () => {
  it("reads a winner reference", () => {
    expect(feederReference("W(G7)")).toEqual({ kind: "winner", game: "G7" });
  });

  it("reads a loser reference", () => {
    expect(feederReference("L(L3)")).toEqual({ kind: "loser", game: "L3" });
  });

  it("reads a grand final reference", () => {
    // The finals are GF rather than G, because the winners bracket owns every G the
    // field size can produce and labels have to stay unique across the bracket.
    expect(feederReference("W(GF1)")).toEqual({ kind: "winner", game: "GF1" });
    expect(feederReference("L(GF1)")).toEqual({ kind: "loser", game: "GF1" });
  });

  it("reads labels above single digits, which a larger field produces", () => {
    expect(feederReference("W(G15)")).toEqual({ kind: "winner", game: "G15" });
    expect(feederReference("L(L11)")).toEqual({ kind: "loser", game: "L11" });
  });

  it("returns null for a seed or a bye", () => {
    expect(feederReference("seed 1")).toBeNull();
    expect(feederReference("Bye")).toBeNull();
  });
});

describe("feederLabel", () => {
  it("spells out a feeder in words", () => {
    expect(feederLabel("W(G7)")).toBe("G7 Winner");
    expect(feederLabel("L(L3)")).toBe("L3 Loser");
  });

  it("capitalises a seed", () => {
    expect(feederLabel("seed 12")).toBe("Seed 12");
  });

  it("leaves a bye alone", () => {
    expect(feederLabel("Bye")).toBe("Bye");
  });
});
