/*
 * Main dashboard shell displayed after a user selects a league.
 *
 * Renders the league header, stat cards, standings table, schedule,
 * upcoming matches, notifications, and the user's current team roster.
 */
"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/supabase/auth";

/** Navigation tab labels displayed in the league header. */
const tabs = ["Overview", "Draft Board", "Teams", "Schedule"];

/** Hard-coded standings data — will be replaced by a database query. */
const standings = [
  { name: "Ash", wins: 8, losses: 3, diff: 42, accent: "bg-amber-500" },
  { name: "Misty", wins: 7, losses: 4, diff: 31, accent: "bg-cyan-500" },
  { name: "Brock", wins: 6, losses: 5, diff: 12, accent: "bg-emerald-500" },
  { name: "Serena", wins: 5, losses: 6, diff: -4, accent: "bg-violet-500" },
];

/** Hard-coded upcoming match data — will be replaced by a database query. */
const upcomingMatches = [
  { matchup: "Ash vs Brock", time: "Tonight • 8:00 PM", status: "Scheduled" },
  { matchup: "Misty vs Serena", time: "Thu • 7:30 PM", status: "Pending" },
  { matchup: "Brock vs Serena", time: "Sat • 9:00 PM", status: "Ready" },
];

/** Hard-coded notification strings — will be replaced by a database query. */
const notifications = [
  "Draft pool import is ready for review.",
  "Trade approval quorum is pending.",
  "League settings were updated yesterday.",
];

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
}

/**
 * Full dashboard layout for a selected league.
 *
 * Displays league metadata, summary stat cards, standings, schedule,
 * notifications, and the current team roster. Provides navigation to
 * the draft board and settings pages.
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
}: DashboardShellProps) {
  const router = useRouter();

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-3">
            <h2 className="text-3xl font-bold text-white">{leagueName}</h2>

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
                  <span className="rounded-full bg-amber-500/15 px-2.5 py-1 font-medium text-amber-300">
                    Season 3
                  </span>
                  <span>Owner: {displayName}</span>
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
              onClick={
                tab === "Draft Board"
                  ? () =>
                      router.push(
                        leagueId
                          ? `/draftboard?leagueId=${leagueId}`
                          : "/draftboard",
                      )
                  : undefined
              }
              className={`rounded-full px-3.5 py-2 text-sm font-medium transition ${
                index === 0
                  ? "bg-amber-500 text-slate-950"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Teams", value: "12", detail: "Active rosters" },
          { label: "Draft Pool", value: "151", detail: "Pokemon available" },
          { label: "Current Week", value: "7", detail: "Regular season" },
          { label: "Pending Trades", value: "3", detail: "Needs review" },
        ].map((item) => (
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
              className="rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
            >
              View full table
            </button>
          </div>

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
                {standings.map((row, index) => (
                  <tr key={row.name} className="hover:bg-slate-800/80">
                    <td className="px-4 py-3 font-medium text-slate-100">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${row.accent}`}
                        />
                        <span className="font-medium text-slate-100">
                          {row.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{row.wins}</td>
                    <td className="px-4 py-3 text-slate-300">{row.losses}</td>
                    <td className="px-4 py-3 font-medium text-slate-100">
                      {row.diff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Next match
            </p>
            <h3 className="mt-3 text-xl font-bold text-white">Ash vs Brock</h3>
            <p className="mt-2 text-sm text-slate-300">
              Tonight • 8:00 PM • Best of 3
            </p>
            <button
              type="button"
              className="mt-4 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
            >
              Open matchup
            </button>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Notifications
            </p>
            <ul className="mt-4 space-y-3">
              {notifications.map((item) => (
                <li
                  key={item}
                  className="flex gap-3 rounded-xl bg-slate-800/70 p-3 text-sm text-slate-200"
                >
                  <span className="mt-1 h-2 w-2 rounded-full bg-amber-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
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
              className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              Manage calendar
            </button>
          </div>

          <div className="mt-5 space-y-3">
            {upcomingMatches.map((match) => (
              <div
                key={match.matchup}
                className="flex items-center justify-between gap-4 rounded-xl border border-slate-700 bg-slate-800/70 p-4"
              >
                <div>
                  <p className="font-semibold text-slate-100">
                    {match.matchup}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">{match.time}</p>
                </div>
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                  {match.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            My team
          </p>
          <h2 className="mt-2 text-xl font-bold text-white">Team Valiant</h2>

          <div className="mt-5 space-y-3">
            {[
              "Mewtwo • 12 points",
              "Dragonite • 9 points",
              "Garchomp • 8 points",
              "Gyarados • 6 points",
            ].map((pokemon) => (
              <div
                key={pokemon}
                className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3"
              >
                <span className="font-medium text-slate-100">{pokemon}</span>
                <span className="rounded-full bg-amber-500/15 px-2 py-1 text-xs font-semibold text-amber-300">
                  Active
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
