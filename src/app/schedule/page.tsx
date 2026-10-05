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
 * first. Standings shows rank /
 * player / W-L / KO Diff, Playoffs renders the seeded bracket (single or
 * double elimination, advanced round by round by the owner), and History lists
 * every posted game newest first. All match times are shown in the time zone the
 * member picked in user settings, and the header states the league's next weekly
 * deadline in that same zone. Opening the scheduling form for a matchup also
 * surfaces the opponent's declared availability, projected into the reader's
 * zone, and flags a proposed time that falls outside it. Match-time events
 * (proposed, accepted, declined, withdrawn) are reported on the dashboard's
 * Schedule nav button as an unread-count badge rather than as a panel here, and
 * are cleared by opening the schedule.
 * Opening the page also nudges the weekly deadline sweep so a week whose
 * deadline passed while the app server was idle is settled and the playoff
 * bracket opened before the schedule renders.
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { supabase } from "@/lib/supabase/client";
import { readReplaySummary } from "@/lib/replay-summary";
import { useConfirm } from "@/components/confirm-dialog";
import {
  loadWeekProgressState,
  runWeekDeadlineSweep,
  type WeekProgressState,
} from "@/lib/supabase/week-deadline";
import { formatSeasonLabel } from "@/lib/supabase/seasons";
import { deleteMatch } from "@/lib/supabase/teams";
import { useUserTimeZone } from "@/lib/user-timezone";
import { useRealtimeInvalidation } from "@/lib/use-realtime-invalidation";
import {
  datePartOfInputValue,
  formatDateTimeInZone,
  formatInTimeZone,
  formatTimeZoneLabel,
  fromZonedInputValue,
  timePartOfInputValue,
  toZonedInputValue,
  toZonedParts,
  todayInZone,
  withInputValueDate,
  withInputValueTime,
} from "@/lib/datetime";
import {
  availabilityFit,
  dayOfWeekFromDate,
  formatAvailabilityWindow,
  loadMemberAvailability,
  minutesFromInputValue,
  projectAvailabilityWeek,
  windowsForWeekday,
  WEEKDAY_LABELS,
  type AvailabilityWindow,
  type MemberAvailability,
} from "@/lib/supabase/availability";
import {
  cancelMatchProposal,
  forfeitMatch,
  gameRecord,
  generatePlayoffRound,
  generateSchedule,
  groupProposalHistoryByWeek,
  loadProposalHistory,
  loadSchedulePageData,
  nextPowerOfTwo,
  proposeMatchTime,
  proposalOutcomeLabel,
  proposalOutcomeTone,
  proposalWeekLabel,
  respondToMatchProposal,
  seasonPhaseLabel,
  submitGameResult,
  updateGameResult,
  type ProposalHistoryEntry,
  type ProposalHistoryGroup,
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
  timeZone,
  hideSpoilers,
  selected,
  onSelect,
}: {
  /** The completed match to render. */
  match: ScheduleMatch;
  /** The match's format, used to decide whether a mirrored third game applies. */
  matchFormat: "single" | "best_of_3" | null;
  /** The reader's display time zone, so every time reads the same everywhere on the page. */
  timeZone: string;
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
        {match.scheduled_at
          ? ` • ${formatDateTimeInZone(match.scheduled_at, timeZone)}`
          : ""}
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
  unscheduled: "bg-slate-800 text-slate-400",
  scheduled: "bg-sky-500/15 text-sky-300",
  in_progress: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  forfeit: "bg-rose-500/15 text-rose-300",
  cancelled: "bg-slate-800 text-slate-500",
};

