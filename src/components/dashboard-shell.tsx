/*
 * Main dashboard shell displayed after a user selects a league.
 *
 * Renders the league header, stat cards, standings table, schedule, upcoming
 * matches, notifications, and the user's current team roster. Every value comes
 * from the dashboard payload loaded by the page; each panel degrades to an
 * explicit empty state when the league has no data for it yet.
 */
"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/supabase/auth";
import { getSpriteUrl } from "@/lib/pokeapi";
import {
  formatMatchTime,
  formatNotificationAge,
  matchStatusLabel,
  type DashboardGoods,
} from "@/lib/supabase/dashboard";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { useUserTimeZone } from "@/lib/user-timezone";

/** Navigation tab labels displayed in the league header. */
const tabs = ["Overview", "Draft Board", "Teams", "Pokémon", "Schedule"];

/** Maps the navigable header tabs to their route slugs (leagueId is appended). */
const TAB_ROUTES: Record<string, string> = {
  "Draft Board": "draftboard",
  Teams: "teams",
  Pokémon: "pokemon",
  Schedule: "schedule",
};

/** Builds the route for a tab slug using the selected league id. */
function routeFor(slug: string, leagueId?: string | null): string {
  return leagueId ? `/${slug}?leagueId=${leagueId}` : `/${slug}`;
}

/** Rank dot colors cycled down the standings table. */
const RANK_ACCENTS = [
  "bg-amber-500",
  "bg-cyan-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-rose-500",
];

/** Type badge colors keyed by normalized type name (matches the teams page). */
const TYPE_BADGE_STYLES: Record<string, string> = {
  normal: "bg-slate-600 text-slate-100",
  fire: "bg-red-600 text-slate-50",
  water: "bg-blue-600 text-slate-50",
  electric: "bg-yellow-500 text-slate-900",
  grass: "bg-green-600 text-slate-50",
  ice: "bg-cyan-500 text-slate-900",
  fighting: "bg-orange-700 text-slate-50",
  poison: "bg-purple-600 text-slate-50",
  ground: "bg-amber-700 text-slate-50",
  flying: "bg-sky-500 text-slate-50",
  psychic: "bg-pink-600 text-slate-50",
  bug: "bg-lime-600 text-slate-50",
  rock: "bg-stone-600 text-slate-50",
  ghost: "bg-indigo-700 text-slate-50",
  dragon: "bg-violet-700 text-slate-50",
  dark: "bg-neutral-800 text-slate-100",
  steel: "bg-slate-500 text-slate-50",
  fairy: "bg-pink-400 text-slate-900",
};

/** Props for the {@link DashboardShell} component. */
export interface DashboardShellProps {
  /** The authenticated user's display name, shown in the header and standings. */
  displayName: string;
  /** The authenticated user's email address. */
  email: string;
  /** Optional URL for the user's avatar image. Falls back to an initial-based placeholder. */
  avatarUrl?: string | null;
  /** Name of the currently selected league. Defaults to "League Name". */
  leagueName?: string;
  /** ID of the currently selected league, used to build navigation links. */
  leagueId?: string | null;
  /** Season data backing every panel; omitted panels render their empty state. */
  goods: DashboardGoods;
  /**
   * Called when the Schedule tab is opened, so the page can mark this week's
   * match-time alerts as read and drop the badge.
   */
  onScheduleVisited?: () => void;
  /**
   * Called when the member asks to clear every notification for this league. The
   * page owns the confirmation and the delete, so this panel stays presentational
   * and the irreversible action is confirmed in one place.
   */
  onClearNotifications?: () => void;
  /** Disables the clear control while a clear is in flight. */
  isClearingNotifications?: boolean;
  /** Panel-level failure text, kept separate from the page-level error. */
  notificationError?: string | null;
  /** Panel-level confirmation text, e.g. how many notifications were removed. */
  notificationNotice?: string | null;
}

/**
 * Full dashboard layout for a selected league.
 *
 * Displays league metadata, summary stat cards, standings, schedule,
 * notifications, and the current team roster. Provides navigation to the
 * draft board, teams, Pokémon (free agent) and settings pages.
 *
 * @param props - {@link DashboardShellProps}
 * @returns A grid-based dashboard layout.
 */
