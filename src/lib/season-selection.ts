/*
 * The season a member is looking at, when it is not simply the newest one.
 *
 * A league runs a new season each year, and the pages that show results, standings and
 * rosters should be able to look back at any of them. This holds the choice the way the
 * league choice is held: in localStorage, announced through an event, so the header, the
 * pages and anything else that cares agree without being wired together.
 *
 * Stored per league. Looking at season 1 of one league should not change which season of
 * another is on screen, and a season id from a league the member switches to is meaningless
 * there.
 */

/** Prefix of the per-league localStorage key holding the chosen season. */
const SELECTED_SEASON_KEY_PREFIX = "pokemon-draft-league:selected-season:";

/** Fired on `window` when the chosen season changes. */
export const SELECTED_SEASON_CHANGED_EVENT = "pdl:selected-season-changed";

/**
 * Reads the chosen season for a league.
 *
 * @param leagueId - The league whose choice to read.
 * @returns The stored season id, or null when none is stored.
 */
export function getSelectedSeason(leagueId: string | null): string | null {
  if (!leagueId || typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(SELECTED_SEASON_KEY_PREFIX + leagueId);
  } catch {
    return null;
  }
}

/**
 * Stores the chosen season for a league and tells the app it changed.
 *
 * @param leagueId - The league the season belongs to.
 * @param seasonId - The season to show from now on.
 */
export function setSelectedSeason(leagueId: string, seasonId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      SELECTED_SEASON_KEY_PREFIX + leagueId,
      seasonId,
    );
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }

  window.dispatchEvent(new Event(SELECTED_SEASON_CHANGED_EVENT));
}