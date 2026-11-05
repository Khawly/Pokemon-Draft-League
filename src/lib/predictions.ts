/*
 * Winner-prediction rules for a matchup.
 *
 * The database re-checks these rules on every write, but the page needs the same
 * answer to decide whether to offer the picker or say why it is closed. Keeping
 * the rule pure here means the two can be tested without a browser or a live
 * match, and the wording used on the card comes from one place.
 */

/** The match fields the prediction lock reads. */
export type PredictionMatch = {
  /** The match lifecycle status, as stored on `matches.status`. */
  status: string;
  /** The agreed kickoff, or null while the players have not set one. */
  scheduled_at: string | null;
  /** Null on a one-sided playoff bye, which has nobody to predict against. */
  player_2_team_id: string | null;
  /** Submitted games. Any row closes predictions. */
  results: readonly unknown[];
};

/** Why a matchup no longer accepts winner picks. */
export type PredictionLockReason = "bye" | "result" | "time" | "closed";

/**
 * Explains why predictions are closed for a matchup, or null when they are open.
 *
 * A result closes the picker even when the match row has not been recomputed to
 * `in_progress` yet. The scheduled time closes it at the instant it arrives, not
 * after the match is settled, which is what stops a member picking once the
 * players are already battling.
 *
 * @param match - The matchup being predicted.
 * @param now - The instant to compare the kickoff against; injectable for tests.
 * @returns The reason picks are closed, or null while they are open.
 */
export function predictionLockReason(
  match: PredictionMatch,
  now: Date = new Date(),
): PredictionLockReason | null {
  if (!match.player_2_team_id) {
    return "bye";
  }

  if (match.results.length > 0 || match.status === "in_progress") {
    return "result";
  }

  if (match.status !== "scheduled" && match.status !== "unscheduled") {
    return "closed";
  }

  if (
    match.scheduled_at !== null &&
    new Date(match.scheduled_at).getTime() <= now.getTime()
  ) {
    return "time";
  }

  return null;
}

/**
 * Whether the matchup is still accepting winner picks.
 *
 * @param match - The matchup being predicted.
 * @param now - The instant to compare the kickoff against; injectable for tests.
 * @returns True when the member may pick or change a winner.
 */
export function predictionIsOpen(
  match: PredictionMatch,
  now: Date = new Date(),
): boolean {
  return predictionLockReason(match, now) === null;
}

/**
 * Human-readable reason a matchup's predictions are closed.
 *
 * @param reason - The value returned by {@link predictionLockReason}.
 * @returns A short sentence for the matchup card.
 */
export function predictionLockMessage(reason: PredictionLockReason): string {
  switch (reason) {
    case "bye":
      return "This matchup has no opponent to predict against.";
    case "result":
      return "Predictions closed once a game was submitted.";
    case "time":
      return "Predictions closed at the scheduled match time.";
    case "closed":
      return "This matchup is no longer open for predictions.";
  }
}
