/*
 * Change signal for the global league sub-navigation's alert badges.
 *
 * The badges live in the root layout, while "Clear all notifications" is owned by
 * the dashboard page. Rather than sharing state through a provider for one
 * event, the dashboard announces that alerts may have changed and the
 * sub-navigation re-reads its own two counts. Any future surface that resolves
 * alerts can do the same without knowing who renders the badges.
 */

/** Fired on `window` when the member's unread nav alerts may have changed. */
export const NAV_ALERTS_CHANGED_EVENT = "pdl:nav-alerts-changed";

/**
 * Tells the sub-navigation to re-read its alert badges.
 *
 * Safe to call when there is no sub-navigation mounted; the event simply has no
 * listener.
 */
export function announceNavAlertsChanged(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(NAV_ALERTS_CHANGED_EVENT));
}