/** Human-readable label for each match status. */
const STATUS_LABELS: Record<string, string> = {
  unscheduled: "Unscheduled",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  forfeit: "Forfeit",
  cancelled: "Cancelled",
};

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
      {STATUS_LABELS[status] ?? status}
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
 * Timestamp shape for the owner proposal log.
 *
 * Wider than the page default because the log stacks an offered time, a proposed
 * time, and an answered time in adjacent rows, and the bare `7 Oct 2026, 8:00 PM`
 * the pages use elsewhere makes those hard to tell apart at a glance. The weekday
 * anchors each to a day of the week, which is also how availability is described.
 *
 * `timeZoneName: "short"` is what puts `EDT` or `GMT+1` on the end of every value.
 * These timestamps were written by whichever player proposed them, and an owner
 * reading a converted 5:00 PM has no other way to know which 5:00 PM it is. Intl
 * gives the region abbreviation where one exists and falls back to a GMT offset
 * where one does not, which is the same vocabulary `formatTimeZoneLabel` uses
 * without having to maintain a second table.
 *
 * The clock is left to the reader's locale rather than pinned to 24-hour, so the
 * log reads the way every other timestamp in the app does.
 */
const LOG_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/**
 * The owner-only log of every match-time proposal made this season.
 *
 * Reads as a record of how each matchup came to be scheduled: who offered a
 * time, when they offered it, and how the other player answered. It is a full
 * log rather than the single pending offer a matchup card shows, because the
 * point of asking the owner is to see the whole negotiation, including the
 * attempts that were declined or pulled.
 *
 * @param props.Groups - The log bucketed by week, newest week first.
 * @param props.timeZone - The owner's zone, so every offered time is shown in
 *   the same wall clock rather than the proposer's.
 * @param props.isLoading - Whether the log is still being fetched.
 * @param props.loadError - Message to show in place of the log if the read failed.
 */
