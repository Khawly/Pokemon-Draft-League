/*
 * Schedule page for a league.
 *
 * Implements spec section 10. An owner-only Setup tab saves the season's
 * schedule configuration (regular season weeks, match format, playoff field
 * and format) and generates the round-robin regular season matchups, with the
 * calculated first-round byes shown read-only. The Schedule tab offers a
 * current-week/matchup selector and a matchup card (avatars and names, game
 * record like 2-1) where participants can schedule/reschedule a match, submit
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
 * first. Standings shows rank /
 * player / W-L / KO Diff, Playoffs renders the seeded bracket (single or
 * double elimination, advanced round by round by the owner), and History lists
 * every posted game newest first. Opening the page also nudges the weekly
 * deadline sweep so a week whose deadline passed while the app server was idle
 * is settled and the playoff bracket opened before the schedule renders.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { supabase } from "@/lib/supabase/client";
import { readReplaySummary } from "@/lib/replay-summary";
import { runWeekDeadlineSweep } from "@/lib/supabase/week-deadline";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { deleteMatch } from "@/lib/supabase/teams";
import {
  forfeitMatch,
  gameRecord,
  generatePlayoffRound,
  generateSchedule,
  loadSchedulePageData,
  nextPowerOfTwo,
  submitGameResult,
  updateGameResult,
  updateMatchSchedule,
  type ScheduleMatch,
  type ScheduleMatchResult,
  type SchedulePageGoods,
} from "@/lib/supabase/schedule";

/** LocalStorage key used by the top nav to persist the selected league. */
const SELECTED_LEAGUE_STORAGE_KEY = "pokemon-draft-league:selected-league";

/** Labels enumerating the visible tabs (Setup is owner-only). */
const TABS = [
  "Schedule",
  "Standings",
  "Playoffs",
  "History",
  "Setup",
] as const;

type Tab = (typeof TABS)[number];

/**
 * Progress of the "Read replay" lookup for the report form: idle before it is
 * requested, then either the read outcome or an error to show under the field.
 */
type ReplayReadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; note: string | null; winnerResolved: boolean };

/**
 * One row in the matchup card's Games list.
 *
 * `mirrored` marks the synthetic row shown for the third game of a best-of-3
 * that was decided in two. It copies game 2 so the card reads consistently, but
 * it is only ever rendered: nothing is submitted for it, so it contributes no
 * differential of its own to the season standings.
 */
type GameRow = {
  /** The game being rendered; a mirror reuses game 2's row with a new key. */
  result: ScheduleMatchResult;
  /** Whether this row is the synthetic third game. */
  mirrored: boolean;
};

/**
 * Builds the Games rows for a match, appending a mirrored third game when a
 * best-of-3 was decided in two. The mirror reuses game 2's winner, survivor
 * count and replay link; it is display-only, so unlike a submitted game it never
 * reaches season_standings and cannot skew the season differential.
 *
 * @param match - The match to list games for.
 * @param matchFormat - The match's format, which decides whether a third game
 *   can exist at all.
 * @returns The real game rows, plus the mirror when one applies.
 */
function buildGameRows(
  match: ScheduleMatch,
  matchFormat: "single" | "best_of_3" | null,
): GameRow[] {
  const rows: GameRow[] = match.results
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
    .map((result) => ({ result, mirrored: false }));

  const hasThirdGame = rows.some((row) => row.result.game_number === 3);
  const secondGame = rows.find((row) => row.result.game_number === 2);
  if (matchFormat === "best_of_3" && rows.length === 2 && !hasThirdGame && secondGame) {
    rows.push({
      result: {
        ...secondGame.result,
        id: `${secondGame.result.id}-mirrored-game-3`,
        game_number: 3,
      },
      mirrored: true,
    });
  }

  return rows;
}

/**
 * A read-only matchup card for a completed match, used by the match history
 * panel. Mirrors the Matchup section's layout and honours the spoiler filter, but
 * carries none of its action buttons; selecting the card loads the match into the
 * Matchup section above instead.
 */
