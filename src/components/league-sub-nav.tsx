/*
 * Global league sub-navigation.
 *
 * The row of league pages below the top navigation: Dashboard, Draft Board,
 * Teams, Pokemon, Schedule, Trades, Rules, and Hall of Fame, plus the season
 * selector, settings menu, and alert badges. It reads the selected league,
 * seasons, ownership, and alerts from the shared league shell provider, so it
 * does not query the database itself.
 *
 * The bar disappears when the league selector is on "Create New League" or the
 * member has no active league, so it never points at a league that is not on
 * screen.
 */
"use client";

import { usePathname, useRouter } from "next/navigation";

import { LeagueSettingsMenu } from "@/components/league-settings-menu";
import { TabNotification } from "@/components/nav-alert-badge";
import { LEAGUE_TABS, routeFor } from "@/lib/league-routes";
import { useLeagueShell } from "@/components/league-shell-context";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { confirmDiscardUnsavedChanges } from "@/lib/unsaved-changes";

/**
 * Renders the league page buttons, season dropdown, and settings menu for the
 * league selected in the top navigation.
 *
 * @returns The sub-navigation bar, or null when no league is selected.
 */
export function LeagueSubNav() {
  const router = useRouter();
  const pathname = usePathname();
  const {
    isReady,
    selectedLeague,
    seasons,
    selectedSeasonId,
    isOwner,
    alerts,
    markAlertsRead,
    selectSeason,
  } = useLeagueShell();

  const activeSlug = pathname?.split("/")[1] ?? "";

  /**
   * Navigates to a tab, asking a dirty page to confirm first, and clears the
   * matching alert badge when the member is on their way to deal with it.
   *
   * @param slug - The tab's route slug.
   */
  async function handleTabClick(slug: string) {
    if (!selectedLeague || selectedLeague === "create-league") {
      return;
    }

    const targetPath = `/${slug}`;

    if (targetPath !== pathname) {
      const allowed = await confirmDiscardUnsavedChanges();

      if (!allowed) {
        return;
      }
    }

    if (slug === "schedule") {
      markAlertsRead("match");
    }

    if (slug === "trades") {
      markAlertsRead("trade");
    }

    router.push(routeFor(slug, selectedLeague));
  }

  if (
    !isReady ||
    !selectedLeague ||
    selectedLeague === "create-league"
  ) {
    return null;
  }

  return (
    <div className="sticky top-[65px] z-40 border-b border-slate-800 bg-slate-950/85 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
        {LEAGUE_TABS.map((tab) => {
          /*
           * The draft arena is reached from the Draft Board and has no tab of its
           * own, so it keeps that tab lit rather than leaving the whole row
           * unselected on a core page.
           */
          const active =
            activeSlug === tab.slug ||
            (tab.slug === "draftboard" && activeSlug === "draft");
          const badge =
            tab.slug === "schedule"
              ? { badge: alerts.match.count, subject: "match time" }
              : tab.slug === "trades"
                ? { badge: alerts.trade.count, subject: "trade" }
                : null;

          return (
            <button
              key={tab.slug}
              type="button"
              onClick={() => void handleTabClick(tab.slug)}
              aria-current={active ? "page" : undefined}
              className={`relative rounded-full px-3.5 py-2 text-sm font-medium transition ${
                active
                  ? "bg-amber-500 text-slate-950"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {tab.label}
              {badge && (
                <TabNotification
                  badge={badge.badge}
                  total={0}
                  subject={badge.subject}
                />
              )}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          {seasons.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-slate-400">
              <span className="hidden sm:inline">Season</span>
              <select
                value={selectedSeasonId ?? ""}
                onChange={(event) => void selectSeason(event.target.value)}
                className="rounded-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
              >
                {seasons.map((season) => (
                  <option key={season.id} value={season.id}>
                    {formatSeasonLabel(season)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <LeagueSettingsMenu
            leagueId={selectedLeague}
            seasonId={selectedSeasonId}
            isOwner={isOwner}
          />
        </div>
      </div>
    </div>
  );
}
