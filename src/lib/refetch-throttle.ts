/*
 * Refetch throttling for realtime invalidation.
 *
 * A realtime subscription turns every change to a watched table into a refetch, and a
 * refetch here is not cheap: the schedule page re-reads its whole payload, which is a
 * dozen requests across leagues, seasons, teams, profiles, matches, results, proposals,
 * settings and the bracket template.
 *
 * Coalescing alone does not bound the cost. A debounce only merges changes that arrive
 * within the quiet window of each other, so a sustained stream of writes refetches once
 * per window for as long as the stream lasts. A batch job writing rows at a few per
 * second drove the schedule page to a refetch every 250ms, which is roughly sixty
 * requests a second from one open tab, and a day of that is what filled the log drain.
 *
 * So the delay is a floor as well as a debounce: at least a quiet period since the last
 * event, and at least a minimum spacing since the last refetch actually happened. The
 * first keeps a single change feeling immediate; the second bounds the worst case no
 * matter how fast the writes arrive.
 *
 * The same reasoning applied to a tab nobody is looking at is why a hidden document
 * defers rather than refetches: the update would be spent on pixels that are not on
 * screen, and applied from stale state the moment the tab is shown again anyway.
 */

/**
 * How long to wait before applying a coalesced batch of realtime changes.
 *
 * @param now - Current time in milliseconds.
 * @param lastAppliedAt - When the last batch was applied, or null if none has been.
 * @param debounceMs - Quiet period to leave after the most recent change.
 * @param minIntervalMs - Minimum spacing between one batch being applied and the next.
 * @returns The delay in milliseconds before the batch may be applied.
 */
export function refetchDelayMs(
  now: number,
  lastAppliedAt: number | null,
  debounceMs: number,
  minIntervalMs: number,
): number {
  if (lastAppliedAt === null) {
    return debounceMs;
  }

  // The earliest the cooldown allows the next batch, which may already have passed.
  const earliest = lastAppliedAt + minIntervalMs;

  return Math.max(debounceMs, earliest - now);
}

/**
 * Whether the document is hidden, so a refetch would be spent on a tab nobody is
 * looking at.
 *
 * Takes the value rather than reading `document`, so the decision can be tested without
 * a DOM. A document with no value at all is treated as visible: a refetch that turns out
 * to be unnecessary is recoverable, while one that is skipped and never retried is not.
 *
 * @param visibilityState - The document's visibility state.
 * @returns True when the document is hidden.
 */
export function isDocumentHidden(
  visibilityState: string | undefined,
): boolean {
  return visibilityState === "hidden";
}