export function DashboardShell({
  displayName,
  email,
  avatarUrl,
  leagueName = "League Name",
  leagueId,
  goods,
  onScheduleVisited,
  onClearNotifications,
  isClearingNotifications = false,
  notificationError = null,
  notificationNotice = null,
}: DashboardShellProps) {
  const router = useRouter();
  const scheduleRoute = routeFor("schedule", leagueId);
  /** Match and notification times render in the zone the member picked in settings. */
  const timeZone = useUserTimeZone();
  /** Unread match-time alerts raised by the member's opponent this week. */
  const scheduleAlertCount = goods.matchTimeAlertCount ?? 0;

  /*
   * Labels a team by its owner's live display name. The standings RPC returns
   * `teams.team_name`, which was copied out of the profile when the draft started
   * and is never refreshed, so ranking players by it left them shown under the
   * name they had before they changed it.
   */
  const teamLabel = (teamId: string, fallbackName: string) => {
    const team = goods.teams.find((entry) => entry.id === teamId);
    return team?.owner_name || fallbackName;
  };

  // The stat cards read off the same payload, so their detail lines describe
  // whatever the league has actually configured (an unset schedule reads as
  // "Schedule not set" rather than implying a week count of zero).
  const weekDetail =
    goods.currentWeek != null
      ? `of ${goods.totalWeeks} regular weeks`
      : goods.hasPlayoffs
        ? "Postseason"
        : "Schedule not set";
  const matchFormatLabel =
    goods.matchFormat === "single" ? "Single game" : "Best of 3";
  const statCards = [
    {
      label: "Teams",
      value: String(goods.teamsCount),
      detail: `${goods.rosteredPokemonCount} Pokémon rostered`,
    },
    {
      label: "Free Agents",
      value: String(goods.freeAgentCount),
      detail: "Pokémon available",
    },
    {
      label: "Current Week",
      value: goods.currentWeek != null ? String(goods.currentWeek) : "—",
      detail: weekDetail,
    },
    {
      label: "Open Trades",
      value: String(goods.pendingTradesCount),
      detail: "Awaiting you or approval",
    },
  ];

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-3xl font-bold text-white">{leagueName}</h2>
              <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-sm font-medium text-amber-300">
                {formatSeasonLabel(goods.season)}
              </span>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-amber-500 text-sm font-bold text-slate-950">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={displayName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span>{displayName?.charAt(0)?.toUpperCase() || "T"}</span>
                )}
              </div>

              <div className="flex-1">
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-300">
                  <span>{displayName}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-700 pt-4">
          {tabs.map((tab, index) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                const route = TAB_ROUTES[tab];
                if (!route) {
                  return;
                }

                // Opening the schedule is what clears the match-time alerts, so
                // the badge goes away as a result of going to deal with them.
                if (route === "schedule") {
                  onScheduleVisited?.();
                }

                router.push(routeFor(route, leagueId));
              }}
              className={`relative rounded-full px-3.5 py-2 text-sm font-medium transition ${
                index === 0
                  ? "bg-amber-500 text-slate-950"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {tab}

              {/*
                Unread match-time alerts for this week's matchup. Absolutely
                positioned into the button's top-right corner, and nudged up so
                it straddles the pill rather than sitting inside it.
              */}
              {tab === "Schedule" && scheduleAlertCount > 0 && (
                <span
                  className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-slate-900 bg-rose-500 px-1 text-[11px] font-bold leading-none text-white"
                  aria-label={`${scheduleAlertCount} unread match time update${
                    scheduleAlertCount === 1 ? "" : "s"
                  }`}
                >
                  {scheduleAlertCount > 99 ? "99+" : scheduleAlertCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statCards.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg shadow-slate-950/30"
          >
            <p className="text-sm text-slate-400">{item.label}</p>
            <p className="mt-3 text-3xl font-bold text-white">{item.value}</p>
            <p className="mt-1 text-sm text-slate-400">{item.detail}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.5fr_0.9fr]">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                Standings
              </p>
              <h2 className="mt-2 text-xl font-bold text-white">
                Season snapshot
              </h2>
            </div>
            <button
              type="button"
              onClick={() => router.push(scheduleRoute)}
              className="rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
            >
              View full table
            </button>
          </div>

          {goods.standings.length === 0 ? (
            <p className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
              No teams have been added to this season yet.
            </p>
          ) : (
            <div className="mt-5 overflow-hidden rounded-xl border border-slate-800">
              <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
                <thead className="bg-slate-950 text-slate-300">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Rank</th>
                    <th className="px-4 py-3 font-semibold">Trainer</th>
                    <th className="px-4 py-3 font-semibold">W</th>
                    <th className="px-4 py-3 font-semibold">L</th>
                    <th className="px-4 py-3 font-semibold">KO Diff</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900">
                  {goods.standings.map((row, index) => (
                    <tr key={row.team_id} className="hover:bg-slate-800/80">
                      <td className="px-4 py-3 font-medium text-slate-100">
                        {index + 1}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span
                            className={`h-2.5 w-2.5 rounded-full ${RANK_ACCENTS[index % RANK_ACCENTS.length]}`}
                          />
                          <span className="font-medium text-slate-100">
                            {teamLabel(row.team_id, row.team_name)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{row.wins}</td>
                      <td className="px-4 py-3 text-slate-300">{row.losses}</td>
                      <td className="px-4 py-3 font-medium text-slate-100">
                        {row.ko_diff > 0 ? `+${row.ko_diff}` : row.ko_diff}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Next match
            </p>
            {goods.nextMatch ? (
              <>
                <h3 className="mt-3 text-xl font-bold text-white">
                  {goods.nextMatch.player_1_name} vs{" "}
                  {goods.nextMatch.player_2_name}
                </h3>
                <p className="mt-2 text-sm text-slate-300">
                  {goods.nextMatch.is_playoff
                    ? "Postseason"
                    : `Week ${goods.nextMatch.week_number}`}{" "}
                  • {formatMatchTime(goods.nextMatch.scheduled_at, timeZone)} •{" "}
                  {matchFormatLabel}
                </p>
                <button
                  type="button"
                  onClick={() => router.push(scheduleRoute)}
                  className="mt-4 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
                >
                  Open matchup
                </button>
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-400">
                {goods.myTeam
                  ? "You have no scheduled match left this season."
                  : "You do not have a team in this season."}
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                Notifications
              </p>
              {/*
               * Hidden rather than disabled on an empty list: a control that
               * cannot do anything should not sit next to the heading competing
               * with it, and "you have no notifications" already says the state.
               */}
              {goods.notifications.length > 0 && onClearNotifications && (
                <button
                  type="button"
                  disabled={isClearingNotifications}
                  onClick={onClearNotifications}
                  className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:border-rose-800 hover:text-rose-300 disabled:opacity-50"
                >
                  {isClearingNotifications ? "Clearing..." : "Clear all"}
                </button>
              )}
            </div>
            {notificationError && (
              <p className="mt-3 text-xs text-rose-300">{notificationError}</p>
            )}
            {!notificationError && notificationNotice && (
              <p className="mt-3 text-xs text-emerald-300">
                {notificationNotice}
              </p>
            )}
            {goods.notifications.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">
                You have no notifications yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {goods.notifications.map((item) => (
                  <li
                    key={item.id}
                    className="flex gap-3 rounded-xl bg-slate-800/70 p-3 text-sm text-slate-200"
                  >
                    <span
                      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                        item.is_read ? "bg-slate-600" : "bg-amber-400"
                      }`}
                    />
                    <div>
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
        </aside>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                Schedule
              </p>
              <h2 className="mt-2 text-xl font-bold text-white">
                Upcoming matches
              </h2>
            </div>
            <button
              type="button"
              onClick={() => router.push(scheduleRoute)}
              className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              Manage calendar
            </button>
          </div>

          {goods.upcomingMatches.length === 0 ? (
            <p className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
              Nothing on the schedule yet. Generate one from the Schedule page.
            </p>
          ) : (
            <div className="mt-5 space-y-3">
              {goods.upcomingMatches.map((match) => (
                <div
                  key={match.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-slate-700 bg-slate-800/70 p-4"
                >
                  <div>
                    <p className="font-semibold text-slate-100">
                      {match.player_1_name} vs {match.player_2_name}
                    </p>
                    <p className="mt-1 text-sm text-slate-400">
                      {match.is_playoff
                        ? "Postseason"
                        : `Week ${match.week_number}`}{" "}
                      • {formatMatchTime(match.scheduled_at, timeZone)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      match.status === "in_progress"
                        ? "bg-amber-500/15 text-amber-300"
                        : "bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    {matchStatusLabel(match.status)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            My team
          </p>
          <h2 className="mt-2 text-xl font-bold text-white">
            {goods.myTeam
              ? (goods.myTeam.owner_name ?? goods.myTeam.team_name)
              : "No team yet"}
          </h2>

          {!goods.myTeam ? (
            <p className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
              You do not have a team in this season.
            </p>
          ) : goods.myRoster.length === 0 ? (
            <p className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
              Your roster is empty. Draft or pick up Pokémon to fill it.
            </p>
          ) : (
            <div className="mt-5 space-y-3">
              {goods.myRoster.map((pokemon) => (
                <div
                  key={pokemon.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {pokemon.spriteId > 0 ? (
                      <img
                        src={getSpriteUrl(pokemon.spriteId)}
                        alt={pokemon.name}
                        width={32}
                        height={32}
                        loading="lazy"
                        className="h-8 w-8 shrink-0 object-contain"
                      />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700 text-xs text-slate-400">
                        ?
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="font-medium text-slate-100">
                          {pokemon.name}
                        </p>
                        {pokemon.types.map((type) => (
                          <span
                            key={type}
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize ${
                              TYPE_BADGE_STYLES[type.toLowerCase()] ??
                              "bg-slate-700 text-slate-200"
                            }`}
                          >
                            {type}
                          </span>
                        ))}
                      </div>
                      {pokemon.bst != null && (
                        <p className="text-xs text-slate-500">
                          {pokemon.bst} BST
                        </p>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-1 text-xs font-semibold text-amber-300">
                    {pokemon.tier_value === 0
                      ? "Unranked"
                      : `Tier ${pokemon.tier_value}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
