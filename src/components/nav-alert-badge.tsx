/*
 * The notification markers shown on navigation buttons and tabs.
 *
 * Every nav entry in the app that carries a number renders it through this module:
 * the dashboard's Schedule and Trades buttons, and the Trades page's "My Trades" and
 * "Approvals" tabs. It started as a single pill in the dashboard shell and was then
 * retyped by hand on the trades page, which is how the two ended up rendering
 * different treatments for the same kind of fact. One module, imported everywhere,
 * makes "the same format" a property of the code rather than something to remember.
 *
 * {@link TabNotification} is the convention itself, and is what a new page or tab
 * should reach for: supply both counts and it decides which of the two forms applies.
 * Red is reserved for "there is something here waiting on you"; anything purely
 * informational gets a quiet count, because colouring a list of completed records
 * red would be asking the member to act about nothing.
 */
import type { ReactNode } from "react";

/** Props for the {@link NavAlertBadge} component. */
export interface NavAlertBadgeProps {
  /** How many unread alerts to show. Nothing renders at zero. */
  count: number;
  /**
   * What the alerts concern, used to build the screen-reader label, e.g.
   * `"match time"` reads as "3 unread match time updates".
   */
  subject: string;
  /**
   * Rendered inside the pill, for callers that need to override the default count
   * text. Rarely needed; prefer `count`.
   */
  children?: ReactNode;
}

/**
 * The unread-alert pill shown on a nav button.
 *
 * Absolutely positioned into the button's top-right corner and nudged up so it
 * straddles the pill-shaped button rather than sitting inside it, and given a ring
 * in the page background colour so it stays legible where it overlaps.
 *
 * @param props - {@link NavAlertBadgeProps}
 * @returns The badge, or null when there is nothing to report.
 */
export function NavAlertBadge({ count, subject, children }: NavAlertBadgeProps) {
  if (count <= 0) {
    return null;
  }

  return (
    <span
      className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-slate-900 bg-rose-500 px-1 text-[11px] font-bold leading-none text-white"
      aria-label={`${count} unread ${subject} update${count === 1 ? "" : "s"}`}
    >
      {children ?? (count > 99 ? "99+" : count)}
    </span>
  );
}

/**
 * Props for the {@link TabNotification} component.
 */
export interface TabNotificationProps {
  /**
   * Items waiting on the member, drawn as the red bubble. Zero means nothing is
   * waiting, whatever the tab's total is.
   */
  badge: number;
  /**
   * Rows the tab holds, shown as a quiet count whenever there is no bubble, so a tab
   * the member has already dealt with still says it is not empty.
   */
  total: number;
  /**
   * What the bubble's screen-reader label calls these, e.g. `"trade"` reads as
   * "2 unread trade updates".
   */
  subject: string;
}

/**
 * A navigation entry's notification marker, in whichever of the two forms applies.
 *
 * This is the app-wide convention for putting a number on a nav button or tab, and
 * it is a component rather than a pattern to copy so that every entry decides the
 * same way:
 *
 *   - Something is live for the member: the red bubble, straddling the top-right
 *     corner, carrying the number of outstanding items.
 *   - Nothing live: a quiet inline count, because the tab still has contents worth
 *     knowing about.
 *   - Neither: nothing at all.
 *
 * The dividing line is intent, not size, which is why a caller supplies both counts
 * instead of one. A caller must therefore answer a question the component cannot:
 * what counts as "live"? The answer differs per domain, and a surface should count
 * what its member would want interrupting them for -- an unanswered proposal, a
 * decision owed, an unsettled negotiation -- rather than merely recent news. See
 * `countOpenTrades` in the data layer for how the trades page answers it.
 *
 * @param props - {@link TabNotificationProps}
 * @returns The bubble, a quiet count, or nothing.
 */
export function TabNotification({ badge, total, subject }: TabNotificationProps) {
  if (badge > 0) {
    return <NavAlertBadge count={badge} subject={subject} />;
  }

  if (total <= 0) {
    return null;
  }

  return <span className="ml-1.5 text-xs opacity-80">{total}</span>;
}
