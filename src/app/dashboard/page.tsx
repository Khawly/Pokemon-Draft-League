/*
 * Dashboard page for the Pokemon Draft League.
 *
 * Verifies the signed-in user's session, resolves the active league, and
 * renders the dashboard shell with the user's profile plus the league's live
 * season data (standings, schedule, pool, roster, trades, notifications).
 *
 * The profile read here also carries the member's chosen name colour and avatar
 * initials, which are handed to the shell so the header renders their name and
 * their avatar the same way as every other page in the app.
 */

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { CrownProvider } from "@/components/crown-provider";
import { useConfirm } from "@/components/confirm-dialog";
import { supabase } from "@/lib/supabase/client";
import {
  clearAllNotifications,
  loadDashboardData,
  type DashboardGoods,
  type DashboardMatch,
} from "@/lib/supabase/dashboard";
import { setMatchPrediction } from "@/lib/supabase/schedule";
import { useRealtimeInvalidation } from "@/lib/use-realtime-invalidation";
import { getSelectedSeason } from "@/lib/season-selection";
import { announceNavAlertsChanged } from "@/lib/nav-alerts";
import { LoadingGif } from "@/components/loading-gif";

/**
 * Streams the dashboard content behind a Suspense loading fallback so the
 * useSearchParams hook can be used without an error boundary.
 */
