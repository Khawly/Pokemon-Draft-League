/*
 * Sticky top navigation bar for the Pokemon Draft League app.
 *
 * One bar now carries everything that used to be split between the top bar and
 * the league sub-navigation: the home link, the league selector, the season
 * selector, the league page tabs, the alert badges, and the settings gear.
 * Keeping them together means the league and season a page is showing are
 * visible beside the tabs that switch pages, and there is no second sticky row
 * eating vertical space.
 *
 * The profile, memberships, selected league, seasons, ownership, and alert
 * counts all come from the shared league shell provider, so the bar issues no
 * queries of its own. The league and season panels hide themselves while the
 * selector is on "Create New League" or the member has no active league, so they
 * never point at a league that is not on screen.
 */
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useRef } from "react";

import { LeagueSettingsMenu } from "@/components/league-settings-menu";
import { TabNotification } from "@/components/nav-alert-badge";
import { useLeagueShell } from "@/components/league-shell-context";
import { LEAGUE_TABS, routeFor } from "@/lib/league-routes";
import { setSelectedLeague } from "@/lib/league-selection";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { confirmDiscardUnsavedChanges } from "@/lib/unsaved-changes";

/**
 * Keeps `--app-nav-height` on the document root in sync with the sticky nav.
 *
 * Pages that pin a header below the nav read the variable, so the offset tracks
 * the nav's wrapped height at every viewport instead of assuming one fixed row.
 *
 * @returns A callback ref for the nav's header element.
 */
function useAppNavHeightRef() {
  const observerRef = useRef<ResizeObserver | null>(null);

  return useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) {
      return;
    }

    const publish = () => {
      document.documentElement.style.setProperty(
        "--app-nav-height",
        `${node.getBoundingClientRect().height}px`,
      );
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    observerRef.current = observer;
  }, []);
}

/**
 * Placeholder header shown while the shell identity and league list load, and
 * while Next.js resolves the client search params that the shell provider reads.
 *
 * @returns The skeleton top bar.
 */
export function TopNavSkeleton() {
  const navRef = useAppNavHeightRef();

  return (
    <header
      ref={navRef}
      data-app-nav
      className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-[96rem] items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="h-10 w-20 rounded-xl border border-slate-700 bg-slate-900" />
        <div className="flex-1 px-2">
          <div className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900" />
        </div>
        <div className="h-10 w-10 rounded-xl border border-slate-700 bg-slate-900" />
      </div>
    </header>
  );
}

/**
 * Sticky top navigation bar.
 *
 * @returns The header, a loading skeleton, or nothing outside the app shell.
 */
