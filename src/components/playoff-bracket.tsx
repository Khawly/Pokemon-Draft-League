/*
 * The playoff bracket, drawn as the full tournament rather than the rounds that
 * happen to exist yet.
 *
 * generate_playoff_round can only create a round once its feeders have produced
 * winners, because a match row needs two real team ids. Rendering straight from the
 * matches therefore showed one round and then an empty tab, so a member could not see
 * where their byes landed or how far a loser had to go. This draws from the template
 * instead, which lists every game, and fills each slot in from the matches that do
 * exist.
 *
 * Laid out as the league's tournament sheet: rounds run left to right, the winners
 * bracket sits above the losers bracket, and the finals are pulled out to the right.
 * Empty slots show what feeds them ("seed 1", "W(G5)") exactly as the sheet shows a
 * blank beside a game label, so an unplayed bracket reads as a schedule rather than as
 * something broken.
 */
"use client";

import type { ScheduleMatch } from "@/lib/supabase/schedule";
import type { SchedulePlayoffTemplateRow } from "@/lib/supabase/schedule";

import {
  bracketSideIsBye,
  bracketSideTeam,
  feederLabel,
  feederReference,
  rowsForUnlistedGames,
  roundsFor,
} from "@/lib/playoff-bracket-shape";

/** Props for the {@link PlayoffBracket} component. */
export interface PlayoffBracketProps {
  /** Every game the bracket will contain, from `playoff_bracket_template`. */
  rows: SchedulePlayoffTemplateRow[];
  /** Playoff matches created so far. */
  matches: ScheduleMatch[];
  /** Resolves a team id to the name and colour to render it in. */
  resolveTeam: (
    teamId: string | null,
  ) => { name: string; color: string | null } | null;
}

/**
 * Pairs each template row with the real match occupying the same slot.
 *
 * A round is not always as full as its template. A game whose feeder was a double
 * forfeit is never created, so the round can hold fewer matches than the template lists
 * games for it, and the gap is not at the end: the skipped game leaves a hole in the
 * middle. Pairing by ordinal therefore handed the next game's match to the game before
 * it, which drew a matchup for a game the generator had deliberately left out.
 *
 * So rows are paired on the slot number the generator stored, which is exact in both
 * directions. The numbering is not always a plain 1..n: a round padded out for byes
 * keeps its padded positions, so a twelve team field's first round runs G5 to G8 and not
 * G1 to G4. Pairing on position in the list instead of on that number left the first
 * round matching nothing, and its games then turned up a second time as extras.
 *
 * Ordinal position is kept only as a fallback for rounds created before that column
 * existed.
 *
 * Matches no row claimed are appended as rows of their own. That is the losers bracket
 * being one game wider than the template predicted, which a double forfeit causes, and
 * the game is real and playable, so it has to be drawn rather than dropped.
 *
 * @param rows - The template rows.
 * @param matches - Playoff matches created so far.
 * @returns The template rows plus a row per unclaimed match, each carrying its match.
 */
