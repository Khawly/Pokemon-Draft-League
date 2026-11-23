/*
 * Dashboard page for the Pokemon Draft League.
 *
 * Renders the dashboard shell with the member's identity plus the league's live
 * season data (standings, schedule, pool, roster, trades, notifications).
 *
 * The league and the profile both come from the shared shell provider, which has
 * already resolved them for the navigation bar; this page only loads the
 * season-specific payload.
 */

"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { CrownProvider } from "@/components/crown-provider";
import { useConfirm } from "@/components/confirm-dialog";
import { useLeagueShell, useShellLeague } from "@/components/league-shell-context";
import { useLeaguePageData } from "@/lib/use-league-page-data";
import { clearAllNotifications, loadDashboardData, type DashboardMatch } from "@/lib/supabase/dashboard";
import { setMatchPrediction } from "@/lib/supabase/schedule";
import { useRealtimeInvalidation } from "@/lib/use-realtime-invalidation";
import { getSelectedSeason } from "@/lib/season-selection";
import { announceNavAlertsChanged } from "@/lib/nav-alerts";
import { PageShell, PageShellLoading } from "@/components/page-shell";

/**
 * The dashboard route.
 *
 * The league comes from the shell provider, so the page reads no search params
 * and needs no Suspense boundary of its own.
 *
 * @returns The dashboard page.
 */
export default function DashboardPage() {
  return <DashboardPageContent />;
}

/**
 * Loads the league's season data and renders the DashboardShell. A signed-out
 * visitor is sent back to the landing page by the shell's state.
 */
function DashboardPageContent() {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const shell = useLeagueShell();
  const shellLeague = useShellLeague();

  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isClearingNotifications, setIsClearingNotifications] = useState(false);
  /** The matchup whose prediction is being saved, if any. */
  const [predictingMatchId, setPredictingMatchId] = useState<string | null>(
    null,
  );
  /** Panel-level failure text for a prediction that could not be saved. */
  const [predictionError, setPredictionError] = useState<string | null>(null);

  /** True once the shell resolves and the member belongs to no active league. */
  const hasNoLeagues = shell.isReady && shell.leagueOptions.length === 0;

  /** The greeting and header identity, taken from the shell's cached profile. */
  const sessionUser =
    shell.isReady && shell.userId
      ? {
          id: shell.userId,
          displayName: shell.profile.displayName ?? "Trainer",
          avatarUrl: shell.profile.avatarUrl,
          avatarInitials: shell.profile.avatarInitials,
          nameColor: shell.profile.nameColor,
        }
      : null;

  /** The league's display name, from the shell's membership list. */
  const leagueName =
    shell.leagueOptions.find((entry) => entry.id === shellLeague.leagueId)
      ?.label ?? "League Name";

  const {
    data: goods,
    isLoading,
    error,
    setData: setGoods,
    reload: reloadLeague,
  } = useLeaguePageData({
    ...shellLeague,
    load: (leagueId) => {
      /*
       * The shell sends a signed-out visitor away before a league is loaded, so
       * the member id is present here. The guard is for the type, not a case the
       * page can actually reach.
       */
      if (!shellLeague.userId) {
        return Promise.reject(new Error("You are not signed in."));
      }

      return loadDashboardData(
        leagueId,
        shellLeague.userId,
        getSelectedSeason(leagueId),
      );
    },
    emptyLeagueMessage: "You are not a member of any active league.",
    fallbackErrorMessage: "The league could not be loaded.",
  });


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
  }, [goods?.leagueId, goods?.season?.id, confirm, setGoods]);

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
  }, [setGoods]);

  /*
   * Live updates. A match changing status, time, or result changes the schedule,
   * the week, and the standings, so it reloads the page's data. A notification
   * arriving (a league announcement, a trade or match-time alert) reloads so the
   * panel shows it without a manual refresh. The nav badges belong to the global
   * top navigation and refresh there.
   */
  useRealtimeInvalidation({
    leagueId: goods?.leagueId ?? null,
    watchers: [
      { table: "matches", onChange: () => void reloadLeague() },
      { table: "notifications", onChange: () => void reloadLeague() },
    ],
  });

  if (!shell.isReady || shellLeague.signedOut || !sessionUser) {
    return <PageShellLoading label="Loading dashboard" />;
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

  if (isLoading) {
    return <PageShellLoading label="Loading dashboard" />;
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
    <PageShell columnClassName="mx-auto max-w-[96rem]">
      <CrownProvider
          crownedUserIds={goods.crownedMemberIds}
          crownedNames={goods.crownedMemberIds
            .map(
              (id) =>
                goods.teams.find((team) => team.owner_user_id === id)
                  ?.owner_name ?? "",
            )
            .filter((name) => name.length > 0)}
        >
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
      {confirmDialog}
    </PageShell>
  );
}
