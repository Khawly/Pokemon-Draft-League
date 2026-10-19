/*
 * Pure helpers for reading the shape of a playoff bracket.
 *
 * The bracket is described by a database function that takes the field size, so its
 * round count, game labels and week layout all vary with how many teams qualified. The
 * bracket component used to carry lists of round numbers written down for one field size,
 * which silently truncated any bracket that did not match it. These helpers read the
 * shape off the rows instead, and live here rather than in the component so they can be
 * tested without a DOM.
 */

/** One game as the bracket template describes it. */
export interface BracketShapeRow {
  /** 'upper', 'lower' or 'gf'. */
  phase: string;
  /** Round number, unique within a bracket and continuous across phases. */
  round_no: number;
}

/** Which part of the bracket a game belongs to. */
export type BracketPhase = "upper" | "lower" | "gf" | "toilet";

/** A template row in full, which is what a card is drawn from. */
export interface BracketTemplateRow extends BracketShapeRow {
  game_label: string;
  phase: BracketPhase;
  week: number;
  slot: number | null;
  feeder_a: string;
  feeder_b: string;
  team_a: string | null;
  team_b: string | null;
  is_grand_final: boolean;
  is_reset: boolean;
}

/**
 * The rounds belonging to one phase, in bracket order.
 *
 * @param rows - Every game the bracket will contain.
 * @param phase - The phase to collect rounds for.
 * @returns That phase's round numbers, ascending, with no duplicates.
 */
export function roundsFor(rows: BracketShapeRow[], phase: string): number[] {
  return [
    ...new Set(rows.filter((row) => row.phase === phase).map((row) => row.round_no)),
  ].sort((a, b) => a - b);
}

/** One playoff match, reduced to what a bracket row has to be placed from. */
export interface UnlistedBracketGame {
  bracket_phase: string | null;
  week_number: number;
  bracket_slot: number | null;
}

/** The label prefixes each phase numbers its games with. */
const PHASE_LABEL_PREFIX: Record<BracketPhase, string> = {
  upper: "G",
  lower: "L",
  gf: "GF",
  toilet: "T",
};

/**
 * Whether a phase is one the bracket knows how to label.
 *
 * @param phase - A phase taken off a match.
 * @returns True when the phase can be drawn, false when it is null or unrecognised.
 */
function isBracketPhase(phase: string | null): phase is BracketPhase {
  return (
    phase === "upper" ||
    phase === "lower" ||
    phase === "gf" ||
    phase === "toilet"
  );
}

/**
 * Whether an unlisted game can be placed in a column.
 *
 * A playoff match always names its phase, but the column is nullable in the row type, so
 * the guard has to rule out the null rather than assume it away.
 *
 * @param game - A match no template row claimed.
 * @returns True when the game can be given a row.
 */
function isPlaceableGame(
  game: UnlistedBracketGame,
): game is UnlistedBracketGame & { bracket_phase: BracketPhase } {
  return isBracketPhase(game.bracket_phase);
}

/**
 * Builds rows for games the bracket created that the template never listed.
 *
 * The winners bracket and the finals are laid out by the template, which describes them
 * exactly, so it always has a row for them. The losers bracket is not: it is built from
 * the pool of teams sitting on one loss, and a double forfeit puts two teams into that
 * pool from one game where the template expected one, so the round comes out a game wider
 * than the one that was previewed.
 *
 * Those extra games are real, and a member is meant to be able to play them, so they are
 * drawn rather than dropped. Each is numbered on from where its phase's previewed games
 * stopped, and takes the round the template already uses for that phase and week, which
 * puts it in the right column beside the games that were previewed.
 *
 * @param rows - The template rows.
 * @param games - The matches that no template row claimed.
 * @returns A row per unlisted game, in bracket order.
 */
export function rowsForUnlistedGames(
  rows: BracketTemplateRow[],
  games: UnlistedBracketGame[],
): BracketTemplateRow[] {
  // Where each phase's numbering left off, so the extras carry on from there instead of
  // colliding with a previewed label.
  const lastLabel = new Map<BracketPhase, number>();

  for (const phase of ["upper", "lower", "gf"] as const) {
    const highest = Math.max(
      0,
      ...rows
        .filter((row) => row.phase === phase)
        .map((row) => Number(/(\d+)$/.exec(row.game_label)?.[1] ?? 0))
        .filter((n) => Number.isFinite(n)),
    );

    lastLabel.set(phase, highest);
  }

  return games
    .filter(isPlaceableGame)
    .map((game) => {
      const phase = game.bracket_phase;
      const previous = lastLabel.get(phase) ?? 0;
      const number = previous + 1;
      lastLabel.set(phase, number);

      const phaseRows = rows.filter((row) => row.phase === phase);

      // The round the template already uses for this week, so the card lands in the
      // column it belongs to. A week the template says nothing about has no column, so
      // it goes on the end of the phase instead.
      const sameWeek = phaseRows.find((row) => row.week === game.week_number);
      const roundNo =
        sameWeek?.round_no ?? Math.max(0, ...phaseRows.map((row) => row.round_no)) + 1;

      return {
        game_label: `${PHASE_LABEL_PREFIX[phase]}${number}`,
        phase,
        round_no: roundNo,
        week: game.week_number,
        slot: game.bracket_slot,
        // The sides come from the match itself, so these only show if a side is empty,
        // which in a real game means a bye.
        feeder_a: "bye",
        feeder_b: "bye",
        team_a: null,
        team_b: null,
        is_grand_final: phase === "gf",
        is_reset: false,
      };
    })
    .sort((a, b) => a.round_no - b.round_no || a.week - b.week);
}