function withMatches(
  rows: SchedulePlayoffTemplateRow[],
  matches: ScheduleMatch[],
): Array<SchedulePlayoffTemplateRow & { match: ScheduleMatch | null }> {
  const ordered = [...matches].sort(
    (a, b) =>
      a.week_number - b.week_number ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const seen = new Map<string, number>();

  const bySlot = new Map<string, ScheduleMatch>();
  for (const match of ordered) {
    const key = `${match.bracket_phase}:${match.week_number}`;
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    bySlot.set(`${key}:${index}`, match);
    // The generator's own numbering, which stays correct when a round has holes.
    if (match.bracket_slot != null) {
      bySlot.set(`${key}:slot:${match.bracket_slot}`, match);
    }
  }

  const used = new Map<string, number>();
  const claimed = new Set<string>();

  const merged = rows.map((row) => {
    const key = `${row.phase}:${row.week}`;

    if (row.slot != null) {
      const slotted = bySlot.get(`${key}:slot:${row.slot}`);

      if (slotted) {
        claimed.add(slotted.id);
      }

      return { ...row, match: slotted ?? null };
    }

    /*
     * Position within this row's own phase and week, which is the numbering
     * bracket_slot uses. The template lists a week's games grouped by phase, so the
     * row's position in the whole array would count games from another phase.
     */
    const index = used.get(key) ?? 0;
    used.set(key, index + 1);

    /*
     * Only fall back to ordinal when the row has no slot of its own. If it does, a
     * missing slot means the game genuinely was not created, and borrowing a
     * neighbour's match would misreport it as played.
     */
    const roundHasSlots = ordered.some(
      (m) => `${m.bracket_phase}:${m.week_number}` === key && m.bracket_slot != null,
    );

    if (roundHasSlots) {
      return { ...row, match: null };
    }

    const ordinal = bySlot.get(`${key}:${index}`) ?? null;
    if (ordinal) {
      claimed.add(ordinal.id);
    }

    return { ...row, match: ordinal };
  });

  /*
   * Anything the generator created that no row claimed. With the generator walking the
   * same structure this sheet draws from, every game has a row, so this should stay empty.
   * It is kept rather than dropped because the alternative to an unrendered game is worse
   * than an extra card: a member would have a matchup they can neither see nor play.
   */
  const unclaimed = ordered.filter((match) => !claimed.has(match.id));

  for (const [index, row] of rowsForUnlistedGames(rows, unclaimed).entries()) {
    merged.push({ ...row, match: unclaimed[index] });
  }

  return merged;
}

/**
 * Draws the bracket, with winners above losers and the finals on the right.
 *
 * @param props - {@link PlayoffBracketProps}
 * @returns The bracket grid.
 */
export function PlayoffBracket({ rows, matches, resolveTeam }: PlayoffBracketProps) {
  const merged = withMatches(rows, matches);

  /*
   * Games indexed by their template label, so a slot fed by another game can look up
   * that game's result directly.
   */
  const byLabel = new Map(merged.map((row) => [row.game_label, row]));

  /**
   * Resolves a feeder reference to a team, without needing the fed game to exist.
   *
   * The bracket is drawn from the template, so a slot reading "G1 Winner" would keep
   * that wording until the owner advanced and created the game the slot belongs to.
   * But the reference is answerable the moment G1 is played, which is exactly what a
   * member is looking at after submitting a result. Resolving it against the finished
   * game fills the name in immediately, without waiting on anyone to advance.
   *
   * Returns null when the reference is unknown or the game it names is unfinished, and
   * the caller falls back to showing the reference text.
   *
   * A double forfeit settles the match with neither a winner nor a loser: the game is
   * finished, but nothing advanced out of it. Both references therefore resolve to null
   * here. Treating one of the two sides as the loser instead put a team into the slot that
   * the bracket had already left empty, which showed a matchup that the generator had
   * correctly refused to create.
   */
  const resolveFeeder = (feeder: string): string | null => {
    const reference = feederReference(feeder);

    if (!reference) {
      return null;
    }

    const source = byLabel.get(reference.game)?.match;

    /*
     * No winner means the game settled without producing one, which is what a double
     * forfeit records. Nothing advanced out of it, so neither its winner nor its loser
     * exists and the slot stays as the generator left it, empty.
     */
    if (!source?.winner_team_id) {
      return null;
    }

    if (reference.kind === "winner") {
      return source.winner_team_id;
    }

    return source.winner_team_id === source.player_1_team_id
      ? source.player_2_team_id
      : source.player_1_team_id;
  };

  /**
   * One side of a game. A real team renders in its own name and colour; an empty slot
   * renders the text describing what will fill it.
   *
   * `isBye` separates "nobody is going here" from "nobody has been decided yet". A bye is
   * already decided -- the game exists and it has one side -- so it says so, rather than
   * repeating feeder text for a game that is not coming.
   */
  const side = (
    teamId: string | null,
    feeder: string,
    match: ScheduleMatch | null,
    isWinner: boolean,
    isBye = false,
  ) => {
    const team = resolveTeam(teamId);
    const base =
      "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm";

    if (team) {
      return (
        <div
          className={`${base} ${
            isWinner
              ? "bg-emerald-900/40 font-semibold text-emerald-200"
              : "text-slate-300"
          }`}
        >
          <span className="truncate">{team.name}</span>
          {isWinner && <span className="text-emerald-400">&#10003;</span>}
        </div>
      );
    }

    // Nothing here yet. The feeder label says what is still to come, which is the
    // whole reason this bracket is drawn from the template rather than the matches.
    return (
      <div className={`${base} bg-slate-900/40 text-slate-500`}>
        <span className="truncate">{isBye ? "Bye" : feederLabel(feeder)}</span>
      </div>
    );
  };

  /** One game card: its label, then both sides. */
  const card = (row: SchedulePlayoffTemplateRow & { match: ScheduleMatch | null }) => {
    const winner = row.match?.winner_team_id ?? null;

    return (
      <div
        key={row.game_label}
        className={`space-y-1.5 rounded-xl border bg-slate-950/60 p-2 ${
          row.match
            ? "border-slate-800"
            : "border-dashed border-slate-800/70"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400/90">
            {row.game_label}
          </p>
          {row.is_reset && (
            <p
              className="text-[9px] uppercase tracking-wider text-slate-500"
              title="Only played if the grand final goes to a third game"
            >
              if needed
            </p>
          )}
        </div>
        {side(
          bracketSideTeam(
            Boolean(row.match),
            row.match?.player_1_team_id ?? null,
            row.team_a,
            () => resolveFeeder(row.feeder_a),
          ),
          row.feeder_a,
          row.match,
          winner === row.match?.player_1_team_id && Boolean(row.match),
          bracketSideIsBye(Boolean(row.match), row.match?.player_1_team_id ?? null),
        )}
        {side(
          bracketSideTeam(
            Boolean(row.match),
            row.match?.player_2_team_id ?? null,
            row.team_b,
            () => resolveFeeder(row.feeder_b),
          ),
          row.feeder_b,
          row.match,
          winner === row.match?.player_2_team_id && Boolean(row.match),
          bracketSideIsBye(Boolean(row.match), row.match?.player_2_team_id ?? null),
        )}
      </div>
    );
  };

  /**
   * A column of cards for one round.
   *
   * `justify-center` rather than `justify-around`: later rounds have fewer games than
   * the round before them, and spreading them to the full height left single cards
   * drifting away from the games that feed them. Centring keeps each round's cards
   * stacked together against the column's midpoint.
   *
   * The key belongs on the returned element, not on the call site, because this is
   * rendered through `.map()` and React keys the array items rather than the mapper.
   */
  const column = (round: number) => (
    <div
      key={round}
      className="flex min-w-[190px] shrink-0 flex-col justify-center gap-3"
    >
      {merged.filter((row) => row.round_no === round).map(card)}
    </div>
  );

  const section = (title: string, phase: string) => {
    const rounds = roundsFor(rows, phase);

    if (rounds.length === 0) {
      return null;
    }

    return (
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          {title}
        </p>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {rounds.map(column)}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-4">
      {section("Winners bracket", "upper")}
      {section("Losers bracket", "lower")}
      {section("Finals", "gf")}
      {section("Toilet Bowl", "toilet")}
    </div>
  );
}