function ProposalHistoryPanel({
  groups,
  timeZone,
  isLoading,
  loadError,
}: {
  groups: ProposalHistoryGroup[];
  timeZone: string;
  isLoading: boolean;
  loadError: string | null;
}) {
  if (isLoading) {
    return (
      <SectionCard title="Match proposal history">
        <p className="text-sm text-slate-400">Loading the match proposal log...</p>
      </SectionCard>
    );
  }

  if (loadError) {
    return (
      <SectionCard title="Match proposal history">
        <p className="text-sm text-rose-300">{loadError}</p>
      </SectionCard>
    );
  }

  if (groups.length === 0) {
    return (
      <SectionCard title="Match proposal history">
        <p className="text-sm text-slate-400">
          No match times have been proposed this season.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Match proposal history">
      <p className="mb-4 text-sm text-slate-400">
        Every proposed match time this season and how it was answered. Times are
        converted into your own zone and labelled with it, since each was
        proposed by whichever player suggested it.
      </p>
      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.week_number}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.15em] text-slate-300">
              {proposalWeekLabel(group)}
            </h3>
            <div className="space-y-2">
              {group.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-slate-200">
                      {entry.player_1_name} vs {entry.player_2_name}
                    </p>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${proposalOutcomeTone(entry.status)}`}
                    >
                      {proposalOutcomeLabel(entry)}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-400 sm:grid-cols-2">
                    <div className="flex gap-1.5">
                      <dt className="text-slate-500">Offered time</dt>
                      <dd className="text-slate-300">
                        {formatDateTimeInZone(
                          entry.proposed_at,
                          timeZone,
                          LOG_TIMESTAMP_FORMAT,
                        )}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-slate-500">Proposed by</dt>
                      <dd className="text-slate-300">{entry.proposed_by_name}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-slate-500">Proposed at</dt>
                      <dd className="text-slate-300">
                        {formatDateTimeInZone(
                          entry.created_at,
                          timeZone,
                          LOG_TIMESTAMP_FORMAT,
                        )}
                      </dd>
                    </div>
                    {entry.responded_at && (
                      <div className="flex gap-1.5">
                        <dt className="text-slate-500">Answered at</dt>
                        <dd className="text-slate-300">
                          {formatDateTimeInZone(
                            entry.responded_at,
                            timeZone,
                            LOG_TIMESTAMP_FORMAT,
                          )}
                        </dd>
                      </div>
                    )}
                    {entry.notes && (
                      <div className="flex gap-1.5 sm:col-span-2">
                        <dt className="shrink-0 text-slate-500">Notes</dt>
                        <dd className="text-slate-300">{entry.notes}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
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
  const { confirm, confirmDialog } = useConfirm();
  const [goods, setGoods] = useState<SchedulePageGoods | null>(null);
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
    entries: ProposalHistoryEntry[];
    isLoading: boolean;
    error: string | null;
  } | null>(null);
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
  /*
   * The date input the calendar button drives. The native picker is opened
   * imperatively because the browser will not reliably show it when the input
   * is clicked directly, which is the reason the button exists at all.
   */
  const scheduleDateRef = useRef<HTMLInputElement>(null);
  /*
   * Whether the native calendar is up. The ref is the source of truth for the
   * toggle, because a ref read is not stale within the same render and a
   * double click has to open then close; the state only drives `aria-expanded`.
   */
  const datePickerOpenRef = useRef(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  /*
   * The opponent's availability, fetched only when the scheduling form opens.
   * Null means "not loaded yet or the opponent has not declared a week", which
   * the form distinguishes from a failed read so an empty panel is never
   * mistaken for no free time.
   */
  const [opponentAvailability, setOpponentAvailability] =
    useState<MemberAvailability | null>(null);
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(false);
  const [availabilityError, setAvailabilityError] = useState(false);

  /*
   * The league's weekly deadline, shown in the header. Read through the same RPC
   * the league settings page uses so the date here can never disagree with the
   * one the owner configured.
   */
  const [weekProgress, setWeekProgress] = useState<WeekProgressState | null>(null);

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

  /*
   * The zone every match time on this page is rendered in, resolved from the
   * member's settings rather than the browser's.
   */
  const timeZone = useUserTimeZone();

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
    // The header advertises the next weekly deadline, so it is re-read on every
    // refresh; a league that has not applied the migration simply shows none.
    try {
      setWeekProgress(await loadWeekProgressState(leagueId));
    } catch {
      setWeekProgress(null);
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
    if (weekProgress?.deadline_enabled && weekProgress.current_week > 0) {
      return weekProgress.current_week;
    }

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
  }, [regularMatches, weekProgress]);

  /*
   * What the header calls the phase the league is in.
   *
   * Derived from the regular season rather than from the week pointer alone, so
   * a league that has not started a week yet reads as the preseason instead of
   * claiming the postseason.
   */
  const phaseLabel = useMemo(
    () =>
      seasonPhaseLabel({
        currentWeek,
        regularSeasonCompleted: weekProgress?.regular_season_completed === true,
        regularMatches,
      }),
    [currentWeek, regularMatches, weekProgress],
  );

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

  /*
   * True while the member is part-way through one of the page's forms. A refresh
   * replaces the matches, which re-derives the selected matchup, so refetching
   * underneath an open form could move them off the matchup they are filling in
   * and lose what they typed.
   */
  const formOpen =
    (schedulingMatchId != null && schedulingMatchId === selectedMatch?.id) ||
    (reportingMatchId != null && reportingMatchId === selectedMatch?.id) ||
    editingResultId != null;

  const isFormOpen = useCallback(() => formOpen, [formOpen]);

  /** Re-reads the schedule after a real-time change, unless a form is open. */
  const reloadForRealtime = useCallback(() => {
    const leagueId = goods?.league.id;

    if (!leagueId) {
      return;
    }

    void refresh(leagueId);
  }, [goods?.league.id, refresh]);

  /*
   * Live updates for the matchups, their agreed times, and the proposals behind
   * them. A change that lands while a form is open is held and applied when the
   * form closes, so the update is deferred rather than lost.
   */
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
        entries: await loadProposalHistory(leagueId, seasonId),
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
  const proposalHistory = proposalHistoryState?.key === proposalHistoryKey
    ? proposalHistoryState
    : null;

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
    isPaused: isFormOpen,
  });

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
   * The member on the other side of the selected matchup, or null when the
   * viewer is not a participant and therefore has no opponent to schedule with.
   */
  const opponent = useMemo(() => {
    if (!goods || !selectedMatch || !myMatch) {
      return null;
    }

    const isPlayerOne = selectedMatch.player_1_team_id === goods.myTeamId;

    return {
      userId: isPlayerOne
        ? selectedMatch.player_2_user_id
        : selectedMatch.player_1_user_id,
      name: isPlayerOne
        ? selectedMatch.player_2_name
        : selectedMatch.player_1_name,
    };
  }, [goods, selectedMatch, myMatch]);

  /** The time waiting for an answer, when the matchup has one. */
  const pendingProposal = selectedMatch?.pending_proposal ?? null;

  /** True when the viewer is the one who proposed the pending time. */
  const proposalIsMine = Boolean(
    pendingProposal && pendingProposal.proposed_by === goods?.currentUserId,
  );

  /** Who to name as the proposer, whichever side of the matchup they are on. */
  const proposalAuthorName = useMemo(() => {
    if (!pendingProposal) {
      return "Your opponent";
    }

    if (proposalIsMine) {
      return "You";
    }

    if (pendingProposal.proposed_by === selectedMatch?.player_1_user_id) {
      return selectedMatch?.player_1_name ?? "Your opponent";
    }

    return opponent?.name ?? "Your opponent";
  }, [pendingProposal, proposalIsMine, selectedMatch, opponent]);

  /*
   * The opponent's week projected into the reader's zone. The week sampled is
   * the calendar week the reader is currently in, because a recurring window has
   * no league-week date of its own and the offset between two zones is what
   * actually moves a window between weekdays.
   */
  const opponentWindows = useMemo<AvailabilityWindow[]>(() => {
    if (!opponentAvailability?.week) {
      return [];
    }

    const anchorDate = toZonedParts(new Date(), timeZone)?.date ?? "";

    if (!anchorDate) {
      return [];
    }

    return projectAvailabilityWeek(
      opponentAvailability.week,
      opponentAvailability.timeZone,
      timeZone,
      anchorDate,
    );
  }, [opponentAvailability, timeZone]);

  /** The weekday the reader is on, so today's row can be called out. */
  const today = useMemo(
    () => dayOfWeekFromDate(toZonedParts(new Date(), timeZone)?.date ?? ""),
    [timeZone],
  );

  /**
   * Whether the time currently typed into the scheduling form lands inside the
   * opponent's stated availability. Null while no time is chosen, or when the
   * opponent has not declared a week to check against.
   */
  const scheduleFit = useMemo(() => {
    if (!opponent || !opponentAvailability?.week) {
      return null;
    }

    const day = dayOfWeekFromDate(datePartOfInputValue(scheduleTime));
    const minutes = minutesFromInputValue(scheduleTime);

    if (day == null || minutes == null) {
      return null;
    }

    return availabilityFit(opponentWindows, day, minutes);
  }, [scheduleTime, opponent, opponentAvailability, opponentWindows]);

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

  /** The owner's proposal log, bucketed into weeks for the history panel. */
  const proposalHistoryGroups = useMemo(
    () => groupProposalHistoryByWeek(proposalHistory?.entries ?? []),
    [proposalHistory],
  );

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

  /**
   * Toggles the native date picker.
   *
   * `showPicker()` can open the calendar but there is no matching call to close
   * it, so closing is done by blurring the input, which is what dismisses the
   * browser's popup. The button's `mousedown` is prevented so that pressing it
   * does not blur the input first, which would clear the open flag before this
   * runs and make the button reopen the calendar it had just closed.
   *
   * `showPicker()` also throws rather than degrading when the browser has not
   * implemented it, when the input is not pickable, or when it is called outside
   * a user gesture. Focusing and clicking the input is the fallback that still
   * reaches the browser's own picker.
   */
  function handleOpenDatePicker() {
    const input = scheduleDateRef.current;

    if (!input) {
      return;
    }

    if (datePickerOpenRef.current) {
      datePickerOpenRef.current = false;
      setIsDatePickerOpen(false);
      input.blur();
      return;
    }

    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        datePickerOpenRef.current = true;
        setIsDatePickerOpen(true);
        return;
      } catch {
        // Not implemented or not permitted here; use the fallback below.
      }
    }

    input.focus();
    input.click();
  }

  /** Applies a date chosen from the calendar, keeping any time already set. */
  function handleScheduleDateChange(event: React.ChangeEvent<HTMLInputElement>) {
    // The browser dismisses the calendar itself once a day is chosen, so the
    // open state has to be cleared here or the next button press would try to
    // close a popup that is already gone.
    datePickerOpenRef.current = false;
    setIsDatePickerOpen(false);
    setScheduleTime(withInputValueDate(scheduleTime, event.target.value));
  }

  /** Marks the calendar closed when focus leaves the field for any other reason. */
  function handleScheduleDateBlur() {
    datePickerOpenRef.current = false;
    setIsDatePickerOpen(false);
  }

  /**
   * Opens the scheduling form for the selected matchup and pulls in the
   * opponent's availability so the chosen time can be checked against it.
   *
   * When the viewer already has a pending proposal the form opens on that time,
   * because sending a new proposal withdraws the old one and losing their
   * suggestion to a default would be a needless surprise. Otherwise the date
   * defaults to today in the reader's zone and the time is left blank: today is
   * almost always right, whereas guessing an hour would quietly bias every
   * proposal toward the same time of day.
   *
   * The availability read is best effort: a failure leaves the form usable, it
   * just cannot advise on the proposed time.
   */
  async function openScheduling() {
    if (!selectedMatch) {
      return;
    }

    const staged = selectedMatch.pending_proposal?.proposed_at ?? selectedMatch.scheduled_at;

    setSchedulingMatchId(selectedMatch.id);
    // A picker left open from a previous form would make the first press on the
    // button try to close a calendar that is not there.
    datePickerOpenRef.current = false;
    setIsDatePickerOpen(false);
    setScheduleTime(
      staged ? toZonedInputValue(staged, timeZone) : todayInZone(timeZone),
    );
    setScheduleNotes(
      selectedMatch.pending_proposal?.notes ?? selectedMatch.notes ?? "",
    );
    setOpponentAvailability(null);
    setAvailabilityError(false);

    if (!opponent?.userId) {
      return;
    }

    setIsLoadingAvailability(true);

    try {
      const availability = await loadMemberAvailability([opponent.userId]);
      setOpponentAvailability(availability[opponent.userId] ?? null);
    } catch {
      setOpponentAvailability(null);
      setAvailabilityError(true);
    } finally {
      setIsLoadingAvailability(false);
    }
  }

  /** Sends the form's time to the opponent as a proposal to accept or decline. */
  async function handleProposeTime() {
    if (!goods || !selectedMatch) {
      return;
    }

    const proposedAt = fromZonedInputValue(scheduleTime, timeZone);

    if (!proposedAt) {
      setError("Choose a valid date and time to propose.");
      return;
    }

    await canRunMutation(
      () => proposeMatchTime(selectedMatch.id, proposedAt, scheduleNotes),
      goods.league.id,
    );
    setSchedulingMatchId(null);
    setOpponentAvailability(null);
    setAvailabilityError(false);
    setNotice("Time proposed. Your opponent has to accept it.");
  }

  /** Accepts or declines the time the opponent proposed. */
  async function handleRespondToProposal(matchId: string, accept: boolean) {
    if (!goods) {
      return;
    }

    const responded = await confirm({
      title: accept ? "Accept this match time?" : "Decline this match time?",
      detail: accept
        ? "The match is scheduled and both of you will see the agreed time"
        : "The matchup goes back to needing a time, and the other player is told",
      confirmLabel: accept ? "Accept time" : "Decline",
      tone: accept ? "default" : "danger",
    });

    if (!responded) {
      return;
    }

    await canRunMutation(
      () => respondToMatchProposal(matchId, accept),
      goods.league.id,
    );
    setNotice(
      accept ? "Match time agreed. The match is scheduled." : "Time declined.",
    );
  }


  /** Withdraws the viewer's own pending proposal. */
  async function handleCancelProposal(matchId: string) {
    if (!goods) {
      return;
    }

    const withdrew = await confirm({
      title: "Withdraw your proposed time?",
      detail:
        "The proposal is removed and the matchup goes back to needing a time",
      confirmLabel: "Withdraw",
      tone: "danger",
    });

    if (!withdrew) {
      return;
    }

    await canRunMutation(() => cancelMatchProposal(matchId), goods.league.id);
    setNotice("Proposal withdrawn.");
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

    const forfeiting = await confirm({
      title: "Forfeit this match?",
      detail: `${opponent} takes the win and the loss is recorded against your KO differential`,
      confirmLabel: "Forfeit",
      tone: "danger",
    });

    if (!forfeiting) {
      return;
    }
    await canRunMutation(() => forfeitMatch(selectedMatch.id), goods.league.id);
    setNotice("Match forfeited.");
  }

  async function handleDeleteMatch(match: ScheduleMatch) {
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
  const hasDeadline = Boolean(weekProgress?.deadline_enabled && deadlineInstant);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">{goods.league.name}</h1>
              <p className="mt-1 text-sm text-slate-400">
                Schedule • {formatSeasonLabel(goods.season)}
                {` • ${phaseLabel}`}
                {" • All times in "}
                <span className="text-slate-300">{formatTimeZoneLabel(timeZone)}</span>
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

        {/*
          * The weekly deadline is a league-wide commitment, so it is announced in
          * its own banner rather than as another line of grey subtext in the
          * header: a member who has not proposed a time yet needs to know how
          * long they have left to agree on one.
          */}
        {hasDeadline && (
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

        {!hasDeadline && (
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

                    {/*
                      * The time line is the whole point of the agreement flow, so
                      * it says which of the three states the matchup is in: no
                      * time, a time waiting on the opponent, or an agreed time.
                      */}
                    {pendingProposal ? (
                      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                        <p className="font-semibold text-amber-200">
                          {formatDateTimeInZone(
                            pendingProposal.proposed_at,
                            timeZone,
                          )}
                        </p>
                        <p className="mt-1 text-amber-200/80">
                          {proposalAuthorName} proposed this time.{" "}
                          {proposalIsMine
                            ? "Waiting for your opponent to accept."
                            : "Accept or decline it below."}
                        </p>
                      </div>
                    ) : selectedMatch.scheduled_at ? (
                      <p className="text-sm text-slate-300">
                        {formatDateTimeInZone(selectedMatch.scheduled_at, timeZone)}
                        <span className="ml-2 text-xs text-emerald-300">
                          agreed by both players
                        </span>
                      </p>
                    ) : (
                      <p className="text-sm text-slate-500">
                        No time agreed yet — both players have to agree before
                        this matchup is scheduled.
                      </p>
                    )}
                    {selectedMatch.notes && (
                      <p className="text-sm italic text-slate-400">
                        “{selectedMatch.notes}”
                      </p>
                    )}

                    {canAct && (
                      <div className="flex flex-wrap justify-center gap-2">
                        {/* The player who proposed cannot answer their own question. */}
                        {pendingProposal && !proposalIsMine ? (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleRespondToProposal(selectedMatch.id, true)
                              }
                              className="rounded-xl bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                            >
                              Accept time
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleRespondToProposal(selectedMatch.id, false)
                              }
                              className="rounded-xl border border-rose-800 bg-rose-950/50 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
                            >
                              Decline
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={openScheduling}
                            className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                          >
                            {proposalIsMine
                              ? "Change proposed time"
                              : selectedMatch.scheduled_at
                                ? "Propose a new time"
                                : "Propose a time"}
                          </button>
                        )}

                        {proposalIsMine && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleCancelProposal(selectedMatch.id)}
                            className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
                          >
                            Withdraw
                          </button>
                        )}

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
                      {/*
                       * Not built with Field: that wraps its control in a
                       * <label>, and a button inside a label would activate the
                       * input as well, so the two would fight over the click.
                       */}
                      <div>
                        <label
                          htmlFor="propose-date"
                          className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-400"
                        >
                          Date ({formatTimeZoneLabel(timeZone)})
                        </label>
                        {/*
                         * The button sits against the input's right edge, between
                         * the date and the time, so the pair reads as one control
                         * and the eye lands on it from the time field.
                         */}
                        <div className="flex gap-2">
                          <input
                            id="propose-date"
                            ref={scheduleDateRef}
                            type="date"
                            value={datePartOfInputValue(scheduleTime)}
                            onChange={handleScheduleDateChange}
                            onBlur={handleScheduleDateBlur}
                            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500 [&::-webkit-calendar-picker-indicator]:hidden"
                          />
                          <button
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={handleOpenDatePicker}
                            aria-label="Open the calendar to pick a date"
                            aria-expanded={isDatePickerOpen}
                            title="Open the calendar"
                            className="shrink-0 rounded-xl border border-slate-700 bg-slate-950 px-2.5 text-slate-300 transition hover:border-amber-500 hover:text-amber-400"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                              className="h-4 w-4 fill-current"
                            >
                              <path d="M7 1.8a1 1 0 0 1 1 1v1.4h8V2.8a1 1 0 1 1 2 0v1.4h1.6A2.4 2.4 0 0 1 22 6.6V9H2V6.6a2.4 2.4 0 0 1 2.4-2.4H6V2.8a1 1 0 0 1 1-1ZM2 11h20v9.4A2.4 2.4 0 0 1 19.6 23H4.4A2.4 2.4 0 0 1 2 20.4V11Zm4.5 1.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM6.5 16a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" />
                            </svg>
                          </button>
                        </div>
                        <span className="mt-1 block text-xs text-slate-400">
                          Pick a day. The time is separate, next to it.
                        </span>
                      </div>
                      <Field
                        label={`Time (${formatTimeZoneLabel(timeZone)})`}
                        hint={
                          scheduleFit === null
                            ? null
                            : scheduleFit === "inside"
                              ? "Inside the time your opponent is available."
                              : scheduleFit === "unavailable"
                                ? `${opponent?.name} marked that day unavailable.`
                                : `Outside the window ${opponent?.name} is available.`
                        }
                      >
                        <input
                          type="time"
                          value={timePartOfInputValue(scheduleTime)}
                          onChange={(event) =>
                            setScheduleTime(
                              withInputValueTime(
                                scheduleTime,
                                event.target.value,
                              ),
                            )
                          }
                          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                        />
                      </Field>
                      <div className="md:col-span-2">
                        <Field label="Notes">
                          <input
                            type="text"
                            value={scheduleNotes}
                            placeholder="Replay room notes, etc."
                            onChange={(event) => setScheduleNotes(event.target.value)}
                            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                          />
                        </Field>
                      </div>

                      {/*
                       * The opponent's declared week, translated into the
                       * reader's zone so it can be compared with the input above
                       * without doing the conversion by hand.
                       */}
                      <div className="md:col-span-2">
                        <p className="text-sm font-medium text-slate-300">
                          {opponent?.name ?? "Your opponent"}&apos;s availability
                        </p>
                        {isLoadingAvailability ? (
                          <p className="mt-2 text-sm text-slate-500">
                            Loading availability...
                          </p>
                        ) : availabilityError ? (
                          <p className="mt-2 text-sm text-slate-500">
                            Availability could not be loaded. You can still
                            schedule the match.
                          </p>
                        ) : !opponentAvailability?.week ? (
                          <p className="mt-2 text-sm text-slate-500">
                            {opponent
                              ? `${opponent.name} has not set availability yet.`
                              : "Only match participants can schedule a match."}
                          </p>
                        ) : (
                          <>
                            <p className="mt-1 text-xs text-slate-500">
                              Converted from {opponentAvailability.timeZone} into
                              your time zone ({formatTimeZoneLabel(timeZone)}).
                            </p>
                            <div className="mt-3 space-y-1.5">
                              {WEEKDAY_LABELS.map((label, dayOfWeek) => {
                                const dayWindows = windowsForWeekday(
                                  opponentWindows,
                                  dayOfWeek,
                                );

                                return (
                                  <div
                                    key={dayOfWeek}
                                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm ${
                                      dayOfWeek === today
                                        ? "border-amber-500/50 bg-slate-900"
                                        : "border-slate-800 bg-slate-950/50"
                                    }`}
                                  >
                                    <span className="text-slate-300">
                                      {label}
                                      {dayOfWeek === today && (
                                        <span className="ml-2 text-xs text-amber-400">
                                          today
                                        </span>
                                      )}
                                    </span>
                                    <span className="text-right text-slate-400">
                                      {dayWindows.length === 0
                                        ? "Unavailable"
                                        : dayWindows
                                            .map((window) =>
                                              formatAvailabilityWindow(window),
                                            )
                                            .join(", ")}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="flex gap-2 md:col-span-2">
                        <button
                          type="button"
                          disabled={isBusy || !timePartOfInputValue(scheduleTime)}
                          onClick={handleProposeTime}
                          className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                        >
                          Send proposal
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSchedulingMatchId(null);
                            setOpponentAvailability(null);
                            setAvailabilityError(false);
                            // A change held while the form was open is applied
                            // now that the member is done editing.
                            flushRealtime();
                          }}
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
                          onClick={() => {
                            setReportingMatchId(null);
                            flushRealtime();
                          }}
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
                                      onClick={() => {
                                      setEditingResultId(null);
                                      flushRealtime();
                                    }}
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
                          {formatDateTimeInZone(match.scheduled_at, timeZone)}
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
                      timeZone={timeZone}
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
                            name={teamLabel(row.team_id, row.team_name)}
                            avatarUrl={
                              goods.teams.find(
                                (team) => team.id === row.team_id,
                              )?.owner_avatar_url ?? null
                            }
                            size={28}
                          />
                          <span className="font-medium text-slate-100">
                            {teamLabel(row.team_id, row.team_name)}
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
          <>
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
                        won • {formatDateTimeInZone(submitted_at, timeZone)}
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

            {/*
             * Owner-only, and gated on ownership twice over: the panel is not
             * rendered at all for a member, and the database would refuse the log
             * to one anyway. It sits under the match history because the two
             * answer the same question at different resolutions, one per game
             * played and one per time proposed.
             */}
            {goods.isOwner && (
              <ProposalHistoryPanel
                groups={proposalHistoryGroups}
                timeZone={timeZone}
                /*
                 * Still loading until the first read for this league and season
                 * comes back. Deriving it from the absence of a matching log
                 * rather than from a separate flag keeps the panel from claiming
                 * to be empty in the gap before the first response arrives.
                 */
                isLoading={
                  Boolean(proposalHistoryKey) &&
                  proposalHistory?.isLoading !== false
                }
                loadError={proposalHistory?.error ?? null}
              />
            )}
          </>
        )}

        {confirmDialog}
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
