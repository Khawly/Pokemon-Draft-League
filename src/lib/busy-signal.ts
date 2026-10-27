/*
 * App-wide "league is busy" signal.
 *
 * Supabase can answer a read with 429/502/503/504 when shared CPU or the
 * connection pooler is saturated. The retry wrapper retries reads, but after the
 * budget is spent the page still needs a clear state. This signal lets the
 * global chrome show one notice regardless of which page or loader hit the
 * limit, instead of every page inventing its own wording.
 */

/** Fired on `window` when a request remains rate-limited after retries. */
export const LEAGUE_BUSY_EVENT = "pdl:league-busy";

/** Message shown in the global busy notice. */
export const LEAGUE_BUSY_MESSAGE =
  "The league is busy right now. Please try again in a moment.";

/**
 * Tells the global chrome to show the busy notice.
 *
 * Safe on the server (no `window`); the event simply has no listener there.
 */
export function announceLeagueBusy(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(LEAGUE_BUSY_EVENT));
  }
}
