/*
 * Schedule page for a league.
 *
 * Implements spec section 10. An owner-only Setup tab saves the season's
 * schedule configuration (regular season weeks, match format, playoff field
 * and format) and generates the round-robin regular season matchups, with the
 * calculated first-round byes shown read-only. A matchup is only "scheduled"
 * once both players have agreed: it opens Unscheduled, one participant proposes a
 * time, and the match becomes Scheduled only when the opponent accepts, so no
 * card ever claims an agreement nobody made. Declining or withdrawing drops it
 * back to Unscheduled. The Schedule tab offers a
 * current-week/matchup selector and a matchup card (avatars and names, game
 * record like 2-1) where participants can propose/reschedule a match, accept or
 * decline the opponent's proposal, submit
 * one result per game with a replay link (`Link already submitted` on
 * duplicates), forfeit, and where owners/admins can correct results. A "Filter"
 * checkbox (on by default) covers the matchup card's spoilers with black
 * rectangles: the match winner, the per-game winners, and each game's surviving
 * Pokemon count. A best-of-3 decided in two also shows a mirrored third game
 * that copies game 2, rendered only and never submitted, so it adds no
 * differential. A "Read replay"
 * button pulls the winner and surviving Pokemon count out of the
 * Showdown battle log for a pasted link, and the form shows the resulting KO
 * differential read-only so nobody has to type a signed number into the
 * unsigned count box. Upcoming matches are listed with the user's matches
 * first. Every member can predict the winner of a matchup from its card; a
 * correct pick is worth one PP point in the standings, and picks close at the
 * scheduled time or when the first game is submitted. Standings shows rank /
 * player / W-L / KO Diff / PP, Playoffs renders the seeded bracket (single or
 * double elimination, advanced round by round by the owner), and History lists
 * every posted game newest first. All match times are shown in the time zone the
 * member picked in user settings, and the header states the league's next weekly
 * deadline in that same zone. Opening the scheduling form for a matchup also
 * surfaces the opponent's declared availability, projected into the reader's
 * zone, and flags a proposed time that falls outside it. Match-time events
 * (proposed, accepted, declined, withdrawn) are reported on the dashboard's
 * Schedule nav button as an unread-count badge rather than as a panel here, and
 * are cleared by opening the schedule.
 * Member display names are rendered through `MemberName`, so wherever the page
 * names a player the name appears in the colour that member picked, with their
 * Pokemon Showdown handle in parentheses on the matchup and upcoming-match cards.
 * The one exception is a `<select>` option, which cannot hold a styled span.
 * Opening the page also nudges the weekly deadline sweep so a week whose
 * deadline passed while the app server was idle is settled and the playoff
 * bracket opened before the schedule renders.
 */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageShell, PageShellCard, PageShellLoading } from "@/components/page-shell";
import { useShellLeague } from "@/components/league-shell-context";
import { getSelectedSeason } from "@/lib/season-selection";
import { useConfirm } from "@/components/confirm-dialog";
import { CrownProvider } from "@/components/crown-provider";
import { loadWeekProgressState, runWeekDeadlineSweep, type WeekProgressState } from "@/lib/supabase/week-deadline";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { deleteMatch } from "@/lib/supabase/teams";
import { useUserTimeZone } from "@/lib/user-timezone";
import { useRealtimeInvalidation } from "@/lib/use-realtime-invalidation";
import { formatInTimeZone, formatTimeZoneLabel } from "@/lib/datetime";
import * as scheduleApi from "@/lib/supabase/schedule";
import { requireInteger } from "@/lib/validation";
import { StandingsTab } from "./standings-tab";
import { PlayoffsTab } from "./playoffs-tab";
import { SetupTab } from "./setup-tab";
import { HistoryTab } from "./history-tab";
import { MatchupTab } from "./matchup-tab";
import { useMatchupPanel } from "./use-matchup-panel";

/** Labels enumerating the visible tabs (Setup is owner-only). */
const TABS = ["Schedule", "Standings", "Playoffs", "History", "Setup"] as const;

type Tab = (typeof TABS)[number];

/**
 * Wraps the schedule content in a Suspense boundary to satisfy Next.js's
 * client-side streaming requirement for `useSearchParams`.
 *
 * @returns The schedule page with a loading fallback.
 */
export default function SchedulePage() {
  return (
    <Suspense fallback={<PageShellLoading label="Loading schedule" />}>
      <ScheduleRoute />
    </Suspense>
  );
}

/**
 * Bridge component that reads the search params inside the Suspense boundary.
 *
 * @returns The schedule page content.
 */
function ScheduleRoute() {
  const searchParams = useSearchParams();
  return <SchedulePageContent searchParams={searchParams} />;
}

