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
import { TabNotification } from "@/components/nav-alert-badge";
import {
  formatMatchTime,
  formatNotificationAge,
  matchStatusLabel,
  type DashboardGoods,
  type DashboardRules,
} from "@/lib/supabase/dashboard";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { useUserTimeZone } from "@/lib/user-timezone";
import { formatDateTimeInZone } from "@/lib/datetime";

/** Navigation tab labels displayed in the league header. */
const tabs = ["Overview", "Draft Board", "Teams", "Pokémon", "Schedule", "Trades", "Rules"];

/** Maps the navigable header tabs to their route slugs (leagueId is appended). */
const TAB_ROUTES: Record<string, string> = {
  "Draft Board": "draftboard",
  Teams: "teams",
  Pokémon: "pokemon",
  Schedule: "schedule",
  Trades: "trades",
  Rules: "rules",
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
   * Called when the Trades tab is opened, so the page can mark the member's
   * unread trade alerts as read and drop the badge.
   */
  onTradesVisited?: () => void;
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

/** Props for the {@link RulesPanel} component. */
interface RulesPanelProps {
  /** The league's rules, or null when the owner has not set any. */
  rules: DashboardRules | null;
  /** The zone the reader keeps their clock in. */
  timeZone: string;
  /** Whether the reader owns the league, and so can edit the rules. */
  isOwner: boolean;
  /** The selected league id, used to link to the full rules page. */
  leagueId?: string | null;
}

/**
 * Shows the league's rules as a read-only summary.
 *
 * Deliberately not the editor: the full page owns authoring, and duplicating a
 * text area here would give the owner two places to edit the same document with
 * no way to tell which one is stale. The panel shows the rules as written,
 * preserving line breaks, links out to the page that can edit them, and stays
 * visible before the draft when it is the only thing on the dashboard.
 *
 * @param props - {@link RulesPanelProps}
 * @returns The rules panel markup.
 */
function RulesPanel({ rules, timeZone, isOwner, leagueId }: RulesPanelProps) {
  const router = useRouter();
  const rulesRoute = routeFor("rules", leagueId);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            Rules
          </p>
          <h2 className="mt-2 text-xl font-bold text-white">League rules</h2>
        </div>
        <button
          type="button"
          onClick={() => router.push(rulesRoute)}
          className="shrink-0 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
        >
          {isOwner ? "Edit rules" : "View all"}
        </button>
      </div>

      {rules?.content ? (
        <>
          {/*
            whitespace-pre-wrap keeps the owner's own line breaks and indentation.
            The rules are authored as plain text, so re-flowing them would quietly
            change what they say.

            Uncapped on purpose: this used to stop at 16rem and scroll internally,
            which meant reading the rules needed a scrollbar inside the panel even
            when the page itself had not been scrolled at all. The document is the
            last thing on the page, so letting it grow costs nothing the reader has
            to hunt for.
          */}
          <div className="mt-4 whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm leading-relaxed text-slate-200">
            {rules.content}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Last updated{" "}
            {formatDateTimeInZone(rules.updatedAt, timeZone)}
          </p>
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
          {isOwner
            ? "You have not set any rules for this season yet."
            : "The league owner has not set any rules for this season yet."}
        </p>
      )}
    </section>
  );
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
  onTradesVisited,
  onClearNotifications,
  isClearingNotifications = false,
  notificationError = null,
  notificationNotice = null,
}: DashboardShellProps) {
  const router = useRouter();
  const scheduleRoute = routeFor("schedule", leagueId);
  const draftRoute = routeFor("draft", leagueId);
  /** Match and notification times render in the zone the member picked in settings. */
  const timeZone = useUserTimeZone();
  /** Unread match-time alerts raised by the member's opponent this week. */
  const scheduleAlertCount = goods.matchTimeAlertCount ?? 0;
  /** Unread trade alerts raised by the other party on a trade still in play. */
  const tradeAlertCount = goods.tradeAlertCount ?? 0;

  /*
   * Whether the season's draft has finished, which is what gates every panel
   * below the header.
   *
   * Everything those panels show is downstream of the draft: rosters only fill
   * as picks are made, standings only move once games are reported, and the
   * schedule is generated after the last pick. Rendering them mid-draft showed a
   * league as an empty standings table next to a "0 Pokémon rostered" count and a
   * next-match panel claiming there was nothing scheduled, which read as a broken
   * league rather than one that had simply not drafted yet.
   *
   * `archived` counts as finished for the same reason the draft page treats it
   * as finished: an archived season's draft is over, not pending.
   */
  const draftFinished =
    goods.season?.status === "draft_complete" || goods.season?.status === "archived";

  /*
   * Which of the header tabs can carry a bubble, and what each would be counting.
   * Declared as data so the render below has no per-tab special cases, matching how
   * the Trades page builds its own strip.
   *
   * The dashboard's tabs show no list length, so `total` is always 0 at the call site
   * and the bubble is the only marker these entries ever carry.
   */
  const tabAlerts: Record<string, { badge: number; subject: string }> = {
    Schedule: { badge: scheduleAlertCount, subject: "match time" },
    Trades: { badge: tradeAlertCount, subject: "trade" },
  };

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

                // Same idea for trades: navigating there is the member acting on
                // the alert, so the badge is dropped as a result.
                if (route === "trades") {
                  onTradesVisited?.();
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
                The app-wide notification convention: the red bubble when something
                is waiting on the member, nothing when it is not. See TabNotification.
              */}
              {/*
                The app-wide notification convention: the red bubble when something
                is waiting on the member, nothing when it is not. See TabNotification.
              */}
              {tabAlerts[tab] && (
                <TabNotification
                  badge={tabAlerts[tab].badge}
                  total={0}
                  subject={tabAlerts[tab].subject}
                />
              )}
            </button>
          ))}
        </div>
      </header>

      {/* Every panel below the header depends on a draft that has happened. */}
      {draftFinished && (
        <>
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
                 * Always rendered, and disabled rather than hidden on an empty
                 * list. Hiding it meant a member whose panel was empty had no
                 * visible way to clear anything and no way to tell the control
                 * existed, which reads as the feature being missing. Disabled
                 * still says there is nothing to do, while the panel keeps
                 * offering the option the moment something arrives.
                 */}
                {onClearNotifications && (
                  <button
                    type="button"
                    disabled={
                      isClearingNotifications || goods.notifications.length === 0
                    }
                    onClick={onClearNotifications}
                    title={
                      goods.notifications.length === 0
                        ? "There are no notifications to clear"
                        : "Clear every notification for this league"
                    }
                    className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:border-rose-800 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-700 disabled:hover:text-slate-300"
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
        </>
      )}

      {/*
        Preseason: the draft has not started, so offer a look at the board and the
        pool rather than an empty dashboard. Preview is read-only by construction:
        the arena renders the pick board and pool before any pick is made, and the
        server refuses picks until the season is draft_active.

        Above the rules panel, not below it: during the preseason this is the one
        call to action the page has, and burying it under the rules document meant
        the draft could be started without ever scrolling to find it.
      */}
      {!draftFinished && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-white">Draft preview</h2>
          <p className="mt-1 text-sm text-slate-400">
            {goods.season?.status === "draft_active"
              ? "The draft is under way. Open the arena to follow the picks live."
              : "The draft has not started. Have a look at the board and the pool before it does."}
          </p>
          <button
            type="button"
            onClick={() => router.push(draftRoute)}
            className="mt-4 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
          >
            {goods.season?.status === "draft_active"
              ? "Open draft board"
              : "Preview Draft"}
          </button>
        </section>
      )}

      {/*
        The rules panel sits outside the draft gate, so it renders in every season
        state. Before the draft there is nothing else on this page to read, and the
        rules are exactly what a member joining a league wants before it starts.
      */}
      <RulesPanel
        rules={goods.rules}
        timeZone={timeZone}
        isOwner={goods.isOwner}
        leagueId={leagueId}
      />
    </div>
  );
}
