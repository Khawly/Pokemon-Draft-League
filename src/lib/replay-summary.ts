/*
 * Client helper for the Pokemon Showdown replay summary route.
 *
 * The browser cannot read a battle log itself: Showdown sends no CORS headers
 * for the replay host, and the fetch must stay server-side so the host allowlist
 * and the participant check in `POST /api/replay/summary` apply. This module is
 * the thin typed wrapper the schedule page uses to call that route.
 */

/** What the route reports about one replay, already resolved against a match. */
export type ReplaySummaryResult = {
  /** The replay's tier line, e.g. `[Gen 9] NatDex 6v6 Doubles Draft`. */
  format: string | null;
  /** How many turns the game lasted. */
  turnCount: number | null;
  /** The Showdown usernames in the replay, keyed by the side they played. */
  players: Record<string, string>;
  /** The league team that won, when the replay's usernames match a participant. */
  winnerTeamId: string | null;
  /** The Showdown username credited with the win. */
  winnerName: string | null;
  /** Unsigned surviving count for the winner; null unless the game was a knockout. */
  pokemonLeftAlive: number | null;
  kosFor: number;
  kosAgainst: number;
  /** Whether the game ended by knockout, which is what makes a count scoreable. */
  conclusive: boolean;
  /** Why the count is unavailable, in the user's terms. */
  note: string | null;
};

/** Thrown when the route refuses or cannot read a replay. */
export class ReplayReadError extends Error {}

/**
 * Asks the server to read a replay link and resolve it against a match.
 *
 * @param replayUrl - The Showdown replay link pasted into the form.
 * @param matchId - The match whose two teams the winner should be matched to.
 * @returns The resolved replay summary.
 * @throws {ReplayReadError} When the link is unreadable or the caller may not
 *   read replays for that match.
 */
export async function readReplaySummary(
  replayUrl: string,
  matchId: string,
): Promise<ReplaySummaryResult> {
  const response = await fetch("/api/replay/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replayUrl, matchId }),
  });

  const payload = (await response.json().catch(() => null)) as
    | (Partial<ReplaySummaryResult> & { error?: string })
    | null;

  if (!response.ok) {
    throw new ReplayReadError(
      payload?.error ?? "That replay could not be read.",
    );
  }

  return payload as ReplaySummaryResult;
}