/**
 * The team to show on one side of a bracket card.
 *
 * A created match is authoritative, and that includes a match with only one side: the
 * empty side is a bye and has to stay empty. Reading it as "no team yet, so fall back to
 * the template's feeder" is what filled a losers bracket bye slot with a team that was not
 * playing it -- the row still describes that slot as `L(G8)`, the feeder resolved to that
 * game's loser, and the sheet showed a matchup that was never created.
 *
 * Only a slot with no game yet falls through to the feeder, which is the case the feeder
 * text exists to describe.
 *
 * `resolveFeeder` is a callback rather than a value so it is only called when it is
 * actually needed.
 *
 * @param hasMatch - Whether a game has been created for this slot.
 * @param matchSide - The created game's side, or null when it is a bye.
 * @param seeded - The team id when the template already knows this side is a seed.
 * @param resolveFeeder - Resolves the template's feeder, for a slot with no game yet.
 * @returns The team id to render, or null for a bye or a slot still to come.
 */
export function bracketSideTeam(
  hasMatch: boolean,
  matchSide: string | null,
  seeded: string | null,
  resolveFeeder: () => string | null,
): string | null {
  if (hasMatch) {
    return matchSide;
  }

  return seeded ?? resolveFeeder();
}

/**
 * Whether a side is a bye rather than a slot nothing has been decided for yet.
 *
 * A bye is already settled -- the game exists and it has one side -- so it says so rather
 * than repeating feeder text for a game that is not coming.
 *
 * @param hasMatch - Whether a game has been created for this slot.
 * @param matchSide - The created game's side, or null when it is a bye.
 * @returns True when the slot is a bye.
 */
export function bracketSideIsBye(
  hasMatch: boolean,
  matchSide: string | null,
): boolean {
  return hasMatch && matchSide === null;
}

/**
 * The rows belonging to one round of one phase.
 *
 * Rounds are numbered from one within each bracket, so the playoff winners round one and
 * the toilet bowl round one are both round 1. Filtering on the round alone mixes every
 * bracket together; the phase has to be part of the test.
 *
 * @param rows - Every row being drawn.
 * @param phase - The bracket to take the round from.
 * @param round - The round number within that bracket.
 * @returns That round's rows, in the order given.
 */
export function rowsForRound<T extends BracketShapeRow>(
  rows: T[],
  phase: string,
  round: number,
): T[] {
  return rows.filter((row) => row.phase === phase && row.round_no === round);
}

/** What a bracket slot is waiting on. */
export interface FeederReference {
  kind: "winner" | "loser";
  /** Label of the game that decides the side, such as `U7` or `L3`. */
  game: string;
}

/**
 * Reads the game a slot is waiting on out of the template's feeder shorthand.
 *
 * The database writes a side as `W(U7)` or `L(L3)`, naming the game and which of its two
 * results is wanted. The number in the label depends on the field size, so this matches
 * the shape rather than any particular numbering.
 *
 * @param feeder - Feeder text from the template.
 * @returns The referenced game, or null when the feeder is a seed or a bye.
 */
export function feederReference(feeder: string): FeederReference | null {
  const match = /^(W|L)\(([A-Z]+\d+)\)$/.exec(feeder);

  if (!match) {
    return null;
  }

  return {
    kind: match[1] === "W" ? "winner" : "loser",
    game: match[2],
  };
}

/**
 * Turns the template's feeder shorthand into the wording the bracket shows.
 *
 * `W(U7)` is compact and unambiguous for the function but reads as shorthand to a member,
 * so it becomes `U7 Winner`. Seed labels are capitalised, and a bye is left as it is
 * because there is nothing to describe.
 *
 * @param feeder - Feeder text from the template.
 * @returns The text to show in an empty slot.
 */
export function feederLabel(feeder: string): string {
  const reference = feederReference(feeder);

  if (reference) {
    return `${reference.game} ${reference.kind === "winner" ? "Winner" : "Loser"}`;
  }

  return feeder.replace(/^seed /, "Seed ");
}
