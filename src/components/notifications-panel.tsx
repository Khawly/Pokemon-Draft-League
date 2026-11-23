/*
 * Notifications panel for the league dashboard.
 *
 * Renders the signed-in member's recent league notifications and the "clear
 * all" action. The dashboard places the panel in the post-draft grid and,
 * before the draft, beside the draft preview card.
 */
"use client";

import { SectionLabel } from "@/components/section-label";
import { formatNotificationAge, type DashboardNotification } from "@/lib/supabase/dashboard";

/** Props for {@link NotificationsPanel}. */
export interface NotificationsPanelProps {
  /** The member's newest notifications, already ordered newest first. */
  notifications: DashboardNotification[];
  /** IANA zone used for the relative age labels. */
  timeZone: string;
  /** Panel-level failure text from clearing notifications. */
  notificationError?: string | null;
  /** Panel-level confirmation text, e.g. how many notifications were cleared. */
  notificationNotice?: string | null;
  /** True while the clear request is in flight. */
  isClearingNotifications?: boolean;
  /** Omitted when the member has no way to clear notifications. */
  onClearNotifications?: () => void;
  /** Extra layout classes for the surrounding grid. */
  className?: string;
}

/**
 * Renders the dashboard's notifications card.
 *
 * Each entry shows the message, the Pokemon it concerns when the related trade
 * or free-agency move names any, and how long ago it arrived.
 *
 * @param props - {@link NotificationsPanelProps}
 * @returns The notifications panel.
 */
export function NotificationsPanel({
  notifications,
  timeZone,
  notificationError = null,
  notificationNotice = null,
  isClearingNotifications = false,
  onClearNotifications,
  className,
}: NotificationsPanelProps) {
  return (
    <div
      className={`rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg sm:p-6 shadow-slate-950/30${
        className ? ` ${className}` : ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>
          Notifications
        </SectionLabel>
        {/*
         * Always rendered, and disabled rather than hidden on an empty list.
         * Hiding it meant a member whose panel was empty had no visible way to
         * clear anything and no way to tell the control existed, which reads as
         * the feature being missing. Disabled still says there is nothing to
         * do, while the panel keeps offering the option the moment something
         * arrives.
         */}
        {onClearNotifications && (
          <button
            type="button"
            disabled={isClearingNotifications || notifications.length === 0}
            onClick={onClearNotifications}
            title={
              notifications.length === 0
                ? "There are no notifications to clear"
                : "Clear every notification for this season"
            }
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:border-rose-800 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-700 disabled:hover:text-slate-300"
          >
            {isClearingNotifications ? "Clearing..." : "Clear all"}
          </button>
        )}
      </div>
      {notificationError && (
        <p className="mt-3 text-xs text-rose-300">
          {notificationError}
        </p>
      )}
      {!notificationError && notificationNotice && (
        <p className="mt-3 text-xs text-emerald-300">
          {notificationNotice}
        </p>
      )}
      {notifications.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          You have no notifications for this season.
        </p>
      ) : (
        /*
        Capped at roughly four entries with the rest behind a scrollbar.
        The list is unbounded -- a busy trade week fills it -- and an
        uncapped one pushed the Schedule panel down the page, so a member
        arriving for their next match had to scroll past everything they had
        already seen.

        The height is in rem because entries are not a fixed size: a
        one-line message and a two-line one differ, so the cap lands on
        "about four" rather than exactly four. scrollbar-gutter reserves the
        gutter up front so the panel does not shift sideways when the list
        becomes scrollable as a new notification arrives.
      */
        <ul className="mt-4 max-h-[18rem] space-y-3 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent [scrollbar-gutter:stable]">
          {notifications.map((item) => (
            <li
              key={item.id}
              className="flex gap-3 rounded-xl bg-slate-800/70 p-3 text-sm text-slate-200"
            >
              <span
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                  item.is_read ? "bg-slate-600" : "bg-amber-400"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p>{item.message}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {formatNotificationAge(item.created_at, timeZone)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
