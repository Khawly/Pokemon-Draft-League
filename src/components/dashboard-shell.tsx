/*
 * Main dashboard shell displayed after a user selects a league.
 *
 * Renders the league header (which carries an image-only strip of the signed-in
 * member's roster), notifications, schedule, upcoming matches, standings, and
 * the league rules. Every value comes from the dashboard payload loaded by the
 * page; each panel degrades to an explicit empty state when the league has no
 * data for it yet.
 *
 * Every member name here goes through MemberName, so a member's chosen name
 * colour follows them into the header, the schedule, the matchup cards, and the
 * standings table. A "vs" heading is split into sibling elements rather than one
 * interpolated string, because a single element can only carry one colour.
 */
"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/supabase/auth";
import { Fragment } from "react";
import { getSpriteUrl } from "@/lib/pokeapi";
import { MemberName } from "@/components/member-name";
import { MemberAvatar } from "@/components/member-avatar";
import { TabNotification } from "@/components/nav-alert-badge";
import {
  formatMatchTime,
  formatNotificationAge,
  matchStatusLabel,
  type DashboardGoods,
  type DashboardRosterPokemon,
  type DashboardRosterSprite,
  type DashboardRules,
} from "@/lib/supabase/dashboard";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { useUserTimeZone } from "@/lib/user-timezone";
import { formatDateTimeInZone } from "@/lib/datetime";

/** Navigation tab labels displayed in the league header. */
const tabs = [
  "Dashboard",
  "Draft Board",
  "Teams",
  "Pokémon",
  "Schedule",
  "Trades",
  "Rules",
  "Hall of Fame",
];

/** Maps the navigable header tabs to their route slugs (leagueId is appended). */
const TAB_ROUTES: Record<string, string> = {
  "Draft Board": "draftboard",
  Teams: "teams",
  Pokémon: "pokemon",
  Schedule: "schedule",
  Trades: "trades",
  Rules: "rules",
  "Hall of Fame": "hall-of-fame",
};

/** Builds the route for a tab slug using the selected league id. */
function routeFor(slug: string, leagueId?: string | null): string {
  return leagueId ? `/${slug}?leagueId=${leagueId}` : `/${slug}`;
}

