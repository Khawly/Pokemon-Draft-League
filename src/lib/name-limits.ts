/*
 * Shared length limit for user-facing names.
 *
 * Display names, league names, and season names all occupy the same compact
 * headings and selectors, so they share one cap. The database enforces the same
 * number in the relevant CHECK constraints; keep the two in step.
 */

/** Longest display, league, or season name accepted, in characters. */
export const MAX_NAME_LENGTH = 32;