export function TopNav() {
  const router = useRouter();
  const pathname = usePathname();
  const {
    isReady,
    leagueOptions,
    selectedLeague,
    seasons,
    selectedSeasonId,
    isOwner,
    alerts,
    markAlertsRead,
    selectSeason,
  } = useLeagueShell();

  const navRef = useAppNavHeightRef();

  if (pathname === "/") {
    return null;
  }

  if (!isReady) {
    return <TopNavSkeleton />;
  }

  const activeSlug = pathname?.split("/")[1] ?? "";
  const hasLeague =
    Boolean(selectedLeague) && selectedLeague !== "create-league";
  /**
   * The page tab to reflect in the mobile dropdown. The draft arena sits under
   * the Draft Board tab, and settings pages are not tabs, so they show the
   * neutral placeholder instead of selecting an unrelated tab.
   */
  const activePageTabSlug =
    activeSlug === "draft"
      ? "draftboard"
      : LEAGUE_TABS.some((tab) => tab.slug === activeSlug)
        ? activeSlug
        : "";

  /*
   * The single exit point for every navigation this bar performs.
   *
   * `beforeunload` cannot cover client-side transitions, so a dirty settings
   * form would otherwise disappear without a warning. Navigating to the page
   * already open is left unguarded on purpose.
   */
  async function navigate(href: string) {
    const targetPath = href.split("?")[0];

    if (targetPath !== pathname) {
      const allowed = await confirmDiscardUnsavedChanges();

      if (!allowed) {
        return;
      }
    }

    router.push(href);
  }

  async function handleLeagueChange(
    event: React.ChangeEvent<HTMLSelectElement>,
  ) {
    const nextValue = event.target.value;

    if (nextValue === "create-league") {
      await navigate("/create-league");
      return;
    }

    const target = `/dashboard?leagueId=${nextValue}`;
    const targetPath = target.split("?")[0];

    if (targetPath !== pathname) {
      const allowed = await confirmDiscardUnsavedChanges();

      if (!allowed) {
        return;
      }
    }

    setSelectedLeague(nextValue);

    await navigate(target);
  }

  /**
   * Navigates to a league tab, asking a dirty page to confirm first, and clears
   * the matching alert badge when the member is on their way to deal with it.
   *
   * @param slug - The tab's route slug.
   */
  async function handleTabClick(slug: string) {
    if (!hasLeague) {
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

  return (
    <header
      ref={navRef}
      data-app-nav
      className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-[96rem] flex-wrap items-center gap-2 px-3 py-2 sm:px-6 sm:py-2.5">
        <button
          type="button"
          onClick={() => void navigate("/")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-100 transition hover:border-slate-500 hover:bg-slate-800"
          aria-label="Go home"
          title="Home"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-5 w-5 fill-current"
          >
            <path d="M12 3.3 3 10.5v9.2a1.3 1.3 0 0 0 1.3 1.3h5.6v-6.3h4.2v6.3h5.6A1.3 1.3 0 0 0 21 19.7v-9.2L12 3.3Zm0-2.2 10.6 7.8c.5.4.9 1.1.9 1.7v10.2A3.3 3.3 0 0 1 20.2 21H15v-6.3a1.3 1.3 0 0 0-1.3-1.3h-3.4a1.3 1.3 0 0 0-1.3 1.3V21H3.8A3.3 3.3 0 0 1 .5 17.7V10.5c0-.6.3-1.3.8-1.7L12 1.1Z" />
          </svg>
        </button>

        {/*
          The league selector is no longer the whole middle of the bar: the
          season selector sits immediately to its right, then the tabs, so the
          league and season a page belongs to read as one group. A member with no
          leagues gets the create action by itself, since there is nothing to
          select from yet.
        */}
        {leagueOptions.length === 0 ? (
          <button
            type="button"
            onClick={() => void navigate("/create-league")}
            className="min-w-0 flex-1 shrink-0 rounded-xl border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20 sm:flex-none"
          >
            + Create New League
          </button>
        ) : (
          <label className="min-w-0 flex-1 sm:flex-none">
            <span className="sr-only">League menu</span>
            <select
              value={selectedLeague}
              onChange={handleLeagueChange}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-100 outline-none transition focus:border-amber-400 sm:w-56"
              aria-label="League dropdown"
            >
              {leagueOptions.map((league) => (
                <option key={league.id} value={league.id}>
                  {league.label}
                </option>
              ))}

              <option value="create-league">+ Create New League</option>
            </select>
          </label>
        )}

        {hasLeague && seasons.length > 1 && (
          <label className="shrink-0">
            <select
              value={selectedSeasonId ?? ""}
              onChange={(event) => void selectSeason(event.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
              aria-label="Season"
            >
              {seasons.map((season) => (
                <option key={season.id} value={season.id}>
                  {formatSeasonLabel(season)}
                </option>
              ))}
            </select>
          </label>
        )}

        {hasLeague && (
          <label className="min-w-0 flex-1 sm:hidden">
            <span className="sr-only">League pages</span>
            <select
              value={activePageTabSlug}
              onChange={(event) => void handleTabClick(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-100 outline-none transition focus:border-amber-400"
              aria-label="League page"
            >
              {activePageTabSlug === "" && (
                <option value="" disabled>
                  Pages
                </option>
              )}
              {LEAGUE_TABS.map((tab) => (
                <option key={tab.slug} value={tab.slug}>
                  {tab.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {hasLeague && (
          <nav
            aria-label="League pages"
            className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1 sm:flex sm:w-auto sm:flex-none sm:flex-wrap sm:overflow-visible sm:pb-0"
          >
            {LEAGUE_TABS.map((tab) => {
              /*
               * The draft arena is reached from the Draft Board and has no tab
               * of its own, so it keeps that tab lit rather than leaving the
               * whole row unselected on a core page.
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
                  className={`relative shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition ${
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
          </nav>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LeagueSettingsMenu
            leagueId={
              selectedLeague === "create-league" ? null : selectedLeague
            }
            seasonId={selectedSeasonId}
            isOwner={isOwner}
          />
        </div>
      </div>
    </header>
  );
}