function MatchupHistoryCard({
  match,
  matchFormat,
  hideSpoilers,
  selected,
  onSelect,
}: {
  /** The completed match to render. */
  match: ScheduleMatch;
  /** The match's format, used to decide whether a mirrored third game applies. */
  matchFormat: "single" | "best_of_3" | null;
  /** Whether the spoiler filter should mask the result details. */
  hideSpoilers: boolean;
  /** Whether this is the match currently loaded in the Matchup section. */
  selected: boolean;
  /** Loads this match into the Matchup section. */
  onSelect: () => void;
}) {
  const rows = buildGameRows(match, matchFormat);
  const winnerSide = (teamId: string) =>
    !hideSpoilers && match.winner_team_id === teamId;

  const side = (teamId: string, name: string, avatarUrl: string | null) => (
    <div className="flex flex-1 flex-col items-center gap-1 text-center">
      <Avatar name={name} avatarUrl={avatarUrl} size={40} winner={winnerSide(teamId)} />
      <span className="font-semibold text-slate-100">{name}</span>
      {gameRecord(match, teamId) && (
        <Spoiler hidden={hideSpoilers}>
          <span className="text-sm text-slate-400">{gameRecord(match, teamId)}</span>
        </Spoiler>
      )}
    </div>
  );

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border p-4 text-left transition ${
        selected
          ? "border-amber-500/60 bg-slate-800/80"
          : "border-slate-800 bg-slate-950/60 hover:bg-slate-900"
      }`}
    >
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
        {match.is_playoff ? "Postseason" : `Week ${match.week_number}`}
        {match.scheduled_at ? ` • ${formatDateTime(match.scheduled_at)}` : ""}
      </p>

      <div className="flex w-full items-center justify-between gap-3">
        {side(match.player_1_team_id, match.player_1_name, match.player_1_avatar_url)}
        <div className="flex flex-col items-center gap-1">
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">
            {matchFormat === "single" ? "Single" : "Best of 3"}
          </span>
          <StatusBadge status={match.status} />
        </div>
        {side(match.player_2_team_id, match.player_2_name, match.player_2_avatar_url)}
      </div>

      {rows.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-slate-800 pt-3">
          {rows.map(({ result }) => {
            const winnerName =
              result.winner_team_id === match.player_1_team_id
                ? match.player_1_name
                : match.player_2_name;
            return (
              <div key={result.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                    Game {result.game_number}
                  </span>
                  <Spoiler hidden={hideSpoilers}>
                    <span className="font-semibold text-emerald-300">{winnerName} wins</span>
                  </Spoiler>
                  {result.pokemon_left_alive != null && (
                    <Spoiler hidden={hideSpoilers}>
                      <span className="text-slate-400">• {result.pokemon_left_alive} alive</span>
                    </Spoiler>
                  )}
                </div>
                {result.replay_url && (
                  <span
                    role="link"
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      window.open(result.replay_url ?? "", "_blank", "noreferrer");
                    }}
                    className="text-sky-400 underline decoration-sky-700 hover:text-sky-300"
                  >
                    Replay
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </button>
  );
}

/** Match status badge colors. */
const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-slate-700 text-slate-200",
  in_progress: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  forfeit: "bg-rose-500/15 text-rose-300",
  cancelled: "bg-slate-800 text-slate-500",
};

/** Renders a formatted local date/time, or an em dash when null. */
function formatDateTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Converts an ISO timestamp to a `datetime-local` input value (local time). */
function toLocalInputValue(value: string | null): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Converts a `datetime-local` input value back to an ISO timestamp. */
function fromLocalInputValue(value: string): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A player's avatar: owner image or an initial-based circle. */
function Avatar({
  name,
  avatarUrl,
  size = 36,
  winner = false,
}: {
  /** Display name used for the fallback initial. */
  name: string;
  /** Optional avatar image URL. */
  avatarUrl: string | null;
  /** Square pixel dimensions. */
  size?: number;
  /** Highlights the avatar ring when the player won. */
  winner?: boolean;
}) {
  return (
    <div
      style={{ width: size, height: size }}
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border text-sm font-bold ${
        winner
          ? "border-emerald-400 bg-emerald-500 text-slate-950"
          : "border-slate-700 bg-slate-800 text-slate-200"
      }`}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span>{name?.charAt(0)?.toUpperCase() || "?"}</span>
      )}
    </div>
  );
}