/** Props for the {@link DashboardShell} component. */
export interface DashboardShellProps {
  /** The authenticated user's display name, shown in the header and standings. */
  displayName: string;
  /** The authenticated user's email address. */
  email: string;
  /** The signed-in member's id, so their own name can carry the champion crown. */
  userId?: string | null;
  /** Optional URL for the user's avatar image. Falls back to an initial-based placeholder. */
  avatarUrl?: string | null;
  /**
   * The signed-in member's stored avatar initials, shown in the header when they
   * have no uploaded picture. Null falls back to the shared derivation from their
   * display name, which is what a member who never picked letters has always seen.
   */
  avatarInitials?: string | null;
  /**
   * The signed-in member's stored name colour, applied to their name in the
   * header. Undefined for a member who has not chosen one, which leaves the name
   * exactly as it rendered before.
   */
  nameColor?: string | null;
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
            Last updated {formatDateTimeInZone(rules.updatedAt, timeZone)}
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

/** Props for the {@link RosterStrip} component. */
interface RosterStripProps {
  /** The signed-in member's roster, richest Pokemon first. */
  roster: DashboardRosterPokemon[];
}

/**
 * Image-only view of the signed-in member's roster, shown in the dashboard
 * header so their team is visible on arrival without opening a panel.
 *
 * Deliberately sprites with no names, typing or tiers: the header answers "what
 * is my team at a glance", and the "My team" panel below carries the detail.
 * A rostered Pokemon with no sprite (a token movement) falls back to the same
 * "?" tile the roster panel uses rather than a broken image.
 *
 * @param props - {@link RosterStripProps}
 * @returns A labelled row of roster sprites, or an empty-state line.
 */
function RosterStrip({ roster }: RosterStripProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
        My team
      </p>

      {roster.length === 0 ? (
        <p className="text-sm text-slate-500">No Pokémon rostered yet.</p>
      ) : (
        <ul className="flex flex-wrap items-center gap-2">
          {roster.map((pokemon) => (
            <li
              key={pokemon.id}
              className="relative flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-full border-2 border-slate-900 bg-[linear-gradient(to_bottom,#dc2626_0_45%,#0f172a_45%_55%,#f8fafc_55%)] shadow-md shadow-slate-950/50"
            >
              {/* Pokeball centre button, drawn beneath the sprite. */}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-1/2 h-1/5 w-1/5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 bg-white"
              />
              {pokemon.spriteId > 0 ? (
                <img
                  src={getSpriteUrl(pokemon.spriteId)}
                  alt={pokemon.name}
                  width={64}
                  height={64}
                  loading="lazy"
                  className="relative h-16 w-16 object-contain"
                />
              ) : (
                <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-slate-700 text-base text-slate-400">
                  ?
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The "vs" separator placed between the two sides' rosters in a matchup card.
 *
 * @returns A centred, muted "vs" label that sits in the middle grid column.
 */
function VsLabel() {
  return (
    <span className="flex shrink-0 items-center justify-center self-center text-center text-xs font-bold uppercase tracking-widest text-slate-500">
      vs
    </span>
  );
}

/** Props for the {@link SideLabel} component. */
interface SideLabelProps {
  /** The player's display name. */
  name: string;
  /** The player's stored name colour, or null when they have not chosen one. */
  nameColor?: string | null;
  /** The owner's avatar, or null to show an initial in its place. */
  avatarUrl: string | null;
  /**
   * The player's stored avatar initials, or null to derive them from their name.
   */
  initials?: string | null;
}

/**
 * A player's name with their avatar in front of it, used as the label above each
 * side's sprites in a matchup card.
 *
 * The name is rendered through MemberName so it carries the player's chosen
 * colour; the avatar placeholder beside it keeps the badge's own text colour,
 * since an initial is not a name.
 *
 * @param props - {@link SideLabelProps}
 * @returns A single-line avatar and name, truncated to fit its column.
 */
function SideLabel({ name, nameColor, avatarUrl, initials }: SideLabelProps) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-2">
      <MemberAvatar
        name={name}
        color={nameColor}
        avatarUrl={avatarUrl}
        initials={initials}
        size={48}
      />
      <MemberName
        name={name}
        color={nameColor}
        className="truncate text-xs font-medium text-slate-400"
      />
    </div>
  );
}

/** Props for the {@link LineupSprites} component. */
interface LineupSpritesProps {
  /** The roster to render, richest Pokemon first. */
  roster: DashboardRosterSprite[];
}

/**
 * One team's roster as sprites and nothing else.
 *
 * Used by the Next Match panel, where the point is to show both sides of a
 * matchup at a glance. Deliberately no names, typing, tiers or BST: the names are
 * already in the panel's own heading and the matchup page carries the detail.
 *
 * A rostered Pokemon with no sprite (a token movement) falls back to the same "?"
 * tile the roster panels use rather than a broken image, and a team with nothing
 * rostered says so instead of rendering an empty row.
 *
 * @param props - {@link LineupSpritesProps}
 * @returns A wrapping row of roster sprites, or a short empty-state line.
 */
function LineupSprites({ roster }: LineupSpritesProps) {
  if (roster.length === 0) {
    return <p className="mt-1 text-xs text-slate-500">No Pokémon yet</p>;
  }

  return (
    <ul className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
      {roster.map((pokemon) => (
        <li
          key={pokemon.id}
          className="relative flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-full border-2 border-slate-900 bg-[linear-gradient(to_bottom,#dc2626_0_45%,#0f172a_45%_55%,#f8fafc_55%)] shadow-md shadow-slate-950/50"
        >
          {/* Pokeball centre button, drawn beneath the sprite. */}
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 h-1/5 w-1/5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 bg-white"
          />
          {pokemon.spriteId > 0 ? (
            <img
              src={getSpriteUrl(pokemon.spriteId)}
              alt={pokemon.name}
              width={48}
              height={48}
              loading="lazy"
              className="relative h-12 w-12 object-contain"
            />
          ) : (
            <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-slate-700 text-sm text-slate-400">
              ?
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Full dashboard layout for a selected league.
 *
 * Displays league metadata, notifications, schedule, standings, and the league
 * rules. Provides navigation to the draft board, teams, Pokémon (free agent)
 * and settings pages.
 *
 * @param props - {@link DashboardShellProps}
 * @returns A grid-based dashboard layout.
 */
export function DashboardShell({
  displayName,
  email,
  userId = null,
  avatarUrl,
  avatarInitials = null,
  nameColor,
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
    goods.season?.status === "draft_complete" ||
    goods.season?.status === "archived";

  /*
   * The member's own row in the standings, backing the record and place chips
   * beside their name in the header.
   *
   * standings arrives already ranked by the season_standings RPC and the table
   * below numbers it with index + 1, so the place chip reads the rank the same
   * way: the header and the table can never disagree about a member's position.
   * Null when they have no team, or no row for it (a league mid-setup), in which
   * case the chips are omitted rather than showing a misleading 0-0.
   */
  const myStandingIndex =
    goods.myTeam == null
      ? -1
      : goods.standings.findIndex((row) => row.team_id === goods.myTeam?.id);
  const myStanding =
    myStandingIndex >= 0 ? goods.standings[myStandingIndex] : null;
  const myRank = myStandingIndex >= 0 ? myStandingIndex + 1 : null;

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

  /*
   * The stored colour for the same owner, so a standings row is tinted to match
   * the name it labels. Read off the same team entry `teamLabel` resolves, which
   * means a row for a team missing from the payload simply has no colour and
   * renders as it did before.
   */
  const teamNameColor = (teamId: string) =>
    goods.teams.find((entry) => entry.id === teamId)?.owner_name_color ?? null;

  const matchFormatLabel =
    goods.matchFormat === "single" ? "Single game" : "Best of 3";
  /*
   * The Schedule panel lists the week's matchups without the member's own, which
   * the Next match panel already shows. The data still carries it for that panel.
   */
  const otherWeekMatches = goods.currentWeekMatches.filter(
    (match) =>
      goods.myTeam == null ||
      (match.player_1_team_id !== goods.myTeam.id &&
        match.player_2_team_id !== goods.myTeam.id),
  );

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
              <MemberAvatar
                name={displayName}
                color={nameColor}
                avatarUrl={avatarUrl}
                initials={avatarInitials}
                size={48}
              />

              <div className="flex-1">
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-300">
                  <MemberName
                    name={displayName}
                    color={nameColor}
                    userId={userId}
                  />

                  {myStanding && myRank != null ? (
                    <>
                      <span
                        title="Season record"
                        className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-100"
                      >
                        {myStanding.wins}-{myStanding.losses}
                      </span>
                      <span
                        title="Standing in the league"
                        className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300"
                      >
                        #{myRank} of {goods.standings.length}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <RosterStrip roster={goods.myRoster} />
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
          <section className="grid gap-6 xl:grid-cols-[1.5fr_0.9fr]">
            <div className="xl:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
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
                      isClearingNotifications ||
                      goods.notifications.length === 0
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
                <p className="mt-3 text-xs text-rose-300">
                  {notificationError}
                </p>
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

            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Schedule
                  </p>
                  <h2 className="mt-2 text-xl font-bold text-white">
                    {goods.currentWeek != null
                      ? `Week ${goods.currentWeek} matchups`
                      : "Upcoming matches"}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => router.push(scheduleRoute)}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
                >
                  Manage Schedule
                </button>
              </div>

              {otherWeekMatches.length === 0 ? (
                <p className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
                  {/*
                  Three different empty states, and saying "nothing on the
                  schedule" for a season that is already finished reads as though
                  the league never generated one. totalWeeks is the tell: only
                  generate_schedule sets regular_season_weeks, so it being zero is
                  what "no schedule has been generated" actually means.
                */}
                  {goods.currentWeekMatches.length > 0
                    ? "You have no other matchups this week."
                    : goods.totalWeeks === 0
                      ? "Nothing on the schedule yet. Generate one from the Schedule page."
                      : goods.currentWeek == null
                        ? "Every match in this season has been reported."
                        : "Every matchup in this week has been reported."}
                </p>
              ) : (
                <div className="mt-5 space-y-3">
                  {otherWeekMatches.map((match) => (
                    <div
                      key={match.id}
                      className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800/70 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          {/*
                          Split rather than interpolated: one element can only carry
                          one text colour, so the two sides would otherwise
                          collapse onto whichever colour the container happened to
                          have. `items-baseline` keeps them on a shared baseline
                          now that they are flex items instead of one text run.
                        */}
                          <p className="flex flex-wrap items-baseline gap-x-2 font-semibold text-slate-100">
                            <MemberName
                              name={match.player_1_name}
                              color={match.player_1_name_color}
                              userId={match.player_1_user_id}
                            />
                            <span>vs</span>
                            <MemberName
                              name={match.player_2_name}
                              color={match.player_2_name_color}
                              userId={match.player_2_user_id}
                            />
                          </p>
                          <p className="mt-1 text-sm text-slate-400">
                            {[
                              match.is_playoff
                                ? "Postseason"
                                : `Week ${match.week_number}`,
                              formatMatchTime(match.scheduled_at, timeZone),
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                            match.status === "in_progress"
                              ? "bg-amber-500/15 text-amber-300"
                              : "bg-emerald-500/15 text-emerald-300"
                          }`}
                        >
                          {matchStatusLabel(match.status)}
                        </span>
                      </div>
                      {/* Both sides' Pokemon, sprites only, as on the Next Match panel. */}
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        {[
                          {
                            teamId: match.player_1_team_id,
                            name: match.player_1_name,
                            nameColor: match.player_1_name_color,
                            avatarUrl: match.player_1_avatar_url,
                            initials: match.player_1_avatar_initials,
                          },
                          {
                            teamId: match.player_2_team_id,
                            name: match.player_2_name,
                            nameColor: match.player_2_name_color,
                            avatarUrl: match.player_2_avatar_url,
                            initials: match.player_2_avatar_initials,
                          },
                        ].map((side, index) => (
                          <Fragment key={side.teamId}>
                            {index === 1 && <VsLabel />}
                            <div className="min-w-0 flex-1">
                              <SideLabel
                                name={side.name}
                                nameColor={side.nameColor}
                                avatarUrl={side.avatarUrl}
                                initials={side.initials}
                              />
                              <LineupSprites
                                roster={goods.rostersByTeam[side.teamId] ?? []}
                              />
                            </div>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
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
                    <h3 className="mt-3 flex flex-wrap items-baseline gap-x-2 text-xl font-bold text-white">
                      <MemberName
                        name={goods.nextMatch.player_1_name}
                        color={goods.nextMatch.player_1_name_color}
                      />
                      <span>vs</span>
                      <MemberName
                        name={goods.nextMatch.player_2_name}
                        color={goods.nextMatch.player_2_name_color}
                      />
                    </h3>
                    <p className="mt-2 text-sm text-slate-300">
                      {[
                        goods.nextMatch.is_playoff
                          ? "Postseason"
                          : `Week ${goods.nextMatch.week_number}`,
                        formatMatchTime(goods.nextMatch.scheduled_at, timeZone),
                        matchFormatLabel,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>

                    {/*
                    Both lineups, sprites only. The panel answers "what am I
                    about to face", and six pictures per side does that faster than
                    a list of names; the matchup page carries the detail.
                  */}
                    <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
                      {[
                        {
                          teamId: goods.nextMatch.player_1_team_id,
                          name: goods.nextMatch.player_1_name,
                          nameColor: goods.nextMatch.player_1_name_color,
                          avatarUrl: goods.nextMatch.player_1_avatar_url,
                          initials: goods.nextMatch.player_1_avatar_initials,
                        },
                        {
                          teamId: goods.nextMatch.player_2_team_id,
                          name: goods.nextMatch.player_2_name,
                          nameColor: goods.nextMatch.player_2_name_color,
                          avatarUrl: goods.nextMatch.player_2_avatar_url,
                          initials: goods.nextMatch.player_2_avatar_initials,
                        },
                      ].map((side, index) => (
                        <Fragment key={side.teamId}>
                          {index === 1 && <VsLabel />}
                          <div className="min-w-0 flex-1">
                            <SideLabel
                              name={side.name}
                              nameColor={side.nameColor}
                              avatarUrl={side.avatarUrl}
                              initials={side.initials}
                            />
                            <LineupSprites
                              roster={goods.rostersByTeam[side.teamId] ?? []}
                            />
                          </div>
                        </Fragment>
                      ))}
                    </div>

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
                  <div className="mt-5 overflow-x-auto rounded-xl border border-slate-800">
                    {/*
                    overflow-x-auto rather than overflow-hidden so every column stays
                    reachable when names are long or the viewport is narrow; a hidden
                    overflow would clip the right hand columns with no way to reach them.
                  */}
                    <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
                      <thead className="bg-slate-950 text-slate-300">
                        <tr>
                          <th className="px-4 py-3 font-semibold">Rank</th>
                          <th className="px-4 py-3 font-semibold">Trainer</th>
                          <th className="px-4 py-3 font-semibold">W</th>
                          <th className="px-4 py-3 font-semibold">L</th>
                          <th className="px-4 py-3 text-center font-semibold">
                            KO Diff
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 bg-slate-900">
                        {goods.standings.map((row, index) => (
                          <tr
                            key={row.team_id}
                            className="hover:bg-slate-800/80"
                          >
                            <td className="px-4 py-3 font-medium text-slate-100">
                              {index + 1}
                            </td>
                            <td className="px-4 py-3">
                              <MemberName
                                name={teamLabel(row.team_id, row.team_name)}
                                color={teamNameColor(row.team_id)}
                                className="font-medium text-slate-100"
                              />
                            </td>
                            <td className="px-4 py-3 text-slate-300">
                              {row.wins}
                            </td>
                            <td className="px-4 py-3 text-slate-300">
                              {row.losses}
                            </td>
                            <td className="px-4 py-3 text-center font-medium text-slate-100">
                              {row.ko_diff > 0
                                ? `+${row.ko_diff}`
                                : row.ko_diff}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </aside>
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
