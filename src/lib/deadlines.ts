/*
 * Shared deadline checks for league windows that close at a saved instant.
 *
 * Trading and free agency both store an optional TIMESTAMPTZ. The database
 * enforces the same boundary on write; the pages use this helper to hide or
 * disable controls that would only produce a rejection.
 */

/**
 * Whether a stored deadline instant has arrived.
 *
 * A missing or invalid value means the window is open: the deadlines are
 * optional, and a bad value should not silently freeze a league.
 *
 * @param deadlineAt - ISO timestamp of the deadline, or null/undefined when off.
 * @param now - The instant to compare against; injectable for tests.
 * @returns True when the deadline exists and is at or before `now`.
 */
export function isDeadlinePassed(
  deadlineAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!deadlineAt) {
    return false;
  }

  const instant = new Date(deadlineAt).getTime();

  return Number.isFinite(instant) && instant <= now.getTime();
}