export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100 sm:px-6 sm:py-10">
          <div className="mx-auto max-w-[96rem] rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            <LoadingGif label="Loading dashboard" />
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
    id: string;
    displayName: string;
    avatarUrl: string | null;
    avatarInitials: string | null;
    nameColor: string | null;
  } | null>(null);
  const [leagueName, setLeagueName] = useState<string | null>(null);
  const [goods, setGoods] = useState<DashboardGoods | null>(null);
  /** True once the signed-in member is known to have no active league memberships. */
  const [hasNoLeagues, setHasNoLeagues] = useState(false);
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
  /** The matchup whose prediction is being saved, if any. */
  const [predictingMatchId, setPredictingMatchId] = useState<string | null>(
    null,
  );
  /** Panel-level failure text for a prediction that could not be saved. */
  const [predictionError, setPredictionError] = useState<string | null>(null);
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
        .select("display_name, avatar_url, avatar_initials, name_color")
        .eq("id", user.id)
        .maybeSingle();

      const displayName =
        (profileData?.display_name as string | undefined) ||
        (user.user_metadata?.display_name as string | undefined) ||
        user.email?.split("@")[0] ||
        "Trainer";

      setSessionUser({
        id: user.id,
        displayName,
        avatarUrl: (profileData?.avatar_url as string | null) ?? null,
        avatarInitials: (profileData?.avatar_initials as string | null) ?? null,
        nameColor: (profileData?.name_color as string | null) ?? null,
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

      /*
       * The membership read can land a moment before a just-created league's
       * membership row is visible through PostgREST on a slow mobile connection.
       * Retrying the same scoped query avoids showing "unavailable" for a league
       * the account has just created.
       */
      const fetchMembership = () => {
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

        return query;
      };

      let membershipResult = await fetchMembership();

      for (
        let attempt = 0;
        attempt < 3 &&
        !membershipResult.error &&
        (!membershipResult.data || membershipResult.data.length === 0) &&
        selectedLeagueId;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        membershipResult = await fetchMembership();
      }

      const { data, error } = membershipResult;

      const resolvedError = error;
      let resolvedData = data;

      /*
       * If the id in the URL does not resolve, fall back to the most recent
       * active membership rather than claiming the league is unavailable. A
       * stale link after leaving a league is the common case.
       */
      if (
        !resolvedError &&
        selectedLeagueId &&
        (!resolvedData || resolvedData.length === 0)
      ) {
        const fallback = await supabase
          .from("league_members")
          .select("league_id, leagues(name)")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .order("joined_at", { ascending: false })
          .limit(1);

        if (!fallback.error && fallback.data && fallback.data.length > 0) {
          resolvedData = fallback.data;
        }
      }

      if (resolvedError || !resolvedData || resolvedData.length === 0) {
        setLeagueName("League Name");
        setGoods(null);

        /*
         * Distinguish "this account belongs to no leagues" from "the requested
         * league is missing or inaccessible". The first gets the onboarding
         * screen; the second keeps the ordinary unavailable message.
         */
        if (!resolvedError && resolvedData && resolvedData.length === 0) {
          if (!selectedLeagueId) {
            setHasNoLeagues(true);
          } else {
            const { data: otherMemberships, error: membershipError } =
              await supabase
                .from("league_members")
                .select("league_id")
                .eq("user_id", user.id)
                .eq("is_active", true)
                .limit(1);

            setHasNoLeagues(
              !membershipError && (otherMemberships?.length ?? 0) === 0,
            );
          }
        } else {
          setHasNoLeagues(false);
        }

        return;
      }

      setHasNoLeagues(false);

      const nextLeagueName = (resolvedData[0] as { leagues?: { name?: string | null } })
        .leagues?.name;
      setLeagueName(nextLeagueName || "League Name");

      const resolvedLeagueId = (resolvedData[0] as { league_id?: string | null })
        .league_id;

      if (!resolvedLeagueId) {
        setGoods(null);
        return;
      }

      try {
        const next = await loadDashboardData(
          resolvedLeagueId,
          user.id,
          // The season the member last chose for this league, or null for the newest.
          getSelectedSeason(resolvedLeagueId),
        );
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

  /*
   * Clearing notifications is a delete, so it is confirmed first. The dialog copy
   * names the scope, because "clear all" on a panel that shows five of the
   * member's forty would otherwise read as removing only what is on screen. The
   * scope is the season on screen, not the league: the dashboard can be pointed
   * at a past season, and clearing there must not delete the current one's rows.
   */
  const handleClearNotifications = useCallback(async () => {
    const leagueId = goods?.leagueId;
    const seasonId = goods?.season?.id;

    if (!leagueId || !seasonId) {
      return;
    }

    const confirmed = await confirm({
      title: "Clear all notifications?",
      detail:
        "This removes every notification for this season, including any you have not read. It cannot be undone.",
      confirmLabel: "Clear all",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    setIsClearingNotifications(true);
    setNotificationError(null);

    try {
      const removed = await clearAllNotifications(leagueId, seasonId);

      /*
       * The match-time and trade alerts behind the two nav badges are notifications
       * too, so the ones raised this season are gone along with the list and the
       * badges have to be told to re-read. The panel only ever holds this season's
       * rows, and every one of them is gone, so the list is emptied rather than
       * refetched.
       */
      setGoods((current) =>
        current
          ? {
              ...current,
              notifications: [],
            }
          : current,
      );

      setNotice(
        removed === 1
          ? "1 notification cleared."
          : `${removed} notifications cleared.`,
      );

      // The global top navigation owns the Schedule/Trades badges now; tell it
      // the rows behind them are gone so they clear without a reload.
      announceNavAlertsChanged();
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
  }, [goods?.leagueId, goods?.season?.id, confirm]);

  /**
   * Saves a winner pick from a Schedule-panel card.
   *
   * The write is followed by an in-place update rather than a full reload: a
   * prediction does not move the standings, so only the two places this match can
   * appear need the new pick.
   *
   * @param matchId - The matchup being predicted.
   * @param teamId - The team the member picked to win.
   */
  const handlePredict = useCallback(async (matchId: string, teamId: string) => {
    setPredictingMatchId(matchId);
    setPredictionError(null);

    try {
      await setMatchPrediction(matchId, teamId);

      setGoods((current) => {
        if (!current) {
          return current;
        }

        const withPick = (match: DashboardMatch): DashboardMatch => {
          if (match.id !== matchId) {
            return match;
          }

          /*
           * Move the member's own count from the side they had picked, if any,
           * to the new side so the buttons agree with the saved pick without a
           * reload.
           */
          const previous = match.my_prediction_team_id;

          if (previous === teamId) {
            return match;
          }

          const counts = { ...match.prediction_counts };

          if (previous) {
            counts[previous] = Math.max(0, (counts[previous] ?? 0) - 1);
          }

          counts[teamId] = (counts[teamId] ?? 0) + 1;

          return {
            ...match,
            my_prediction_team_id: teamId,
            prediction_counts: counts,
          };
        };

        return {
          ...current,
          currentWeekMatches: current.currentWeekMatches.map(withPick),
          nextMatch: current.nextMatch ? withPick(current.nextMatch) : null,
        };
      });
    } catch (caughtError) {
      setPredictionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Your prediction could not be saved.",
      );
    } finally {
      setPredictingMatchId(null);
    }
  }, []);

  /*
   * Live updates. A match changing status, time, or result changes the schedule,
   * the week, and the standings, so it reloads the page's data. The nav badges
   * belong to the global top navigation and refresh there.
   */
  useRealtimeInvalidation({
    leagueId: goods?.leagueId ?? null,
    watchers: [{ table: "matches", onChange: () => void reloadLeague() }],
  });

  if (isLoading || !sessionUser || !leagueName) {
    return (
      <main className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100 sm:px-6 sm:py-10">
        <div className="mx-auto max-w-[96rem] rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          <LoadingGif label="Loading dashboard" />
        </div>
      </main>
    );
  }

  if (hasNoLeagues) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center shadow-xl shadow-slate-950/40">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-400">
            Welcome, {sessionUser.displayName}
          </p>
          <h1 className="mt-3 text-3xl font-bold text-white">
            You are not in a league yet.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Create a new league to run your own draft and season, or join an
            existing league using an invite link from its owner.
          </p>

          <button
            type="button"
            onClick={() => router.push("/create-league")}
            className="mt-6 rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
          >
            Create New League
          </button>

          <p className="mt-5 text-xs text-slate-500">
            Have an invite link? Open it on this device to join that league.
          </p>
        </div>
      </main>
    );
  }

  if (error || !goods) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <div className="max-w-md rounded-2xl border border-red-900 bg-red-950/40 px-6 py-4 text-center text-sm text-red-200 shadow-lg shadow-slate-950/40">
          {error ?? "This league is not available."}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-[96rem]">
        <CrownProvider crownedUserIds={goods.crownedMemberIds}>
          <DashboardShell
          displayName={sessionUser.displayName}
          userId={sessionUser.id}
          avatarUrl={sessionUser.avatarUrl}
          avatarInitials={sessionUser.avatarInitials}
          nameColor={sessionUser.nameColor}
          leagueName={leagueName}
          leagueId={goods.leagueId}
          goods={goods}
          onClearNotifications={() => void handleClearNotifications()}
          isClearingNotifications={isClearingNotifications}
          notificationError={notificationError}
          notificationNotice={notice}
          onPredict={(matchId, teamId) => void handlePredict(matchId, teamId)}
          predictingMatchId={predictingMatchId}
          predictionError={predictionError}
        />
        </CrownProvider>
      </div>
      {confirmDialog}
    </main>
  );
}
