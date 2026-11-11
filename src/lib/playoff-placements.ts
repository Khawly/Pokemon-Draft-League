/*
 * Derives playoff finishing order from a season's bracket results.
 *
 * The database names the champion (`playoff_champion`) but does not store where
 * everyone else finished. The standings table needs the runners-up for the E4
 * badge, so this reconstructs the order from when each team took its final loss:
 * the later a team was eliminated, the higher it finished. Teams knocked out in
 * the same round are ordered by their regular-season seed, which is the
 * conventional way to separate tied semifinalists.
 */

/** The bracket phases a playoff match can belong to. */
export type PlayoffPhase = "upper" | "lower" | "gf" | "toilet" | null;

/** The match fields the placement calculation reads. */
export interface PlayoffPlacementMatch {
  /** Week the match was scheduled in; later weeks mean later elimination. */
  week_number: number;
  /** Bracket phase, or null on an older match written before the column existed. */
  bracket_phase: PlayoffPhase;
  /** Position within the phase's round, used only as a stable fallback. */
  bracket_slot: number | null;
  /** Match status, so unfinished games never eliminate anyone. */
  status: string;
  /** The side that won, or null when no winner was recorded (e.g. a double forfeit). */
  winner_team_id: string | null;
  /** The first side of the match. */
  player_1_team_id: string;
  /** The second side, or null on a one-sided playoff bye. */
  player_2_team_id: string | null;
}

/** Inputs for {@link computePlayoffPlacements}. */
export interface PlayoffPlacementsInput {
  /** The season's playoff format, which decides how many losses eliminate a team. */
  format: "single_elimination" | "double_elimination";
  /** Every playoff match in the season, including unfinished ones. */
  matches: readonly PlayoffPlacementMatch[];
  /** The team the database named champion. */
  championTeamId: string;
  /**
   * Regular-season ranking, best first. Used to break ties between teams
   * eliminated in the same round.
   */
  standingsOrder: readonly string[];
}

/** Statuses that mean a match is over and its winner, if any, counts. */
const SETTLED_STATUSES = new Set(["completed", "forfeit", "cancelled"]);

/**
 * Ranks a bracket phase so two eliminations in the same week can still be
 * ordered. The grand final comes last, then the losers bracket, then the
 * winners bracket.
 *
 * @param phase - The match's bracket phase.
 * @returns A larger number for a later phase.
 */
function phaseRank(phase: PlayoffPhase): number {
  if (phase === "gf") {
    return 3;
  }

  if (phase === "lower") {
    return 2;
  }

  return 1;
}

/**
 * Orders a season's playoff field from champion down through the eliminated
 * teams.
 *
 * The champion is always first. Every other team is placed by the week it was
 * eliminated, latest first, then by bracket phase, then by its regular-season
 * seed. The toilet bracket is ignored: it is a consolation tournament and does
 * not decide playoff placement.
 *
 * @param input - {@link PlayoffPlacementsInput}
 * @returns Team ids from first place to last known finisher.
 */
export function computePlayoffPlacements({
  format,
  matches,
  championTeamId,
  standingsOrder,
}: PlayoffPlacementsInput): string[] {
  const lossLimit = format === "double_elimination" ? 2 : 1;
  const losses = new Map<string, number>();
  const eliminated = new Map<
    string,
    { week: number; phaseRank: number; slot: number }
  >();

  for (const match of matches) {
    // The consolation bracket is not a playoff placement.
    if (match.bracket_phase === "toilet") {
      continue;
    }

    if (!SETTLED_STATUSES.has(match.status)) {
      continue;
    }

    const winner = match.winner_team_id;
    const first = match.player_1_team_id;
    const second = match.player_2_team_id;

    // A bye or a double forfeit has no losing side to charge with a loss.
    if (!winner || !first || !second) {
      continue;
    }

    const loser = winner === first ? second : winner === second ? first : null;

    if (!loser) {
      continue;
    }

    const nextLosses = (losses.get(loser) ?? 0) + 1;
    losses.set(loser, nextLosses);

    /*
     * Record only the first elimination. A stray result after a team was already
     * out must not move the game that actually ended their run.
     */
    if (nextLosses >= lossLimit && !eliminated.has(loser)) {
      eliminated.set(loser, {
        week: match.week_number,
        phaseRank: phaseRank(match.bracket_phase),
        slot: match.bracket_slot ?? 0,
      });
    }
  }

  const seedRank = new Map(
    standingsOrder.map((teamId, index) => [teamId, index]),
  );
  const missingSeed = Number.MAX_SAFE_INTEGER;

  const finishers = [...eliminated.entries()]
    .filter(([teamId]) => teamId !== championTeamId)
    .sort((a, b) => {
      if (a[1].week !== b[1].week) {
        return b[1].week - a[1].week;
      }

      if (a[1].phaseRank !== b[1].phaseRank) {
        return b[1].phaseRank - a[1].phaseRank;
      }

      const seedDifference =
        (seedRank.get(a[0]) ?? missingSeed) -
        (seedRank.get(b[0]) ?? missingSeed);

      if (seedDifference !== 0) {
        return seedDifference;
      }

      return a[1].slot - b[1].slot;
    })
    .map(([teamId]) => teamId);

  return [championTeamId, ...finishers];
}