/** A small status pill for a match. */
function StatusBadge({ status }: { status: ScheduleMatch["status"] }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
        STATUS_STYLES[status] ?? "bg-slate-800 text-slate-300"
      }`}
    >
      {status}
    </span>
  );
}

/**
 * Masks a result while the spoiler filter is on.
 *
 * A solid black rectangle covers the text: the content is kept in the DOM at its
 * natural width so the card does not reflow when the filter is toggled, but the
 * text is made transparent, unselectable, and hidden from assistive tech.
 *
 * The transparent colour is forced onto descendants rather than set on this
 * element alone, because the masked values carry their own colour classes
 * (`text-emerald-300`, `text-slate-400`) and a specified colour on a child beats
 * one inherited from a parent, which would leave the text readable on black.
 */
function Spoiler({
  hidden,
  children,
}: {
  /** Whether the spoiler filter is currently masking this value. */
  hidden: boolean;
  /** The result text to mask. */
  children: React.ReactNode;
}) {
  if (!hidden) {
    return <>{children}</>;
  }

  return (
    <span className="select-none rounded-sm bg-black [&_*]:!text-transparent" aria-hidden="true">
      {children}
    </span>
  );
}

/** Wraps a schedule section in the app's card styling. */
function SectionCard({
  title,
  action,
  children,
}: {
  /** Section heading. */
  title: string;
  /** Optional right-aligned action element. */
  action?: React.ReactNode;
  /** Card body. */
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

/**
 * Wraps the schedule content in a Suspense boundary to satisfy Next.js's
 * client-side streaming requirement for `useSearchParams`.
 *
 * @returns The schedule page with a loading fallback.
 */
export default function SchedulePage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading schedule...
          </div>
        </main>
      }
    >
      <ScheduleRoute />
    </Suspense>
  );
}

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
  /** Current URL search params used to select the league. */
  searchParams: URLSearchParams | null;
}) {
  const router = useRouter();
  const [goods, setGoods] = useState<SchedulePageGoods | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("Schedule");
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);

  const [form, setForm] = useState({
    weeks: 0,
    matchFormat: "best_of_3" as "single" | "best_of_3",
    playoffTeams: 0,
    playoffMatchFormat: "best_of_3" as "single" | "best_of_3",
    playoffFormat: "single_elimination" as
      | "single_elimination"
      | "double_elimination",
  });

  const [schedulingMatchId, setSchedulingMatchId] = useState<string | null>(null);
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleNotes, setScheduleNotes] = useState("");

  const [reportingMatchId, setReportingMatchId] = useState<string | null>(null);
  const [reportGame, setReportGame] = useState("1");
  const [reportWinner, setReportWinner] = useState("");
  const [reportUrl, setReportUrl] = useState("");
  const [reportAlive, setReportAlive] = useState("");
  const [replayRead, setReplayRead] = useState<ReplayReadState>({ status: "idle" });

  // Spoiler filter: on by default so the matchup card never reveals a result
  // until the viewer asks to see it.
  const [hideSpoilers, setHideSpoilers] = useState(true);

  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [editWinner, setEditWinner] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editAlive, setEditAlive] = useState("");

  const requestedLeagueId = searchParams?.get("leagueId") ?? null;

  const refresh = useCallback(async (leagueId: string) => {
    const next = await loadSchedulePageData(leagueId);
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
    // Default the matchup selector to a current-week match (the user's match,
    // if involved), falling back to the first match of the season.
    const regular = next.matches.filter((match) => !match.is_playoff);
    const weeks = [...new Set(regular.map((match) => match.week_number))].sort(
      (a, b) => a - b,
    );
    let week: number | null = null;
    for (const candidate of weeks) {
      const open = regular.some(
        (match) =>
          match.week_number === candidate &&
          match.status !== "completed" &&
          match.status !== "forfeit" &&
          match.status !== "cancelled",
      );
      if (open) {
        week = candidate;
        break;
      }
    }
    const pool = week != null ? regular.filter((match) => match.week_number === week) : next.matches;
    const mine = pool.find(
      (match) =>
        match.player_1_team_id === next.myTeamId ||
        match.player_2_team_id === next.myTeamId,
    );
    setSelectedMatchId((mine ?? pool[0])?.id ?? null);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadLeague() {
      try {
        setIsLoading(true);
        setError(null);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.replace("/");
          return;
        }

        let selectedLeagueId = requestedLeagueId;

        if (!selectedLeagueId) {
          try {
            selectedLeagueId =
              window.localStorage.getItem(SELECTED_LEAGUE_STORAGE_KEY) ?? null;
          } catch {
            selectedLeagueId = null;
          }
        }

        if (!selectedLeagueId) {
          const { data: memberships, error: membershipsError } = await supabase
            .from("league_members")
            .select("league_id")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("joined_at", { ascending: false })
            .limit(1);

          if (membershipsError || !memberships?.length) {
            setError("You are not a member of any active league.");
            return;
          }

          selectedLeagueId = memberships[0].league_id;
        }

        if (!selectedLeagueId) {
          setError("Select a league before opening the schedule.");
          return;
        }

        // Nudge the weekly deadline sweep so a week that closed while the app
        // server was idle is settled before the schedule renders.
        try {
          await runWeekDeadlineSweep();
        } catch {
          // Best effort: the server heartbeat retries it.
        }

        const next = await refresh(selectedLeagueId);
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
  }, [router, requestedLeagueId, refresh]);

  const regularMatches = useMemo(
    () => (goods ? goods.matches.filter((match) => !match.is_playoff) : []),
    [goods],
  );

  const currentWeek = useMemo(() => {
    const weeks = [...new Set(regularMatches.map((match) => match.week_number))];
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
  }, [regularMatches]);

  const selectedMatch = useMemo(
    () => goods?.matches.find((match) => match.id === selectedMatchId) ?? null,
    [goods, selectedMatchId],
  );

  const myMatch = useMemo(
    () =>
      goods && selectedMatch
        ? selectedMatch.player_1_team_id === goods.myTeamId ||
          selectedMatch.player_2_team_id === goods.myTeamId
        : false,
    [goods, selectedMatch],
  );

  const canAct = useMemo(
    () =>
      Boolean(
        goods &&
          selectedMatch &&
          myMatch &&
          selectedMatch.status !== "completed" &&
          selectedMatch.status !== "forfeit" &&
          selectedMatch.status !== "cancelled",
      ),
    [goods, selectedMatch, myMatch],
  );

  /*
   * The signed contribution this game will make to the signed-in user's
   * differential, mirroring season_standings: the winning team adds the
   * survivor count and the losing team subtracts it. Shown read-only so the
   * sign is visible without anyone typing a negative count by hand.
   */
  const reportDifferential = useMemo(() => {
    if (!selectedMatch || !reportWinner || !reportAlive.trim()) {
      return null;
    }
    // Only meaningful for a participant; owners viewing a match are neither side.
    if (
      goods?.myTeamId !== selectedMatch.player_1_team_id &&
      goods?.myTeamId !== selectedMatch.player_2_team_id
    ) {
      return null;
    }
    const count = Number(reportAlive);
    if (!Number.isInteger(count) || count < 0 || count > 6) {
      return null;
    }
    return reportWinner === goods.myTeamId ? count : -count;
  }, [selectedMatch, reportWinner, reportAlive, goods]);

  // Per-player game records for the matchup card, e.g. "2-1". Both are spoilers.
  const playerOneRecord = selectedMatch
    ? gameRecord(selectedMatch, selectedMatch.player_1_team_id)
    : null;
  const playerTwoRecord = selectedMatch
    ? gameRecord(selectedMatch, selectedMatch.player_2_team_id)
    : null;

  const matchFormat = useMemo(() => {
    if (!goods?.settings || !selectedMatch) {
      return null;
    }
    return selectedMatch.is_playoff
      ? goods.settings.playoff_match_format
      : goods.settings.match_format;
  }, [goods, selectedMatch]);

  /*
   * Games to list for the card: the real results, plus a mirrored third game
   * when a best-of-3 was decided in two. Shared with the match history panel so
   * both render a sweep the same way.
   */
  const gameRows = useMemo<GameRow[]>(
    () => (selectedMatch ? buildGameRows(selectedMatch, matchFormat) : []),
    [selectedMatch, matchFormat],
  );

  /** Format for any match, which differs for playoff rounds. */
  const formatFor = useCallback(
    (match: ScheduleMatch) =>
      match.is_playoff
        ? (goods?.settings?.playoff_match_format ?? null)
        : (goods?.settings?.match_format ?? null),
    [goods?.settings],
  );

  /** Completed matches, newest week last, for the match history panel. */
  const completedMatches = useMemo(
    () =>
      (goods?.matches ?? []).filter(
        (match) =>
          match.status === "completed" || match.status === "forfeit",
      ),
    [goods?.matches],
  );

  const upcomingMatches = useMemo(() => {
    if (!goods) {
      return [];
    }
    const open = goods.matches.filter(
      (match) =>
        match.status !== "completed" &&
        match.status !== "forfeit" &&
        match.status !== "cancelled",
    );
    return [...open].sort((a, b) => {
      const aMine =
        a.player_1_team_id === goods.myTeamId ||
        a.player_2_team_id === goods.myTeamId;
      const bMine =
        b.player_1_team_id === goods.myTeamId ||
        b.player_2_team_id === goods.myTeamId;
      if (aMine !== bMine) {
        return aMine ? -1 : 1;
      }
      const aTime = a.scheduled_at ? new Date(a.scheduled_at).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.scheduled_at ? new Date(b.scheduled_at).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  }, [goods]);

  const playoffColumns = useMemo(() => {
    if (!goods) {
      return [];
    }
    const playoff = goods.matches.filter((match) => match.is_playoff);
    const byPhase = (phase: "upper" | "lower" | "gf") =>
      playoff
        .filter((match) => match.bracket_phase === phase)
        .sort((a, b) => a.week_number - b.week_number);
    return [
      ...byPhase("upper"),
      ...byPhase("lower"),
      ...byPhase("gf"),
    ];
  }, [goods]);

  const champion = useMemo(() => {
    if (!goods) {
      return null;
    }
    const grandFinal = goods.matches.find(
      (match) => match.bracket_phase === "gf" && match.status === "completed",
    );
    if (grandFinal?.winner_team_id) {
      return grandFinal;
    }
    const singleFinal = goods.matches.find(
      (match) =>
        !grandFinal &&
        match.is_playoff &&
        match.bracket_phase === "upper" &&
        match.status === "completed",
    );
    return singleFinal ?? null;
  }, [goods]);

  const history = useMemo(() => {
    if (!goods) {
      return [];
    }
    const games: (ScheduleMatchResult & { match: ScheduleMatch })[] = [];
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

  const byes =
    form.playoffTeams >= 2
      ? nextPowerOfTwo(form.playoffTeams) - form.playoffTeams
      : 0;

  const canRunMutation = async (mutation: () => Promise<unknown>, leagueId: string) => {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      await mutation();
      await refresh(leagueId);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "That action could not be completed.",
      );
    } finally {
      setIsBusy(false);
    }
  };

  async function handleGenerateSchedule() {
    if (!goods) {
      return;
    }
    const matchCount = form.weeks;
    const message =
      matchCount > 0
        ? `Replace the season schedule with ${matchCount} week${
            matchCount === 1 ? "" : "s"
          } of round-robin matchups? Existing matches and results will be removed.`
        : "This will replace the season schedule. Continue?";
    if (!window.confirm(message)) {
      return;
    }
    await canRunMutation(
      () =>
        generateSchedule(goods.league.id, {
          regular_season_weeks: form.weeks,
          match_format: form.matchFormat,
          playoff_team_count: form.playoffTeams,
          playoff_match_format: form.playoffMatchFormat,
          playoff_format: form.playoffFormat,
        }),
      goods.league.id,
    );
    setNotice("Schedule generated.");
  }

  async function handleAdvancePlayoffs() {
    if (!goods) {
      return;
    }
    await canRunMutation(
      () => generatePlayoffRound(goods.league.id),
      goods.league.id,
    );
    setNotice("Playoff bracket advanced.");
  }

  function openScheduling() {
    if (!selectedMatch) {
      return;
    }
    setSchedulingMatchId(selectedMatch.id);
    setScheduleTime(toLocalInputValue(selectedMatch.scheduled_at));
    setScheduleNotes(selectedMatch.notes ?? "");
  }

  async function handleSaveSchedule() {
    if (!goods || !selectedMatch) {
      return;
    }
    await canRunMutation(
      () =>
        updateMatchSchedule(
          selectedMatch.id,
          fromLocalInputValue(scheduleTime),
          scheduleNotes,
        ),
      goods.league.id,
    );
    setSchedulingMatchId(null);
    setNotice("Match schedule updated.");
  }

  function openReporting() {
    if (!selectedMatch || !matchFormat) {
      return;
    }
    setReportingMatchId(selectedMatch.id);
    const taken = new Set(selectedMatch.results.map((result) => result.game_number));
    let firstMissing = 1;
    while (taken.has(firstMissing) && firstMissing <= 3) {
      firstMissing += 1;
    }
    setReportGame(String(firstMissing));
    setReportWinner("");
    setReportUrl("");
    setReportAlive("");
    setReplayRead({ status: "idle" });
  }

  /**
   * Reads the pasted replay link and fills in the winner and survivor count.
   *
   * The count is written unsigned and the winner carries the sign, matching what
   * `season_standings` expects; a negative value here would flip both teams'
   * differentials.
   */
  async function handleReadReplay() {
    if (!selectedMatch || !reportUrl.trim()) {
      return;
    }
    setReplayRead({ status: "loading" });
    try {
      const summary = await readReplaySummary(reportUrl.trim(), selectedMatch.id);
      if (summary.winnerTeamId) {
        setReportWinner(summary.winnerTeamId);
      }
      if (summary.pokemonLeftAlive != null) {
        setReportAlive(String(summary.pokemonLeftAlive));
      }
      setReplayRead({
        status: "done",
        note: summary.note,
        winnerResolved: Boolean(summary.winnerTeamId),
      });
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "That replay could not be read.",
      );
      setReplayRead({ status: "idle" });
    }
  }

  async function handleSubmitResult() {
    if (!goods || !selectedMatch || !reportWinner) {
      return;
    }
    const alive = reportAlive.trim() ? Number(reportAlive) : null;
    await canRunMutation(
      () =>
        submitGameResult(
          selectedMatch.id,
          Number(reportGame),
          reportWinner,
          reportUrl.trim(),
          alive,
        ),
      goods.league.id,
    );
    setReportingMatchId(null);
    setNotice("Result submitted.");
  }

  function openEditResult(result: ScheduleMatchResult) {
    setEditingResultId(result.id);
    setEditWinner(result.winner_team_id);
    setEditUrl(result.replay_url ?? "");
    setEditAlive(
      result.pokemon_left_alive != null ? String(result.pokemon_left_alive) : "",
    );
  }

  async function handleSaveEditResult(result: ScheduleMatchResult) {
    if (!goods || !selectedMatch) {
      return;
    }
    const alive = editAlive.trim() ? Number(editAlive) : null;
    await canRunMutation(
      () => updateGameResult(result.id, editWinner, editUrl.trim(), alive),
      goods.league.id,
    );
    setEditingResultId(null);
    setNotice("Result updated.");
  }

  async function handleForfeit() {
    if (!goods || !selectedMatch) {
      return;
    }
    const opponent =
      selectedMatch.player_1_team_id === goods.myTeamId
        ? selectedMatch.player_2_name
        : selectedMatch.player_1_name;
    if (
      !window.confirm(`Forfeit this match to ${opponent}? This cannot be undone.`)
    ) {
      return;
    }
    await canRunMutation(() => forfeitMatch(selectedMatch.id), goods.league.id);
    setNotice("Match forfeited.");
  }

  async function handleDeleteMatch(match: ScheduleMatch) {
    if (!goods) {
      return;
    }
    if (
      !window.confirm(
        `Delete the ${match.player_1_name} vs ${match.player_2_name} match and its results? This cannot be undone.`,
      )
    ) {
      return;
    }
    await canRunMutation(() => deleteMatch(match.id), goods.league.id);
    setNotice("Match deleted.");
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading schedule...
        </div>
      </main>
    );
  }

  if (!goods) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          {error ?? "The schedule could not be loaded."}
        </div>
      </main>
    );
  }

  const tabs = goods.isOwner ? TABS : TABS.filter((tab) => tab !== "Setup");
  const generateDisabled = isBusy || !Number.isInteger(form.weeks) || form.weeks < 1;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">{goods.league.name}</h1>
              <p className="mt-1 text-sm text-slate-400">
                Schedule • {formatSeasonLabel(goods.season)}
                {currentWeek != null ? ` • Current week ${currentWeek}` : " • Postseason"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
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

        {activeTab === "Setup" && goods.isOwner && (
          <SectionCard
            title="Schedule setup"
            action={
              <button
                type="button"
                disabled={generateDisabled}
                onClick={handleGenerateSchedule}
                className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Generate schedule
              </button>
            }
          >
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              <Field label="Regular season weeks">
                <input
                  type="number"
                  min={1}
                  max={52}
                  value={form.weeks}
                  onChange={(event) =>
                    setForm({ ...form, weeks: Number(event.target.value) })
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                />
              </Field>
              <Field label="Match format">
                <select
                  value={form.matchFormat}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      matchFormat: event.target.value as "single" | "best_of_3",
                    })
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                >
                  <option value="single">Single Game</option>
                  <option value="best_of_3">Best of 3</option>
                </select>
              </Field>
              <Field label="Playoff teams">
                <input
                  type="number"
                  min={0}
                  max={16}
                  value={form.playoffTeams}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      playoffTeams: Number(event.target.value),
                    })
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                />
              </Field>
              <Field label="Playoff match format">
                <select
                  value={form.playoffMatchFormat}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      playoffMatchFormat: event.target.value as
                        | "single"
                        | "best_of_3",
                    })
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                >
                  <option value="single">Single Game</option>
                  <option value="best_of_3">Best of 3</option>
                </select>
              </Field>
              <Field label="Playoff format">
                <select
                  value={form.playoffFormat}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      playoffFormat: event.target.value as
                        | "single_elimination"
                        | "double_elimination",
                    })
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                >
                  <option value="single_elimination">Single Elimination</option>
                  <option value="double_elimination">Double Elimination</option>
                </select>
              </Field>
              <Field label="First-round byes (calculated)">
                <div className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300">
                  {form.playoffTeams >= 2 && form.playoffTeams <= 16
                    ? byes
                    : "—"}
                </div>
              </Field>
            </div>
            <p className="mt-4 text-sm text-slate-400">
              Generate button is enabled once regular season weeks is a valid
              integer of at least 1. Generating replaces the current season&apos;s
              schedule. The playoff bracket is advanced from the Playoffs tab
              once the draft is complete.
            </p>
          </SectionCard>
        )}

        {activeTab === "Schedule" && (
          <>
            <SectionCard
              title="Matchup"
              action={
                <div className="flex flex-wrap items-center gap-3">
                  <label
                    className="flex items-center gap-2 text-sm text-slate-400"
                    title="Hide the match winner, the per-game winners, and each game's KO differential"
                  >
                    <input
                      type="checkbox"
                      checked={hideSpoilers}
                      onChange={(event) => setHideSpoilers(event.target.checked)}
                      className="size-4 accent-amber-500"
                    />
                    <span>Filter</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-400">
                    <span className="hidden sm:inline">Week / matchup</span>
                    <select
                      value={selectedMatchId ?? ""}
                      onChange={(event) => {
                        setSelectedMatchId(event.target.value || null);
                        setSchedulingMatchId(null);
                        setReportingMatchId(null);
                        setEditingResultId(null);
                      }}
                      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                    >
                      {!selectedMatch && <option value="">Select a match</option>}
                      {goods.matches.map((match) => (
                        <option key={match.id} value={match.id}>
                          {match.is_playoff
                            ? "Postseason"
                            : `Week ${match.week_number}`}{" "}
                          • {match.player_1_name} vs {match.player_2_name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              }
            >
              {!selectedMatch ? (
                <p className="text-sm text-slate-400">
                  No matches have been generated yet.
                </p>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-col items-center gap-4 rounded-xl border border-slate-800 bg-slate-950/60 p-5">
                    <div className="flex w-full items-center justify-between gap-3">
                      <div className="flex flex-1 flex-col items-center gap-1 text-center">
                        <Avatar
                          name={selectedMatch.player_1_name}
                          avatarUrl={selectedMatch.player_1_avatar_url}
                          size={44}
                          winner={
                            !hideSpoilers &&
                            selectedMatch.winner_team_id ===
                              selectedMatch.player_1_team_id
                          }
                        />
                        <span className="font-semibold text-slate-100">
                          {selectedMatch.player_1_name}
                        </span>
                        {playerOneRecord && (
                          <Spoiler hidden={hideSpoilers}>
                            <span className="text-sm text-slate-400">
                              {playerOneRecord}
                            </span>
                          </Spoiler>
                        )}
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">
                          {matchFormat === "single" ? "Single" : "Best of 3"}
                        </span>
                        <StatusBadge status={selectedMatch.status} />
                      </div>
                      <div className="flex flex-1 flex-col items-center gap-1 text-center">
                        <Avatar
                          name={selectedMatch.player_2_name}
                          avatarUrl={selectedMatch.player_2_avatar_url}
                          size={44}
                          winner={
                            !hideSpoilers &&
                            selectedMatch.winner_team_id ===
                              selectedMatch.player_2_team_id
                          }
                        />
                        <span className="font-semibold text-slate-100">
                          {selectedMatch.player_2_name}
                        </span>
                        {playerTwoRecord && (
                          <Spoiler hidden={hideSpoilers}>
                            <span className="text-sm text-slate-400">
                              {playerTwoRecord}
                            </span>
                          </Spoiler>
                        )}
                      </div>
                    </div>

                    <p className="text-sm text-slate-300">
                      {formatDateTime(selectedMatch.scheduled_at)}
                    </p>
                    {selectedMatch.notes && (
                      <p className="text-sm italic text-slate-400">
                        “{selectedMatch.notes}”
                      </p>
                    )}

                    {canAct && (
                      <div className="flex flex-wrap justify-center gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={openScheduling}
                          className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                        >
                          {selectedMatch.scheduled_at ? "Reschedule" : "Schedule"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={openReporting}
                          className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
                        >
                          Add Replay
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={handleForfeit}
                          className="rounded-xl border border-rose-800 bg-rose-950/50 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
                        >
                          Forfeit
                        </button>
                      </div>
                    )}
                  </div>

                  {schedulingMatchId === selectedMatch.id && (
                    <div className="grid gap-4 rounded-xl border border-slate-700 bg-slate-950/60 p-4 md:grid-cols-2">
                      <Field label="Date / time">
                        <input
                          type="datetime-local"
                          value={scheduleTime}
                          onChange={(event) => setScheduleTime(event.target.value)}
                          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                        />
                      </Field>
                      <Field label="Notes">
                        <input
                          type="text"
                          value={scheduleNotes}
                          placeholder="Replay room notes, etc."
                          onChange={(event) => setScheduleNotes(event.target.value)}
                          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                        />
                      </Field>
                      <div className="flex gap-2 md:col-span-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={handleSaveSchedule}
                          className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setSchedulingMatchId(null)}
                          className="rounded-xl border border-slate-700 px-3.5 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {reportingMatchId === selectedMatch.id && (
                    <div className="grid gap-4 rounded-xl border border-slate-700 bg-slate-950/60 p-4 md:grid-cols-2">
                      <Field label="Game">
                        <select
                          value={reportGame}
                          onChange={(event) => setReportGame(event.target.value)}
                          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                        >
                          {[1, 2, 3]
                            .slice(0, matchFormat === "single" ? 1 : 3)
                            .filter(
                              (game) =>
                                !selectedMatch.results.some(
                                  (result) => result.game_number === game,
                                ),
                            )
                            .map((game) => (
                              <option key={game} value={game}>
                                Game {game}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label="Winner">
                        <select
                          value={reportWinner}
                          onChange={(event) => setReportWinner(event.target.value)}
                          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                        >
                          <option value="">Select the winner</option>
                          <option value={selectedMatch.player_1_team_id}>
                            {selectedMatch.player_1_name}
                          </option>
                          <option value={selectedMatch.player_2_team_id}>
                            {selectedMatch.player_2_name}
                          </option>
                        </select>
                      </Field>
                      <Field
                        label="Replay link (optional)"
                        hint={
                          replayRead.status === "loading"
                            ? "Reading the battle log..."
                            : null
                        }
                      >
                        <input
                          type="url"
                          value={reportUrl}
                          placeholder="https://replay.pokemonshowdown.com/..."
                          onChange={(event) => {
                            setReportUrl(event.target.value);
                            setReplayRead({ status: "idle" });
                          }}
                          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                        />
                      </Field>
                      <Field
                        label="Winner&apos;s surviving Pokemon (optional)"
                        hint={
                          reportDifferential == null
                            ? null
                            : `Your KO differential for this game: ${reportDifferential > 0 ? "+" : ""}${reportDifferential}`
                        }
                      >
                        <input
                          type="number"
                          min={0}
                          max={6}
                          value={reportAlive}
                          onChange={(event) =>
                            setReportAlive(event.target.value.replace(/[^0-9]/g, ""))
                          }
                          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
                        <button
                          type="button"
                          onClick={handleReadReplay}
                          disabled={
                            isBusy ||
                            !reportUrl.trim() ||
                            replayRead.status === "loading"
                          }
                          className="rounded-xl border border-amber-500/60 px-3.5 py-2 text-sm font-semibold text-amber-300 transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Read replay
                        </button>
                        {replayRead.status === "done" &&
                        (replayRead.note ? (
                          <span className="text-xs text-amber-300">
                            {replayRead.note}
                          </span>
                        ) : replayRead.winnerResolved ? (
                          <span className="text-xs text-emerald-300">
                            Filled in the winner and surviving Pokemon from the
                            replay. Check them before submitting.
                          </span>
                        ) : (
                          <span className="text-xs text-amber-300">
                            Winner could not be matched to a team. Set it
                            manually.
                          </span>
                        ))}
                      </div>
                      <div className="flex gap-2 md:col-span-2">
                        <button
                          type="button"
                          disabled={isBusy || !reportWinner}
                          onClick={handleSubmitResult}
                          className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Submit result
                        </button>
                        <button
                          type="button"
                          onClick={() => setReportingMatchId(null)}
                          className="rounded-xl border border-slate-700 px-3.5 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {gameRows.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                        Games
                      </h3>
                      <div className="space-y-2">
                        {gameRows.map(({ result, mirrored }) => {
                            const winnerName =
                              result.winner_team_id ===
                              selectedMatch.player_1_team_id
                                ? selectedMatch.player_1_name
                                : selectedMatch.player_2_name;
                            if (editingResultId === result.id) {
                              return (
                                <div
                                  key={result.id}
                                  className="grid gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4 md:grid-cols-3"
                                >
                                  <Field label="Winner">
                                    <select
                                      value={editWinner}
                                      onChange={(event) =>
                                        setEditWinner(event.target.value)
                                      }
                                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                                    >
                                      <option value={selectedMatch.player_1_team_id}>
                                        {selectedMatch.player_1_name}
                                      </option>
                                      <option value={selectedMatch.player_2_team_id}>
                                        {selectedMatch.player_2_name}
                                      </option>
                                    </select>
                                  </Field>
                                  <Field label="Replay link">
                                    <input
                                      type="url"
                                      value={editUrl}
                                      onChange={(event) =>
                                        setEditUrl(event.target.value)
                                      }
                                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                                    />
                                  </Field>
                                  <Field label="Surviving Pokemon">
                                    <input
                                      type="number"
                                      min={0}
                                      max={6}
                                      value={editAlive}
                                      onChange={(event) =>
                                        setEditAlive(
                                          event.target.value.replace(/[^0-9]/g, ""),
                                        )
                                      }
                                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                                    />
                                  </Field>
                                  <div className="flex gap-2 md:col-span-3">
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      onClick={() => handleSaveEditResult(result)}
                                      className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                                    >
                                      Save edit
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingResultId(null)}
                                      className="rounded-xl border border-slate-700 px-3.5 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div
                                key={result.id}
                                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                                    Game {result.game_number}
                                  </span>
                                  <Spoiler hidden={hideSpoilers}>
                                    <span className="font-semibold text-emerald-300">
                                      {winnerName} wins
                                    </span>
                                  </Spoiler>
                                  {result.pokemon_left_alive != null && (
                                    <Spoiler hidden={hideSpoilers}>
                                      <span className="text-slate-400">
                                        • {result.pokemon_left_alive} alive
                                      </span>
                                    </Spoiler>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  {result.replay_url && (
                                    <a
                                      href={result.replay_url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-sky-400 underline decoration-sky-700 hover:text-sky-300"
                                    >
                                      Replay
                                    </a>
                                  )}
                                  {/* A mirrored game has no stored result to correct. */}
                                  {goods.isStaff && !mirrored && (
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      onClick={() => openEditResult(result)}
                                      className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
                                    >
                                      Edit
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </SectionCard>

            <SectionCard title="Upcoming matches">
              {upcomingMatches.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No upcoming matches in the regular season.
                </p>
              ) : (
                <div className="space-y-2">
                  {upcomingMatches.map((match) => (
                    <button
                      key={match.id}
                      type="button"
                      onClick={() => setSelectedMatchId(match.id)}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition ${
                        selectedMatchId === match.id
                          ? "border-amber-500/60 bg-slate-800/80"
                          : "border-slate-700 bg-slate-800/50 hover:bg-slate-800"
                      }`}
                    >
                      <div>
                        <p className="font-semibold text-slate-100">
                          {match.is_playoff ? "Postseason" : `Week ${match.week_number}`} •{" "}
                          {match.player_1_name} vs {match.player_2_name}
                        </p>
                        <p className="mt-0.5 text-sm text-slate-400">
                          {formatDateTime(match.scheduled_at)}
                        </p>
                      </div>
                      <StatusBadge status={match.status} />
                    </button>
                  ))}
                </div>
              )}
            </SectionCard>

            <SectionCard title="Match history">
              {completedMatches.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No completed matchups yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {completedMatches.map((match) => (
                    <MatchupHistoryCard
                      key={match.id}
                      match={match}
                      matchFormat={formatFor(match)}
                      hideSpoilers={hideSpoilers}
                      selected={selectedMatchId === match.id}
                      onSelect={() => {
                        setSelectedMatchId(match.id);
                        setSchedulingMatchId(null);
                        setReportingMatchId(null);
                        setEditingResultId(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </SectionCard>
          </>
        )}

        {activeTab === "Standings" && (
          <SectionCard title="Standings">
            <div className="overflow-hidden rounded-xl border border-slate-800">
              <table className="min-w-full divide-y divide-slate-800 text-sm">
                <thead className="bg-slate-950 text-slate-300">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Rank</th>
                    <th className="px-4 py-3 text-left font-semibold">Player</th>
                    <th className="px-4 py-3 text-center font-semibold">W</th>
                    <th className="px-4 py-3 text-center font-semibold">L</th>
                    <th className="px-4 py-3 text-center font-semibold">KO Diff</th>
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
                          <Avatar
                            name={row.team_name}
                            avatarUrl={
                              goods.teams.find(
                                (team) => team.id === row.team_id,
                              )?.owner_avatar_url ?? null
                            }
                            size={28}
                          />
                          <span className="font-medium text-slate-100">
                            {row.team_name}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center text-slate-300">
                        {row.wins}
                      </td>
                      <td className="px-4 py-3 text-center text-slate-300">
                        {row.losses}
                      </td>
                      <td className="px-4 py-3 text-center font-medium text-slate-100">
                        {row.ko_diff}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        )}

        {activeTab === "Playoffs" && (
          <SectionCard
            title="Playoff bracket"
            action={
              goods.isOwner && goods.season?.status === "draft_complete" ? (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={handleAdvancePlayoffs}
                  className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                >
                  Advance playoffs
                </button>
              ) : undefined
            }
          >
            {goods.settings && (
              <p className="mb-4 text-sm text-slate-400">
                {goods.settings.playoff_team_count} teams •{" "}
                {goods.settings.playoff_format === "single_elimination"
                  ? "Single elimination"
                  : "Double elimination"}{" "}
                •{" "}
                {goods.settings.playoff_match_format === "single"
                  ? "Single games"
                  : "Best of 3"}
              </p>
            )}
            {playoffColumns.length === 0 ? (
              <p className="text-sm text-slate-400">
                {goods.season?.status === "draft_complete"
                  ? "The bracket is empty. Use “Advance playoffs” once the regular season is complete — the top seeded teams enter the postseason."
                  : "The playoff bracket appears after the draft is complete."}
              </p>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-2">
                {Array.from(
                  new Set(playoffColumns.map((match) => match.week_number)),
                ).map((week) => (
                  <div
                    key={week}
                    className="flex min-w-[180px] shrink-0 flex-col gap-3"
                  >
                    <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                      {(() => {
                        const sample =
                          playoffColumns.find(
                            (match) => match.week_number === week,
                          ) ?? null;
                        if (!sample) return "";
                        if (sample.bracket_phase === "gf") return "Grand final";
                        if (sample.bracket_phase === "lower") {
                          const lowerWeekIndex =
                            week - (goods.settings?.regular_season_weeks ?? 0);
                          return `Lower ${lowerWeekIndex}`;
                        }
                        const upperWeekIndex =
                          week - (goods.settings?.regular_season_weeks ?? 0);
                        return upperWeekIndex === 1
                          ? "First round"
                          : `Round ${upperWeekIndex}`;
                      })()}
                    </p>
                    {playoffColumns
                      .filter((match) => match.week_number === week)
                      .map((match) => (
                        <div
                          key={match.id}
                          className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3"
                        >
                          {[match.player_1_team_id, match.player_2_team_id].map(
                            (teamId) => {
                              const won = match.winner_team_id === teamId;
                              const name =
                                teamId === match.player_1_team_id
                                  ? match.player_1_name
                                  : match.player_2_name;
                              return (
                                <div
                                  key={teamId}
                                  className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm ${
                                    won
                                      ? "bg-emerald-900/40 text-emerald-200"
                                      : "text-slate-300"
                                  }`}
                                >
                                  <span className="font-medium">{name}</span>
                                  {won && <span className="text-emerald-400">▲</span>}
                                </div>
                              );
                            },
                          )}
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <StatusBadge status={match.status} />
                            {match.results.length > 0 && (
                              <span className="text-xs text-slate-400">
                                {match.results.length} game
                                {match.results.length === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            )}
            {champion && (
              <p className="mt-4 rounded-xl border border-emerald-800 bg-emerald-900/30 p-3 text-sm text-emerald-200">
                Champion:{" "}
                <strong>
                  {champion.winner_team_id === champion.player_1_team_id
                    ? champion.player_1_name
                    : champion.player_2_name}
                </strong>{" "}
                {champion.winner_team_id && <span className="text-emerald-400">— League champion</span>}
              </p>
            )}
          </SectionCard>
        )}

        {activeTab === "History" && (
          <SectionCard title="Match history">
            {history.length === 0 ? (
              <p className="text-sm text-slate-400">No games have been posted yet.</p>
            ) : (
              <div className="space-y-2">
                {history.map(({ match, id, winner_team_id, game_number, replay_url, submitted_at }) => (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm"
                  >
                    <div>
                      <p className="font-semibold text-slate-100">
                        {match.player_1_name} vs {match.player_2_name}
                        <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                          {match.is_playoff ? "Postseason" : `Week ${match.week_number}`}{" "}
                          • Game {game_number}
                        </span>
                      </p>
                      <p className="mt-0.5 text-slate-400">
                        <span className="text-emerald-300">
                          {winner_team_id === match.player_1_team_id
                            ? match.player_1_name
                            : match.player_2_name}
                        </span>{" "}
                        won • {formatDateTime(submitted_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {replay_url && (
                        <a
                          href={replay_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-400 underline decoration-sky-700 hover:text-sky-300"
                        >
                          Replay
                        </a>
                      )}
                      {goods.isStaff && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDeleteMatch(match)}
                          className="rounded-lg border border-rose-800 px-2.5 py-1 text-xs text-rose-300 transition hover:bg-rose-900/40"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        )}
      </div>
    </main>
  );
}

/** A labeled form field wrapper used across the schedule page forms. */
function Field({
  label,
  hint,
  children,
}: {
  /** Field label text. */
  label: string;
  /** Optional helper or validation text shown under the control. */
  hint?: React.ReactNode;
  /** The form control. */
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
    </label>
  );
}