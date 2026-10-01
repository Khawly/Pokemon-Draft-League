/*
 * Dashboard page for the Pokemon Draft League.
 *
 * Verifies the signed-in user's session, resolves the active league, and
 * renders the dashboard shell with the user's profile plus the league's live
 * season data (standings, schedule, pool, roster, trades, notifications).
 */

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { supabase } from "@/lib/supabase/client";
import {
  clearAllNotifications,
  loadDashboardData,
  loadMatchTimeAlerts,
  loadTradeAlerts,
  type DashboardGoods,
} from "@/lib/supabase/dashboard";
import { useRealtimeInvalidation } from "@/lib/use-realtime-invalidation";
import { markNotificationsRead } from "@/lib/supabase/schedule";

/**
 * Streams the dashboard content behind a Suspense loading fallback so the
 * useSearchParams hook can be used without an error boundary.
 */
export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading dashboard...
          </div>
        </main>
      }
    >
      <DashboardPageContent />
    </Suspense>
  );
}

/**
 * Loads the current user's profile and active league name and renders the
 * DashboardShell. Redirects to the home page when there is no session.
 */
function DashboardPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessionUser, setSessionUser] = useState<{
    email: string | null;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);
  const [leagueName, setLeagueName] = useState<string | null>(null);
  const [goods, setGoods] = useState<DashboardGoods | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  /**
   * Panel-level feedback for the notification list. Deliberately separate from
   * the page-level `error`, which replaces the entire dashboard: a failure to
   * clear one panel is not a failure of the league, and blanking the page to say
   * so would throw away everything the member can still read.
   */
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isClearingNotifications, setIsClearingNotifications] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  /*
   * The effect below owns the load, but a real-time match change needs to re-run
   * it from outside. A ref is used rather than lifting the function to component
   * scope because it closes over the effect's own dependencies, and moving it
   * would mean duplicating the league resolution.
   */
  const loadLeagueRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    async function syncSessionUser(
      session: Awaited<
        ReturnType<typeof supabase.auth.getSession>
      >["data"]["session"],
    ) {
      // Auth guard: bounce unsigned-in visitors back to the landing page.
      if (!session?.user) {
        router.replace("/");
        return;
      }

      const user = session.user;

      /*
       * The profile row is the authority for the display name, not the auth
       * metadata: the profile is what every other page reads, so reading the
       * metadata here is what made the header disagree with the rest of the app
       * after a rename. The metadata and the email local part remain as
       * fallbacks for a profile that has not been provisioned yet.
       */
      const { data: profileData } = await supabase
        .from("profiles")
        .select("display_name, avatar_url")
        .eq("id", user.id)
        .maybeSingle();

      const displayName =
        (profileData?.display_name as string | undefined) ||
        (user.user_metadata?.display_name as string | undefined) ||
        user.email?.split("@")[0] ||
        "Trainer";

      setSessionUser({
        email: user.email ?? "Unknown email",
        displayName,
        avatarUrl: (profileData?.avatar_url as string | null) ?? null,
      });
    }

    /**
     * Resolves the active league, then loads every season value the dashboard
     * renders (standings, schedule, pool, roster, trades, notifications).
     *
     * The current season is the latest one belonging to the resolved league,
     * matching the lookup used by the other league pages.
     */
    async function loadLeague() {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setLeagueName("League Name");
        setGoods(null);
        return;
      }

      const selectedLeagueId = searchParams.get("leagueId");

      // Prefer the league from the query param, else the most recently joined active one.
      let query = supabase
        .from("league_members")
        .select("league_id, leagues(name)")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("joined_at", { ascending: false })
        .limit(1);

      if (selectedLeagueId) {
        query = supabase
          .from("league_members")
          .select("league_id, leagues(name)")
          .eq("user_id", user.id)
          .eq("league_id", selectedLeagueId)
          .eq("is_active", true)
          .limit(1);
      }

      const { data, error } = await query;

      if (error || !data || data.length === 0) {
        setLeagueName("League Name");
        setGoods(null);
        return;
      }

      const nextLeagueName = (data[0] as { leagues?: { name?: string | null } })
        .leagues?.name;
      setLeagueName(nextLeagueName || "League Name");

      const resolvedLeagueId = (data[0] as { league_id?: string | null })
        .league_id;

      if (!resolvedLeagueId) {
        setGoods(null);
        return;
      }

      try {
        const next = await loadDashboardData(resolvedLeagueId, user.id);
        setGoods(next);
        setError(null);
      } catch (loadError) {
        setGoods(null);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "The league could not be loaded.",
        );
      }
    }

    loadLeagueRef.current = loadLeague;

    async function loadSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await syncSessionUser(session);
      await loadLeague();
      setIsLoading(false);
    }

    loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      await syncSessionUser(session);
      await loadLeague();
    });

    const handleProfileUpdated = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await syncSessionUser(session);
      await loadLeague();
    };

    window.addEventListener("profile-updated", handleProfileUpdated);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("profile-updated", handleProfileUpdated);
      loadLeagueRef.current = null;
    };
  }, [router, searchParams]);

  /** Re-runs the league load, for a real-time change to a match. */
  const reloadLeague = useCallback(async () => {
    await loadLeagueRef.current?.();
  }, []);

  /**
   * Clears this week's match-time alerts when the member opens the schedule.
   *
   * The badge is dropped from local state first so it disappears the instant the
   * Schedule tab is pressed rather than after a round trip; a failed write simply
   * brings the count back on the next load, which is a far smaller problem than
   * a badge that refuses to clear.
   */
  async function handleScheduleVisited() {
    const ids = goods?.matchTimeAlertIds ?? [];

    if (ids.length === 0) {
      return;
    }

    setGoods((current) =>
      current
        ? { ...current, matchTimeAlertIds: [], matchTimeAlertCount: 0 }
        : current,
    );

    try {
      await markNotificationsRead(ids);
    } catch {
      // The next load restores whatever is genuinely still unread.
    }
  }

  /*
   * Identical handling to the schedule badge, and for the same reason: opening the
   * Trades page is the member going to deal with the alert, so the count drops
   * locally first and the read state is written behind it.
   */
  async function handleTradesVisited() {
    const ids = goods?.tradeAlertIds ?? [];

    if (ids.length === 0) {
      return;
    }

    setGoods((current) =>
      current
        ? { ...current, tradeAlertIds: [], tradeAlertCount: 0 }
        : current,
    );

    try {
      await markNotificationsRead(ids);
    } catch {
      // The next load restores whatever is genuinely still unread.
    }
  }

  /*
   * Clearing notifications is a delete, so it is confirmed first. The dialog copy
   * names the scope, because "clear all" on a panel that shows five of the
   * member's forty would otherwise read as removing only what is on screen.
   */
  const handleClearNotifications = useCallback(async () => {
    const leagueId = goods?.leagueId;

    if (!leagueId) {
      return;
    }

    const confirmed = await confirm({
      title: "Clear all notifications?",
      detail:
        "This removes every notification for this league, including any you have not read. It cannot be undone.",
      confirmLabel: "Clear all",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    setIsClearingNotifications(true);
    setNotificationError(null);

    try {
      const removed = await clearAllNotifications(leagueId);

      /*
       * The match-time and trade alerts behind the two nav badges are notifications
       * too, so they are gone along with the list and the badges have to go with
       * them. The panel only ever holds this league's rows, and every one of them is
       * gone, so all four fields are emptied rather than refetched.
       */
      setGoods((current) =>
        current
          ? {
              ...current,
              notifications: [],
              matchTimeAlertIds: [],
              matchTimeAlertCount: 0,
              tradeAlertIds: [],
              tradeAlertCount: 0,
            }
          : current,
      );

      setNotice(
        removed === 1
          ? "1 notification cleared."
          : `${removed} notifications cleared.`,
      );
    } catch (clearError) {
      /*
       * Reported inside the panel rather than through the page-level error, which
       * replaces the whole dashboard. A failed clear is a problem with one panel,
       * not with the league.
       */
      setNotificationError(
        clearError instanceof Error
          ? clearError.message
          : "Notifications could not be cleared.",
      );
    } finally {
      setIsClearingNotifications(false);
    }
  }, [goods?.leagueId, confirm]);

  /**
   * Refreshes only the two nav badges, for a notification or trade change that
   * arrived while the dashboard was open.
   *
   * A new notification is by far the most common real-time event and it changes
   * nothing on this page but the badges, so this deliberately avoids re-running the
   * full dashboard load, which pages the entire draft pool and reads every roster.
   */
  const refreshAlerts = useCallback(async () => {
    const leagueId = goods?.leagueId;

    if (!leagueId) {
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;

    if (!userId) {
      return;
    }

    /*
     * Both badges in one pass. They are driven by the same table and the same
     * visit-clears-it rule, so splitting them would mean two round trips to redraw
     * two numbers that a single notification can move at once.
     */
    const [alerts, tradeAlerts] = await Promise.all([
      loadMatchTimeAlerts(leagueId, userId),
      loadTradeAlerts(leagueId, userId),
    ]);

    setGoods((previous) =>
      previous
        ? {
            ...previous,
            matchTimeAlertIds: alerts.ids,
            matchTimeAlertCount: alerts.count,
            tradeAlertIds: tradeAlerts.ids,
            tradeAlertCount: tradeAlerts.count,
          }
        : previous,
    );
  }, [goods?.leagueId]);

  /*
   * Live updates, scoped to what each table actually changes. A notification only
   * moves a badge, so it takes the cheap path; a match changing status, time, or
   * result changes the schedule, the week, and the standings, so it reloads the
   * page's data. A trade only moves its own badge and the tab list it appears in,
   * so it takes the cheap path too.
   */
  useRealtimeInvalidation({
    leagueId: goods?.leagueId ?? null,
    watchers: [
      { table: "notifications", onChange: () => void refreshAlerts() },
      { table: "matches", onChange: () => void reloadLeague() },
      { table: "trades", onChange: () => void refreshAlerts() },
    ],
  });

  if (isLoading || !sessionUser || !leagueName) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_rgba(15,23,42,0.2)_30%,_#020817_100%)] px-4 py-10">
        <div className="rounded-2xl border border-slate-700 bg-slate-900 px-6 py-4 text-sm font-medium text-slate-200 shadow-lg shadow-slate-950/40">
          Loading the Home Page...
        </div>
      </main>
    );
  }

  if (error || !goods) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <div className="max-w-md rounded-2xl border border-red-900 bg-red-950/40 px-6 py-4 text-center text-sm text-red-200 shadow-lg shadow-slate-950/40">
          {error ?? "This league is not available."}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <DashboardShell
          displayName={sessionUser.displayName}
          email={sessionUser.email ?? "Unknown email"}
          avatarUrl={sessionUser.avatarUrl}
          leagueName={leagueName}
          leagueId={searchParams.get("leagueId") ?? null}
          goods={goods}
          onScheduleVisited={() => void handleScheduleVisited()}
          onTradesVisited={() => void handleTradesVisited()}
          onClearNotifications={() => void handleClearNotifications()}
          isClearingNotifications={isClearingNotifications}
          notificationError={notificationError}
          notificationNotice={notice}
        />
      </div>
      {confirmDialog}
    </main>
  );
}