/**
 * Resolves the league from the query param or last-selected league and
 * orchestrates the page's state and mutations.
 */
function SchedulePageContent({
  searchParams,
}: {
  searchParams: URLSearchParams | null;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [goods, setGoods] = useState<scheduleApi.SchedulePageGoods | null>(null);

  /**
   * The current payload, readable from a callback without re-creating it.
   *
   * The realtime handler needs to compare the incoming matches against the ones on screen
   * to know whether the standings moved, and taking `goods` as a dependency would tear
   * down and rebuild the realtime subscription on every update it made.
   */
  const goodsRef = useRef<scheduleApi.SchedulePageGoods | null>(null);

  // Kept in step with the state, so a callback can read the latest without depending on it.
  useEffect(() => {
    goodsRef.current = goods;
  }, [goods]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /*
   * The owner-only match-time negotiation log, held apart from `goods` and
   * fetched only when the owner opens the History tab, because it grows with
   * every rescheduling attempt in the season and no other view wants it.
   *
   * Carries the league and season it belongs to rather than being cleared on
   * navigation. Keying it means a stale log is ignored instead of having to be
   * emptied with a state update, which avoids the extra render a reset in an
   * effect would cause and makes a slow response for a league the owner has
   * already left harmless.
   */
  const [proposalHistoryState, setProposalHistoryState] = useState<{
    key: string;
    entries: scheduleApi.ProposalHistoryEntry[];
    isLoading: boolean;
    error: string | null;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const requested = searchParams?.get("tab")?.trim().toLowerCase();

    if (!requested) {
      return "Schedule";
    }

    // Setup is owner-only and is filtered from the tab strip for other members,
    // so it is never selected from a URL.
    return (
      TABS.find((tab) => tab !== "Setup" && tab.toLowerCase() === requested) ??
      "Schedule"
    );
  });

  const [form, setForm] = useState({
    weeks: 0,
    matchFormat: "best_of_3" as "single" | "best_of_3",
    playoffTeams: 0,
    playoffMatchFormat: "best_of_3" as "single" | "best_of_3",
    playoffFormat: "single_elimination" as
      | "single_elimination"
      | "double_elimination",
  });

  /**
   * How the owner wants the regular season built.
   *
   * Kept in page state rather than the settings row: it describes this editing session,
   * not the season. Whatever is saved is the season's schedule either way, and the mode
   * does not need to survive a reload.
   */
  const [scheduleMode, setScheduleMode] = useState<"automatic" | "manual">(
    "automatic",
  );
  const [isSavingManual, setIsSavingManual] = useState(false);
  const [isSavingToilet, setIsSavingToilet] = useState(false);

  /*
   * The league's weekly deadline, shown in the header. Read through the same RPC
   * the league settings page uses so the date here can never disagree with the
   * one the owner configured.
   */
  const [weekProgress, setWeekProgress] = useState<WeekProgressState | null>(
    null,
  );

  const shellLeague = useShellLeague();
  /** True when the shell resolved no league for this member. */
  const shellLeagueMissing =
    !shellLeague.isResolving && !shellLeague.signedOut && !shellLeague.leagueId;

  useEffect(() => {
    if (shellLeague.signedOut) {
      router.replace("/");
    }
  }, [shellLeague.signedOut, router]);

  /*
   * The zone every match time on this page is rendered in, resolved from the
   * member's settings rather than the browser's.
   */
  const timeZone = useUserTimeZone();

  const refresh = useCallback(async (leagueId: string) => {
    const next = await scheduleApi.loadSchedulePageData(
      leagueId,
      getSelectedSeason(leagueId),
    );
    setGoods(next);
    if (next.settings) {
      setForm({
        weeks: next.settings.regular_season_weeks,
        matchFormat: next.settings.match_format,
        playoffTeams: next.settings.playoff_team_count,
        playoffMatchFormat: next.settings.playoff_match_format,
        playoffFormat: next.settings.playoff_format,
      });
    }
    // The header advertises the next weekly deadline, so it is re-read on every
    // refresh; a league that has not applied the migration simply shows none.
    try {
      setWeekProgress(await loadWeekProgressState(leagueId));
    } catch {
      setWeekProgress(null);
    }

    return next;
  }, []);

  useEffect(() => {
    // Wait for the shell: it owns the URL, the session, and the league. The
    // missing-league case is handled in the render below, so this effect only
    // fetches and never writes state synchronously.
    if (shellLeague.isResolving || shellLeague.signedOut) {
      return;
    }

    if (!shellLeague.leagueId) {
      return;
    }

    const activeLeagueId = shellLeague.leagueId;
    let cancelled = false;

    async function loadLeague() {
      try {
        setIsLoading(true);
        setError(null);

        // Nudge the weekly deadline sweep so a week that closed while the app
        // server was idle is settled before the schedule renders.
        try {
          await runWeekDeadlineSweep();
        } catch {
          // Best effort: the server heartbeat retries it.
        }

        const next = await refresh(activeLeagueId);
        if (!cancelled) {
          setGoods(next);
          setIsLoading(false);
        }
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "The schedule could not be loaded.";
        if (!cancelled) {
          setError(message);
          setIsLoading(false);
        }
      }
    }

    loadLeague();
    return () => {
      cancelled = true;
    };
  }, [
    router,
    shellLeague.leagueId,
    shellLeague.isResolving,
    shellLeague.signedOut,
    refresh,
  ]);

  const regularMatches = useMemo(
    () => (goods ? goods.matches.filter((match) => !match.is_playoff) : []),
    [goods],
  );

  /*
   * The week the league is in.
   *
   * When the league uses the weekly deadline, `league_settings.current_week` is
   * the authority: the deadline sweep and the manual Progress/Undo controls own
   * that pointer, and it is the value the rest of the league agrees on. Deriving
   * "the first week that still has an undecided match" instead let the page
   * disagree with the league whenever a past match was not in fact closed, which
   * dragged the header and the week selector back to a week the league had
   * already left. The derived value stays as the fallback for a league with no
   * deadline configured, where nothing maintains a week pointer.
   */
  const currentWeek = useMemo(() => {
    /*
     * The deadline pointer belongs to the current season. On a history view it would
     * report a week from a different season's calendar, so the matches themselves decide
     * instead -- which is also how a league with no deadlines is handled.
     */
    if (
      goods?.isCurrentSeason &&
      weekProgress?.deadline_enabled &&
      weekProgress.current_week > 0
    ) {
      return weekProgress.current_week;
    }

    const weeks = [
      ...new Set(regularMatches.map((match) => match.week_number)),
    ];
    for (const week of weeks.sort((a, b) => a - b)) {
      const weekMatches = regularMatches.filter(
        (match) => match.week_number === week,
      );
      const open = weekMatches.some(
        (match) =>
          match.status !== "completed" &&
          match.status !== "forfeit" &&
          match.status !== "cancelled",
      );
      if (open) {
        return week;
      }
    }
    return null;
  }, [goods?.isCurrentSeason, regularMatches, weekProgress]);

  /*
   * What the header calls the phase the league is in.
   *
   * Derived from the regular season rather than from the week pointer alone, so
   * a league that has not started a week yet reads as the preseason instead of
   * claiming the postseason.
   */
  const phaseLabel = useMemo(
    () =>
      scheduleApi.seasonPhaseLabel({
        currentWeek,
        regularSeasonCompleted:
          goods?.isCurrentSeason === true &&
          weekProgress?.regular_season_completed === true,
        regularMatches,
      }),
    [currentWeek, goods?.isCurrentSeason, regularMatches, weekProgress],
  );

  /**
   * Re-reads the schedule after a real-time change, unless a form is open.
   *
   * Deliberately not the full payload. A change to the match table is the common case by
   * a wide margin, and most of those are scheduling rather than results, so re-reading the
   * league, season, teams, members, settings, rosters and bracket template as well was
   * paying a dozen requests for one row that moved. Those do not change while the page is
   * open, and the ones that can are picked up by the full refresh the page's own actions
   * already trigger.
   *
   * The standings and champion are re-read only when a result actually landed, which is
   * what they are derived from; see {@link scheduleApi.movesStandings}. That makes the usual realtime
   * update a single request.
   */
  const reloadForRealtime = useCallback(async () => {
    const leagueId = goodsRef.current?.league.id;
    const seasonId = goodsRef.current?.season?.id;

    if (!leagueId || !seasonId) {
      return;
    }

    try {
      const vacantTeamIds = new Set(
        (goodsRef.current?.teams ?? [])
          .filter((team) => team.is_vacant)
          .map((team) => team.id),
      );

      const matches = await scheduleApi.loadScheduleMatches(
        leagueId,
        seasonId,
        goodsRef.current?.ownerDisplayName ?? null,
        goodsRef.current?.currentUserId ?? "",
        vacantTeamIds,
      );

      const standingsMoved = scheduleApi.movesStandings(
        goodsRef.current?.matches ?? [],
        matches,
      );

      /*
       * A settled match can also be what closes a week, and the header reads the week
       * pointer for the phase label and the current week, so it is re-read alongside the
       * table rather than on every change. Both are consequences of a result landing.
       */
      const live = standingsMoved
        ? await Promise.all([
            scheduleApi.loadScheduleStandings(leagueId, seasonId),
            loadWeekProgressState(leagueId).catch(() => null),
          ])
        : null;

      setGoods((previous) =>
        previous
          ? {
              ...previous,
              matches,
              standings: live?.[0].standings ?? previous.standings,
              championTeamId:
                live?.[0].championTeamId ?? previous.championTeamId,
              crownedMemberIds:
                live?.[0].crownedMemberIds ?? previous.crownedMemberIds,
            }
          : previous,
      );

      if (live) {
        setWeekProgress(live[1]);
      }
    } catch {
      // A failed background refresh leaves the page showing what it had rather than
      // throwing the member out of a page they are reading.
    }
  }, []);

  /**
   * The week the postseason counts from, taken from the season's whole match list so the
   * numbering stays put as rounds are played rather than shifting with whatever subset a
   * panel is showing.
   */
  const firstPlayoffWeek = useMemo(
    () => scheduleApi.firstPlayoffWeekOf(goods?.matches ?? []),
    [goods?.matches],
  );

  /**
   * Runs a write, refreshes the page, and reports whether it succeeded.
   *
   * Every mutation on the page goes through here so the busy flag, the error and
   * notice banners, and the reload after a write stay in one place.
   *
   * @param mutation - The write to perform.
   * @param leagueId - The league to reload once the write lands.
   * @returns True when the write and the reload both succeeded.
   */
  const canRunMutation = async (
    mutation: () => Promise<unknown>,
    leagueId: string,
  ): Promise<boolean> => {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      await mutation();
      await refresh(leagueId);
      return true;
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "That action could not be completed.",
      );
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  /*
   * The Matchup tab's state lives in its own hook so the tab can be rendered from
   * one object rather than from fifty props. The realtime pause and the deferred
   * flush are wired through a ref because the watcher is declared after the hook.
   */
  const flushRealtimeRef = useRef<() => void>(() => {});
  const matchup = useMatchupPanel({
    goods,
    currentWeek,
    firstPlayoffWeek,
    timeZone,
    confirm,
    canRunMutation,
    setError,
    setNotice,
    onFormClosed: () => flushRealtimeRef.current(),
  });
  /*
   * Loads the match-time negotiation log for the owner.
   *
   * Held in a ref as well as state so the realtime watcher can call it without
   * the callback being rebuilt on every render, and so the tab effect below has a
   * stable identity to depend on.
   */
  const proposalHistoryKey =
    goods?.isOwner && goods.season
      ? `${goods.league.id}:${goods.season.id}`
      : null;

  const loadProposalHistoryForOwner = useCallback(async () => {
    const leagueId = goods?.league.id;
    const seasonId = goods?.season?.id;

    if (!goods?.isOwner || !leagueId || !seasonId) {
      return;
    }

    const key = `${leagueId}:${seasonId}`;

    setProposalHistoryState((previous) => ({
      key,
      entries: previous?.key === key ? previous.entries : [],
      isLoading: true,
      error: null,
    }));

    try {
      setProposalHistoryState({
        key,
        entries: await scheduleApi.loadProposalHistory(leagueId, seasonId),
        isLoading: false,
        error: null,
      });
    } catch {
      /*
       * Deliberately not raised into the page's own error state: the rest of the
       * History tab is still worth reading, and a member who is not the owner
       * never triggers this at all.
       */
      setProposalHistoryState((previous) => ({
        key,
        entries: previous?.key === key ? previous.entries : [],
        isLoading: false,
        error: "The match proposal log could not be loaded.",
      }));
    }
  }, [goods?.isOwner, goods?.league.id, goods?.season?.id]);

  const loadProposalHistoryRef = useRef(loadProposalHistoryForOwner);
  useEffect(() => {
    loadProposalHistoryRef.current = loadProposalHistoryForOwner;
  }, [loadProposalHistoryForOwner]);

  /*
   * Fetch the log when the owner reaches the History tab. Leaving the tab does
   * not clear it: the log is keyed to its league and season, so it is ignored
   * automatically if the owner switches league, and keeping it means returning to
   * the tab shows the previous result immediately instead of flashing a spinner
   * over a log that was there a moment ago.
   */
  useEffect(() => {
    if (activeTab !== "History" || !proposalHistoryKey) {
      return;
    }

    void loadProposalHistoryRef.current();
  }, [activeTab, proposalHistoryKey]);

  /** The log, but only when it belongs to the league and season on screen. */
  const proposalHistory =
    proposalHistoryState?.key === proposalHistoryKey
      ? proposalHistoryState
      : null;

  /*
   * Live updates for the matchups, their agreed times, and the proposals behind
   * them. A change that lands while a form is open is held and applied when the
   * form closes, so the update is deferred rather than lost.
   */
  const { flush: flushRealtime } = useRealtimeInvalidation({
    leagueId: goods?.league.id ?? null,
    watchers: [
      { table: "matches", onChange: reloadForRealtime },
      // A proposal change is also the one thing that alters the owner's log, so
      // the log is refetched alongside the page when the owner is looking at it.
      {
        table: "match_scheduling_proposals",
        onChange: () => {
          reloadForRealtime();

          if (activeTab === "History" && proposalHistoryKey) {
            void loadProposalHistoryRef.current();
          }
        },
      },
    ],
    isPaused: () => matchup.formOpen,
  });

  useEffect(() => {
    flushRealtimeRef.current = flushRealtime;
  }, [flushRealtime]);

  /**
   * Labels a team by its owner's live display name, falling back to the team name.
   *
   * The standings RPC returns `teams.team_name`, which is a snapshot taken when
   * the draft started. Using it here meant the standings kept showing a member's
   * old name beside their new avatar after they renamed themselves.
   *
   * @param teamId - The team to label.
   * @param fallbackName - The snapshot name to use when no display name is set.
   * @returns The name to display.
   */
  const teamLabel = useCallback(
    (teamId: string, fallbackName: string) => {
      const team = goods?.teams.find((entry) => entry.id === teamId);
      return team?.owner_name || fallbackName;
    },
    [goods?.teams],
  );

  /**
   * The colour a team's owner picked for their display name, for the same lookup
   * `teamLabel` does. A standings row only carries the team's id, so the colour
   * has to be resolved against the loaded teams rather than read off the row.
   *
   * @param teamId - The team whose owner's colour is wanted.
   * @returns The stored name colour, or null when the member has none set.
   */
  const teamColor = useCallback(
    (teamId: string) =>
      goods?.teams.find((entry) => entry.id === teamId)?.owner_name_color ??
      null,
    [goods?.teams],
  );

  /**
   * The initials the same team's owner picked for their avatar, resolved through
   * the identical lookup as `teamColor` so a standings row carries the same letters
   * the rest of the app shows for that member.
   *
   * @param teamId - The team whose owner's stored initials are wanted.
   * @returns The stored avatar initials, or null when the member has none set.
   */
  const teamInitials = useCallback(
    (teamId: string) =>
      goods?.teams.find((entry) => entry.id === teamId)
        ?.owner_avatar_initials ?? null,
    [goods?.teams],
  );

  /**
   * The member id of a team's owner, resolved through the same lookup as
   * {@link teamLabel}. Standings rows only carry a team id, and passing the owner's
   * id to `MemberName` lets the champion crown match exactly instead of by name.
   *
   * A vacated team returns null: the row now names "No User", and its old
   * owner's champion crown must not follow the placeholder.
   *
   * @param teamId - The team whose owner's member id is wanted.
   * @returns The owner's user id, or null when the team is missing or vacant.
   */
  const teamOwnerId = useCallback(
    (teamId: string) => {
      const team = goods?.teams.find((entry) => entry.id === teamId);
      return team && !team.is_vacant ? team.owner_user_id : null;
    },
    [goods?.teams],
  );

  /**
   * The bracket's full shape, including games that do not exist yet.
   *
   * The template drives the display rather than the matches, so a league with no
   * generated bracket still shows the whole tournament: every round, where each seed
   * enters, and how a loser progresses.
   */
  const playoffTemplateRows = useMemo(
    () => goods?.playoffTemplate?.rows ?? [],
    [goods?.playoffTemplate],
  );

  /**
   * Resolves a team id for the bracket, preferring the match's own participant data so
   * a team that has not yet been drawn into a match still shows its real name.
   */
  const playoffTeamResolver = useCallback(
    (teamId: string | null): { name: string; color: string | null } | null => {
      if (!teamId || !goods) {
        return null;
      }

      const team = goods.teams.find((entry) => entry.id === teamId);

      return {
        name: team?.owner_name?.trim() || team?.team_name || "TBD",
        color: team?.owner_name_color ?? null,
      };
    },
    [goods],
  );

  /*
   * The champion banner.
   *
   * The team id comes from the database function that decides it. This used to be worked
   * out here instead, by taking a finished grand final and falling back to "the last
   * completed winners game" for a league with no finals. That fallback is a single
   * elimination rule: in a double elimination bracket it matches the first completed game
   * of the first round, so the banner named a champion one round into the tournament. A
   * settled bye looks exactly like a completed game under that test, which is why it
   * appeared the moment a bye did.
   */
  const championTeamId = goods?.championTeamId ?? null;
  const championWinner = playoffTeamResolver(championTeamId);

  const history = useMemo(() => {
    if (!goods) {
      return [];
    }
    const games: (scheduleApi.ScheduleMatchResult & { match: scheduleApi.ScheduleMatch })[] = [];
    for (const match of goods.matches) {
      for (const result of match.results) {
        games.push({ ...result, match });
      }
    }
    return games.sort(
      (a, b) =>
        new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
    );
  }, [goods]);

  /*
   * A playoff field can be any size from two up to the size of the league, and the league
   * size is the maximum: a bracket cannot be filled with teams that do not exist. The
   * number of byes follows from rounding that field up to the next power of two.
   */
  const leagueSize = goods?.teams.length ?? 0;
  const maxPlayoffTeams = leagueSize;
  const byes =
    form.playoffTeams >= 2 && form.playoffTeams <= maxPlayoffTeams
      ? scheduleApi.nextPowerOfTwo(form.playoffTeams) - form.playoffTeams
      : 0;

  /** The owner's proposal log, bucketed into weeks for the history panel. */
  const proposalHistoryGroups = useMemo(
    () => scheduleApi.groupProposalHistoryByWeek(proposalHistory?.entries ?? []),
    [proposalHistory],
  );

  async function handleGenerateSchedule() {
    if (!goods) {
      return;
    }

    let weeks: number;
    let playoffTeams: number;

    try {
      weeks = requireInteger(form.weeks, "Regular season weeks", 1, 52);
      playoffTeams = requireInteger(
        form.playoffTeams,
        "Playoff teams",
        0,
        maxPlayoffTeams,
      );

      if (playoffTeams === 1) {
        throw new Error("Playoff teams must be 0 or at least 2.");
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Check the schedule settings before generating.",
      );
      return;
    }

    const matchCount = weeks;
    const shouldGenerate = await confirm({
      title: "Regenerate the season schedule?",
      detail:
        matchCount > 0
          ? `This replaces the schedule with ${matchCount} week${
              matchCount === 1 ? "" : "s"
            } of round-robin matchups. Every existing match and result is removed.`
          : "This replaces the season schedule. Every existing match and result is removed.",
      confirmLabel: "Regenerate",
      tone: "danger",
    });
    if (!shouldGenerate) {
      return;
    }
    const generated = await canRunMutation(
      () =>
        scheduleApi.generateSchedule(goods.league.id, {
          regular_season_weeks: weeks,
          match_format: form.matchFormat,
          playoff_team_count: playoffTeams,
          playoff_match_format: form.playoffMatchFormat,
          playoff_format: form.playoffFormat,
        }),
      goods.league.id,
    );

    if (generated) {
      setNotice("Schedule generated.");
    }
  }

  /**
   * Saves the pairings the owner laid out by hand.
   *
   * Same destructive confirmation as the random path, because the database replaces the
   * season's matches either way and an owner who forgot they had results would otherwise
   * lose them without warning.
   */
  async function handleSaveManualSchedule(games: scheduleApi.ManualScheduleGame[]) {
    if (!goods) {
      return;
    }

    let weeks: number;
    let playoffTeams: number;

    try {
      weeks = requireInteger(form.weeks, "Regular season weeks", 1, 52);
      playoffTeams = requireInteger(
        form.playoffTeams,
        "Playoff teams",
        0,
        maxPlayoffTeams,
      );

      if (playoffTeams === 1) {
        throw new Error("Playoff teams must be 0 or at least 2.");
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Check the schedule settings before saving.",
      );
      return;
    }

    if (games.length === 0) {
      setError("Add at least one matchup before saving the schedule.");
      return;
    }

    const confirmed = await confirm({
      title: "Save this schedule?",
      detail: `${games.length} matchup${
        games.length === 1 ? "" : "s"
      } across ${weeks} week${
        weeks === 1 ? "" : "s"
      }. Every existing match and result this season is removed and replaced.`,
      confirmLabel: "Save schedule",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    setIsSavingManual(true);

    try {
      const saved = await canRunMutation(
        () =>
          scheduleApi.saveManualSchedule(
            goods.league.id,
            {
              regular_season_weeks: weeks,
              match_format: form.matchFormat,
              playoff_team_count: playoffTeams,
              playoff_match_format: form.playoffMatchFormat,
              playoff_format: form.playoffFormat,
            },
            games,
          ),
        goods.league.id,
      );

      if (saved) {
        setNotice(
          `Schedule saved: ${games.length} matchup${games.length === 1 ? "" : "s"}.`,
        );
      }
    } finally {
      setIsSavingManual(false);
    }
  }

  async function handleToggleToiletBowl(enabled: boolean) {
    if (!goods) {
      return;
    }

    setIsSavingToilet(enabled);

    try {
      await scheduleApi.setToiletBowl(goods.league.id, enabled);
      setGoods((previous) =>
        previous && previous.settings
          ? {
              ...previous,
              settings: { ...previous.settings, enable_toilet_bowl: enabled },
            }
          : previous,
      );
      setNotice(
        enabled
          ? "Toilet Bowl enabled. It is built from the non-playoff teams when the playoffs open."
          : "Toilet Bowl disabled.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The setting could not be saved.",
      );
    } finally {
      setIsSavingToilet(false);
    }
  }

  async function handleAdvancePlayoffs() {
    if (!goods) {
      return;
    }
    await canRunMutation(
      () => scheduleApi.generatePlayoffRound(goods.league.id),
      goods.league.id,
    );
    setNotice("Playoff bracket advanced.");
  }

  /**
   * Clears the bracket after confirming, because it cannot be undone.
   *
   * The dialog spells out the consequences rather than saying "are you sure": the
   * owner is about to lose recorded results and any standings they fed, and a reset
   * that reseeds can produce a different bracket than the one on screen.
   */
  async function handleResetPlayoffs() {
    if (!goods) {
      return;
    }

    const confirmed = await confirm({
      title: "Reset the playoff bracket?",
      detail:
        "Every playoff match and its result is deleted, and the bracket reseeds from the current standings next time you advance. Regular season results are kept, but playoff results currently counting toward the standings table will disappear. This cannot be undone.",
      confirmLabel: "Reset bracket",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    await canRunMutation(async () => {
      const removed = await scheduleApi.resetPlayoffBracket(goods.league.id);
      setNotice(
        removed === 0
          ? "There was no playoff bracket to reset."
          : `Playoff bracket reset. ${removed} playoff match${removed === 1 ? "" : "es"} removed.`,
      );
    }, goods.league.id);
  }

  async function handleDeleteMatch(match: scheduleApi.ScheduleMatch) {
    if (!goods) {
      return;
    }

    const deleting = await confirm({
      title: "Delete this match?",
      detail: `${match.player_1_name} vs ${match.player_2_name} and every result posted for it`,
      confirmLabel: "Delete",
      tone: "danger",
    });

    if (!deleting) {
      return;
    }
    await canRunMutation(() => deleteMatch(match.id), goods.league.id);
    setNotice("Match deleted.");
  }

  if (shellLeagueMissing) {
    return (
      <PageShellCard widthClassName="max-w-xl">
        You are not a member of any active league.
      </PageShellCard>
    );
  }

  if (isLoading) {
    return <PageShellLoading label="Loading schedule" />;
  }

  if (!goods) {
    return (
      <PageShellCard widthClassName="max-w-xl">
        {error ?? "The schedule could not be loaded."}
      </PageShellCard>
    );
  }

  /*
   * Setup is the owner's switchboard, and a past season has nothing to set up: its
   * schedule is already whatever it was. Hiding it rather than disabling it keeps a
   * history view from looking like a live one.
   */
  const tabs = goods.isOwner
    ? TABS.filter((tab) => goods.isCurrentSeason || tab !== "Setup")
    : TABS.filter((tab) => tab !== "Setup");
  const generateDisabled =
    isBusy ||
    !Number.isInteger(form.weeks) ||
    form.weeks < 1 ||
    form.weeks > 52 ||
    !Number.isInteger(form.playoffTeams) ||
    (form.playoffTeams !== 0 &&
      (form.playoffTeams < 2 || form.playoffTeams > maxPlayoffTeams));

  /*
   * The next weekly deadline, in the reader's zone. The league configures the
   * anchor date, time, and zone on its settings page; only the rendering zone
   * differs here, so a member in another region still sees the same instant.
   *
   * An enabled deadline with no anchor date is called out separately from an
   * unconfigured one, because only the owner can fix it and the member should be
   * able to tell which situation they are in.
   */
  const deadlineInstant = weekProgress?.next_deadline
    ? new Date(weekProgress.next_deadline)
    : null;
  const hasDeadline = Boolean(
    weekProgress?.deadline_enabled && deadlineInstant,
  );

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
        <div className="mx-auto max-w-[96rem] space-y-6">
          <header
            className="sticky z-30 rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-2xl backdrop-blur-md sm:p-6 shadow-slate-950/40"
            style={{ top: "calc(var(--app-nav-height, 4rem) + 1rem)" }}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="text-3xl font-bold text-white">
                  {goods.league.name}
                </h1>
                <p className="mt-1 text-sm text-slate-400">
                  Schedule • {formatSeasonLabel(goods.season)}
                  {` • ${phaseLabel}`}
                  {" • All times in "}
                  <span className="text-slate-300">
                    {formatTimeZoneLabel(timeZone)}
                  </span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(activeTab === "Schedule" || activeTab === "History") && (
                  <label
                    className="flex items-center gap-2 rounded-full bg-slate-800 px-3.5 py-2 text-sm text-slate-300"
                    title="Hide the match winner, the per-game winners, and each game's KO differential"
                  >
                    <input
                      type="checkbox"
                      checked={matchup.hideSpoilers}
                      onChange={(event) =>
                        matchup.setHideSpoilers(event.target.checked)
                      }
                      className="size-4 accent-amber-500"
                    />
                    <span>Spoiler Filter</span>
                  </label>
                )}
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`rounded-full px-3.5 py-2 text-sm font-medium transition ${
                      activeTab === tab
                        ? "bg-amber-500 text-slate-950"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>
          </header>

          {/*
           * A history view says so, in the place the member will look first. Without this,
           * a past season's page looks exactly like the live one until an action turns out
           * to be missing -- which reads as a bug rather than as a rule.
           */}
          {!goods.isCurrentSeason && (
            <div className="rounded-2xl border border-sky-800/60 bg-sky-950/40 px-5 py-4 text-sm text-sky-200">
              <p className="font-semibold uppercase tracking-[0.15em] text-sky-300">
                Viewing history
              </p>
              <p className="mt-1">
                This is not the league&apos;s current season, so it is
                read-only. Results, standings and history are shown as they
                finished. To schedule or report a match, switch to the current
                season from the dashboard.
              </p>
            </div>
          )}

          {/*
           * The weekly deadline is a league-wide commitment, so it is announced in
           * its own banner rather than as another line of grey subtext in the
           * header: a member who has not proposed a time yet needs to know how
           * long they have left to agree on one.
           */}
          {goods.isCurrentSeason && hasDeadline && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">
                  Weekly deadline
                </p>
                <p className="mt-1 text-lg font-semibold text-amber-100">
                  {formatInTimeZone(deadlineInstant as Date, timeZone)}
                </p>
              </div>
              <p className="text-sm text-amber-200/80">
                {weekProgress?.deadline_paused
                  ? "Paused by the league owner; matches are not being closed yet."
                  : `Unreported matches close at this time (shown in ${formatTimeZoneLabel(timeZone)}).`}
              </p>
            </div>
          )}

          {goods.isCurrentSeason && !hasDeadline && (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-5 py-3 text-sm text-slate-400">
              {weekProgress?.deadline_enabled
                ? "Weekly deadlines are enabled for this league, but no first deadline date has been set yet."
                : "This league has no weekly deadline; matchups stay open until both players agree on a time."}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-800 bg-rose-900/40 p-4 text-sm text-rose-200">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-xl border border-emerald-800 bg-emerald-900/40 p-4 text-sm text-emerald-200">
              {notice}
            </div>
          )}

          {activeTab === "Setup" && goods.isOwner && goods.isCurrentSeason && (
            <SetupTab
              goods={goods}
              scheduleMode={scheduleMode}
              onScheduleModeChange={setScheduleMode}
              form={form}
              onFormChange={setForm}
              maxPlayoffTeams={maxPlayoffTeams}
              byes={byes}
              generateDisabled={generateDisabled}
              onGenerateSchedule={() => void handleGenerateSchedule()}
              isSavingToilet={isSavingToilet}
              onToggleToiletBowl={(enabled) =>
                void handleToggleToiletBowl(enabled)
              }
              isSavingManual={isSavingManual}
              onSaveManualSchedule={(games) =>
                void handleSaveManualSchedule(games)
              }
            />
          )}
          {activeTab === "Schedule" && (
            <MatchupTab
              goods={goods}
              isBusy={isBusy}
              timeZone={timeZone}
              panel={matchup}
            />
          )}

          {activeTab === "Standings" && (
            <StandingsTab
              goods={goods}
              teamLabel={teamLabel}
              teamColor={teamColor}
              teamInitials={teamInitials}
              teamOwnerId={teamOwnerId}
            />
          )}

          {activeTab === "Playoffs" && (
            <PlayoffsTab
              goods={goods}
              isBusy={isBusy}
              onResetPlayoffs={() => void handleResetPlayoffs()}
              onAdvancePlayoffs={() => void handleAdvancePlayoffs()}
              rows={playoffTemplateRows}
              resolveTeam={playoffTeamResolver}
              championWinner={championWinner}
            />
          )}

          {activeTab === "History" && (
            <HistoryTab
              goods={goods}
              history={history}
              firstPlayoffWeek={firstPlayoffWeek}
              timeZone={timeZone}
              isBusy={isBusy}
              onDeleteMatch={(match) => void handleDeleteMatch(match)}
              proposalHistoryGroups={proposalHistoryGroups}
              proposalHistoryIsLoading={
                Boolean(proposalHistoryKey) &&
                proposalHistory?.isLoading !== false
              }
              proposalHistoryError={proposalHistory?.error ?? null}
            />
          )}

          {confirmDialog}
        </div>
      </CrownProvider>
    </PageShell>
  );
}


