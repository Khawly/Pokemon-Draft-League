/*
 * The league a member is currently looking at.
 *
 * It lives in localStorage because it is a browsing preference rather than anything the
 * database needs to know, and several parts of the shell have to agree on it: the league
 * switcher writes it, the navigation reads it, and the champion crown reads it so a league
 * switch does not leave the previous league's winner wearing a crown on every page.
 *
 * Kept here rather than in the switcher so the write and the change notification cannot
 * drift apart. Writing through {@link setSelectedLeague} is what tells the rest of the app
 * to look again; setting the item directly leaves everything else holding the old league.
 */

/** LocalStorage key holding the last league the member looked at. */
export const SELECTED_LEAGUE_STORAGE_KEY =
  "pokemon-draft-league:selected-league";

/** Fired on `window` when the selected league changes. */
export const SELECTED_LEAGUE_CHANGED_EVENT = "pdl:selected-league-changed";

/**
 * Reads the selected league id.
 *
 * @returns The stored id, or null when there is none or storage is unavailable.
 */
export function getSelectedLeague(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(SELECTED_LEAGUE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Stores the selected league and tells the app it changed.
 *
 * @param leagueId - The league to remember.
 */
export function setSelectedLeague(leagueId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(SELECTED_LEAGUE_STORAGE_KEY, leagueId);
  } catch {
    // Storage can be unavailable; the switch still works for this page.
  }

  window.dispatchEvent(new Event(SELECTED_LEAGUE_CHANGED_EVENT));
}

/**
 * Forgets the stored league, e.g. after the selected league is deleted.
 *
 * Removes the preference and announces the change so the shell and crown scope
 * stop pointing at a league that no longer exists.
 *
 * @param leagueId - When supplied, the stored choice is only cleared if it is
 *   this league. A page viewing a league from the URL should not clear a
 *   different league the member had chosen.
 */
export function clearSelectedLeague(leagueId?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (leagueId) {
    const stored = getSelectedLeague();

    if (stored && stored !== leagueId) {
      return;
    }
  }

  try {
    window.localStorage.removeItem(SELECTED_LEAGUE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable; the app still resolves a fallback league.
  }

  window.dispatchEvent(new Event(SELECTED_LEAGUE_CHANGED_EVENT));
}