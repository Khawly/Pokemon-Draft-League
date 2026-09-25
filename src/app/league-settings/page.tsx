/*
 * League settings page for the Pokemon Draft League.
 *
 * Lets an authorized user edit league metadata (name, player count), the league
 * format (6v6/4v4), and transaction/trade rules for the active season, plus the
 * recurring weekly deadline that automatically closes each week and moves the
 * league to the next week or the playoffs. Everything persists through Supabase
 * (direct writes for the metadata, owner RPCs for the deadline).
 */
"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  browserTimeZone,
  formatInTimeZone,
  listTimeZones,
  timeZoneOffsetLabel,
  toZonedParts,
  zonedTimeToInstant,
} from "@/lib/datetime";
import {
  doubleForfeitDifferential,
  loadWeekDeadlineSettings,
  loadWeekProgressState,
  nextDeadlineInstant,
  progressLeagueWeek,
  saveLeagueFormat,
  saveWeekDeadline,
  setWeekDeadlinePaused,
  undoWeekProgress,
  type LeagueFormat,
  type WeekDeadlineSettings,
  type WeekProgressState,
  type WeekProgressStatus,
} from "@/lib/supabase/week-deadline";
import { loadLatestSeason, saveSeasonName } from "@/lib/supabase/seasons";

/**
 * Picks a sensible first weekly deadline date: today when the chosen time is
 * still ahead, otherwise tomorrow, so enabling the deadline never closes a
 * week the moment the owner turns it on.
 *
 * @param time - `HH:MM` local deadline time.
 * @param timeZone - IANA time zone the time is expressed in.
 * @returns A `YYYY-MM-DD` calendar date in that time zone.
 */
function defaultFirstDeadlineDate(time: string, timeZone: string): string {
  const now = new Date();
  const today = toZonedParts(now, timeZone)?.date ?? "";
  const todayInstant = today ? zonedTimeToInstant(today, time, timeZone) : null;

  if (todayInstant && todayInstant.getTime() > now.getTime()) {
    return today;
  }

  return (
    toZonedParts(new Date(now.getTime() + 86_400_000), timeZone)?.date ?? today
  );
}

/**
 * Turns a week progression status into the confirmation the settings page shows
 * once the owner has pressed the button.
 *
 * @param status - Status returned by the progression RPC.
 * @param before - Progression state read before the week moved.
 * @param currentWeek - Week that was being closed.
 * @returns A sentence describing what the progression did.
 */
function describeProgressResult(
  status: WeekProgressStatus,
  before: WeekProgressState,
  currentWeek: number,
): string {
  const settled =
    before.unreported_matches > 0
      ? ` ${before.unreported_matches} unreported match${
          before.unreported_matches === 1 ? " was" : "es were"
        } settled as a double loss.`
      : "";

  switch (status) {
    case "advanced":
      return `Week ${currentWeek} closed and the league is now on week ${
        currentWeek + 1
      }.${settled}`;
    case "playoffs_started":
      return `Week ${currentWeek} closed, the regular season is frozen, and the playoff bracket is open.${settled}`;
    case "playoffs_pending":
      return `Week ${currentWeek} closed and the regular season is frozen. The bracket opens once the draft and standings allow it.${settled}`;
    case "regular_season_complete":
      return "The regular season is already complete, so there is no week left to progress.";
    case "no_schedule":
      return "This league has no regular-season schedule to progress.";
    case "not_due":
      return "The weekly deadline has not passed yet, so the week was not closed.";
    default:
      return `Week ${currentWeek} closed.${settled}`;
  }
}

/**
 * League settings page that suspends rendering until the client-only
 * settings content has been resolved.
 */
export default function LeagueSettingsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading league settings...
          </div>
        </main>
      }
    >
      <LeagueSettingsPageContent />
    </Suspense>
  );
}

/**
 * Client component for editing and saving league settings.
 * Loads the current league and its latest season's settings, gracefully
 * handling schemas that are missing optional columns.
 */
function LeagueSettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const [accessAllowed, setAccessAllowed] = useState<boolean | null>(null);
  const [leagueName, setLeagueName] = useState("");
  const [seasonName, setSeasonName] = useState("");
  const [numberOfPlayers, setNumberOfPlayers] = useState(10);
  const [isLoading, setIsLoading] = useState(true);
  const [supportsNumberOfPlayers, setSupportsNumberOfPlayers] = useState(false);
  const [supportsSeasonName, setSupportsSeasonName] = useState(true);
  const [supportsLeagueSettingsColumns, setSupportsLeagueSettingsColumns] =
    useState(false);
  const [enableTransactionCosts, setEnableTransactionCosts] = useState(false);
  const [transactionCost, setTransactionCost] = useState(0);
  const [adminsApproveTrades, setAdminsApproveTrades] = useState(false);
  const [ownersAdminsVoteOnTrades, setOwnersAdminsVoteOnTrades] =
    useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [deadlineSettings, setDeadlineSettings] =
    useState<WeekDeadlineSettings | null>(null);
  const [leagueFormat, setLeagueFormat] = useState<LeagueFormat>("6v6");
  const [deadlineEnabled, setDeadlineEnabled] = useState(false);
  const [deadlineDate, setDeadlineDate] = useState("");
  const [deadlineTime, setDeadlineTime] = useState("20:00");
  const [deadlineTimeZone, setDeadlineTimeZone] = useState("UTC");
  const [isDeadlineSaving, setIsDeadlineSaving] = useState(false);
  const [isProgressing, setIsProgressing] = useState(false);
  const [progressState, setProgressState] = useState<WeekProgressState | null>(
    null,
  );
  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  const [deadlineMessage, setDeadlineMessage] = useState<string | null>(null);
  const originalSettingsRef = useRef({
    leagueName: "",
    numberOfPlayers: 10,
    enableTransactionCosts: false,
    transactionCost: 0,
    adminsApproveTrades: false,
    ownersAdminsVoteOnTrades: false,
  });

  useEffect(() => {
    /** Loads league metadata and the latest season's settings for the selected league. */
    async function loadLeagueSettings() {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.replace("/");
          return;
        }

        let selectedLeagueId = searchParams.get("leagueId");

        // Fall back to the user's most recently joined active league when no league is specified.
        if (!selectedLeagueId) {
          const { data: memberships, error: membershipsError } = await supabase
            .from("league_members")
            .select("league_id")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("joined_at", { ascending: false })
            .limit(1);

          if (membershipsError || !memberships?.length) {
            setLeagueId(null);
            setSeasonId(null);
            return;
          }

          selectedLeagueId = memberships[0].league_id;
        }

        if (!selectedLeagueId) {
          setLeagueId(null);
          setSeasonId(null);
          return;
        }

        let leagueData: {
          name?: string | null;
          number_of_players?: number | null;
        } | null = null;
        let activeLeagueId = selectedLeagueId;

        const { data: membershipData, error: membershipError } = await supabase
          .from("league_members")
          .select("league_id, role, leagues(name)")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .order("joined_at", { ascending: false });

        if (membershipError || !membershipData || membershipData.length === 0) {
          setError("You are not a member of any active league.");
          setLeagueId(null);
          setSeasonId(null);
          return;
        }

        const selectedMembership = selectedLeagueId
          ? membershipData.find(
              (membership) => membership.league_id === selectedLeagueId,
            )
          : null;

        if (selectedMembership) {
          activeLeagueId = selectedLeagueId;
        } else {
          activeLeagueId = membershipData[0].league_id;
        }

        const resolvedMembership = membershipData.find(
          (membership) => membership.league_id === activeLeagueId,
        );

        // League settings are owner-only: block non-owners from viewing or editing.
        const isOwner =
          resolvedMembership &&
          (resolvedMembership as { role?: string | null }).role === "owner";

        if (!resolvedMembership || !isOwner) {
          router.replace("/dashboard");
          setAccessAllowed(false);
          setLeagueId(null);
          setSeasonId(null);
          setError("Only the league owner can manage league settings.");
          return;
        }

        setAccessAllowed(true);

        leagueData = resolvedMembership?.leagues as {
          name?: string | null;
          number_of_players?: number | null;
        } | null;

        if (!leagueData) {
          setError("This league could not be loaded.");
          return;
        }

        let resolvedNumberOfPlayers = 10;
        setSupportsNumberOfPlayers(true);

        try {
          // Optional column: probe for number_of_players and fall back to a default if absent.
          const { data: detailedLeagueData } = await supabase
            .from("leagues")
            .select("number_of_players")
            .eq("id", activeLeagueId)
            .maybeSingle();

          if (
            detailedLeagueData &&
            typeof detailedLeagueData.number_of_players === "number" &&
            Number.isFinite(detailedLeagueData.number_of_players)
          ) {
            resolvedNumberOfPlayers = detailedLeagueData.number_of_players;
          }
        } catch {
          setSupportsNumberOfPlayers(false);
        }

        setLeagueId(activeLeagueId);
        setLeagueName(leagueData.name || "");
        setNumberOfPlayers(resolvedNumberOfPlayers);

        const { data: seasonData, error: seasonError } = await loadLatestSeason<{
          id: string;
          season_number: number;
          name?: string | null;
        }>(activeLeagueId, "id, season_number, name");

        if (seasonError || !seasonData) {
          setSeasonId(null);
          return;
        }

        setSeasonId(seasonData.id);
        setSeasonNumber(seasonData.season_number);
        // An undefined name means the database predates the season name column,
        // so the field stays hidden rather than failing the save.
        setSupportsSeasonName(seasonData.name !== undefined);
        setSeasonName(seasonData.name ?? "");

        // Weekly deadline + league format live in their own columns; a null
        // result means the migration has not been applied yet.
        const loadedDeadline = await loadWeekDeadlineSettings(
          activeLeagueId,
          seasonData.id,
        );

        setDeadlineSettings(loadedDeadline);
        setLeagueFormat(loadedDeadline?.league_format ?? "6v6");
        setDeadlineEnabled(loadedDeadline?.week_deadline_enabled ?? false);
        setDeadlineTime(loadedDeadline?.week_deadline_time ?? "20:00");
        setProgressState(
          await loadWeekProgressState(activeLeagueId).catch(() => null),
        );

        const initialTimeZone =
          loadedDeadline?.week_deadline_timezone ?? browserTimeZone();
        const initialTime = loadedDeadline?.week_deadline_time ?? "20:00";
        setDeadlineTimeZone(initialTimeZone);
        setDeadlineDate(
          loadedDeadline?.week_deadline_anchor_date ??
            defaultFirstDeadlineDate(initialTime, initialTimeZone),
        );

        let settingsData: {
          enable_transaction_costs?: boolean | null;
          transaction_cost?: number | null;
          admins_approve_trades?: boolean | null;
          owners_admins_vote_on_trades?: boolean | null;
        } | null = null;

        try {
          // Optional columns: treat a query error as "columns not present" rather than failing hard.
          const response = await supabase
            .from("league_settings")
            .select(
              "enable_transaction_costs, transaction_cost, admins_approve_trades, owners_admins_vote_on_trades",
            )
            .eq("league_id", activeLeagueId)
            .eq("season_id", seasonData.id)
            .maybeSingle();

          settingsData = response.data;
          setSupportsLeagueSettingsColumns(!response.error);
        } catch {
          setSupportsLeagueSettingsColumns(false);
        }

        if (!settingsData) {
          setError(null);
          originalSettingsRef.current = {
            leagueName: leagueData.name || "",
            numberOfPlayers: resolvedNumberOfPlayers,
            enableTransactionCosts: false,
            transactionCost: 0,
            adminsApproveTrades: false,
            ownersAdminsVoteOnTrades: false,
          };
          setLeagueName(leagueData.name || "");
          setNumberOfPlayers(resolvedNumberOfPlayers);
          setEnableTransactionCosts(false);
          setTransactionCost(0);
          setAdminsApproveTrades(false);
          setOwnersAdminsVoteOnTrades(false);
          setHasUnsavedChanges(false);
          return;
        }

        const nextSettings = {
          leagueName: leagueData.name || "",
          numberOfPlayers: resolvedNumberOfPlayers,
          enableTransactionCosts: Boolean(
            settingsData.enable_transaction_costs,
          ),
          transactionCost: settingsData.transaction_cost ?? 0,
          adminsApproveTrades: Boolean(settingsData.admins_approve_trades),
          ownersAdminsVoteOnTrades: Boolean(
            settingsData.owners_admins_vote_on_trades,
          ),
        };

        originalSettingsRef.current = nextSettings;
        setLeagueName(nextSettings.leagueName);
        setNumberOfPlayers(nextSettings.numberOfPlayers);
        setEnableTransactionCosts(nextSettings.enableTransactionCosts);
        setTransactionCost(nextSettings.transactionCost);
        setAdminsApproveTrades(nextSettings.adminsApproveTrades);
        setOwnersAdminsVoteOnTrades(nextSettings.ownersAdminsVoteOnTrades);
        setHasUnsavedChanges(false);
      } finally {
        setIsLoading(false);
      }
    }

    loadLeagueSettings();
  }, [router, searchParams]);

  const timeZoneOptions = useMemo(() => listTimeZones(), []);

  /**
   * Time zone dropdown options, built once instead of on every render.
   *
   * Each label resolves a UTC offset, and with every zone in the list that is
   * expensive enough to be felt as input lag. Holding the elements in a stable
   * array also lets React skip re-rendering the option list entirely when
   * unrelated state such as the season name changes.
   */
  const timeZoneOptionElements = useMemo(
    () =>
      timeZoneOptions.map((zone) => {
        const offset = timeZoneOffsetLabel(zone);

        return (
          <option key={zone} value={zone}>
            {offset ? `${zone} (${offset})` : zone}
          </option>
        );
      }),
    [timeZoneOptions],
  );

  /** The first deadline the owner has typed, resolved to an absolute instant. */
  const deadlinePreview = useMemo(() => {
    if (!deadlineDate || !deadlineTime || !deadlineTimeZone) {
      return null;
    }
    return zonedTimeToInstant(deadlineDate, deadlineTime, deadlineTimeZone);
  }, [deadlineDate, deadlineTime, deadlineTimeZone]);

  /** The next weekly deadline already stored for this league. */
  const nextDeadline = useMemo(
    () => (deadlineSettings ? nextDeadlineInstant(deadlineSettings) : null),
    [deadlineSettings],
  );

  /** The differential a double forfeit charges each side of a lost match. */
  const forfeitDifferential = useMemo(
    () =>
      doubleForfeitDifferential(
        leagueFormat,
        deadlineSettings?.match_format ?? "best_of_3",
      ),
    [leagueFormat, deadlineSettings?.match_format],
  );

  /** Re-reads the deadline row after a mutation. */
  const refreshDeadlineSettings = useCallback(async () => {
    if (!leagueId || !seasonId) {
      return;
    }
    const loaded = await loadWeekDeadlineSettings(leagueId, seasonId);
    setDeadlineSettings(loaded);
  }, [leagueId, seasonId]);

  /**
   * Re-reads the week progression state, which the Progress/Undo controls and
   * their confirmations are built from. A league on a database that predates the
   * weekly deadline migration simply has no controls to show.
   */
  const refreshProgressState = useCallback(async () => {
    if (!leagueId) {
      setProgressState(null);
      return;
    }

    try {
      setProgressState(await loadWeekProgressState(leagueId));
    } catch {
      setProgressState(null);
    }
  }, [leagueId]);

  /** Re-reads both the deadline row and the week progression state. */
  const refreshDeadlineState = useCallback(async () => {
    await Promise.all([refreshDeadlineSettings(), refreshProgressState()]);
  }, [refreshDeadlineSettings, refreshProgressState]);

  /**
   * Saves the league format and the recurring weekly deadline through the owner
   * RPCs, then re-reads the stored row.
   *
   * @throws If the league format or deadline RPC rejects the change.
   */
  async function handleSaveDeadline() {
    if (!leagueId) {
      setDeadlineError("Select a league before saving the deadline.");
      return;
    }

    if (deadlineEnabled && !deadlinePreview) {
      setDeadlineError(
        "That deadline does not exist in the selected time zone (daylight-saving gap). Pick another time or date.",
      );
      return;
    }

    setIsDeadlineSaving(true);
    setDeadlineError(null);
    setDeadlineMessage(null);

    try {
      await saveLeagueFormat(leagueId, leagueFormat);
      await saveWeekDeadline(leagueId, {
        enabled: deadlineEnabled,
        firstDeadlineDate: deadlineDate,
        time: deadlineTime,
        timeZone: deadlineTimeZone,
      });
      await refreshDeadlineState();
      setDeadlineMessage(
        deadlineEnabled
          ? "Weekly deadline saved. It repeats every 7 days in the selected time zone."
          : "Weekly deadline turned off. Weeks will no longer close automatically.",
      );
    } catch (caughtError) {
      setDeadlineError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save the weekly deadline.",
      );
    } finally {
      setIsDeadlineSaving(false);
    }
  }

  /**
   * Pauses or resumes the weekly deadline. Resuming evaluates the deadline
   * immediately, so an already-overdue week closes right away.
   *
   * @param paused - True to pause, false to resume.
   */
  async function handleToggleDeadlinePause(paused: boolean) {
    if (!leagueId) {
      return;
    }

    setIsDeadlineSaving(true);
    setDeadlineError(null);
    setDeadlineMessage(null);

    try {
      await setWeekDeadlinePaused(leagueId, paused);
      await refreshDeadlineState();
      setDeadlineMessage(
        paused
          ? "Deadline paused. The countdown is stopped until you resume it."
          : "Deadline resumed. If it had already passed, the league moved on one week.",
      );
    } catch (caughtError) {
      setDeadlineError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to change the deadline pause state.",
      );
    } finally {
      setIsDeadlineSaving(false);
    }
  }

  /**
   * Closes the current week and moves the league on by hand, after the owner
   * confirms what the unreported matches will be charged.
   *
   * @throws If the owner-only progression RPC rejects the request.
   */
  async function handleProgressWeek() {
    if (!leagueId || !progressState) {
      return;
    }

    const { current_week: currentWeek, total_weeks: totalWeeks } = progressState;
    const unreported = progressState.unreported_matches;
    const isFinalWeek = currentWeek >= totalWeeks;
    const settlementWarning =
      unreported > 0
        ? `${unreported} unreported match${
            unreported === 1 ? "" : "es"
          } in week ${currentWeek} will be settled as a double loss, charging each team ${forfeitDifferential} KO diff.`
        : `Every match in week ${currentWeek} has been reported, so nothing will be settled.`;

    const shouldProgress = window.confirm(
      isFinalWeek
        ? `Close week ${currentWeek} and open the playoffs now?\n\n${settlementWarning}\n\nClosing the final regular week also freezes the regular season.`
        : `Close week ${currentWeek} and move the league to week ${
            currentWeek + 1
          } now?\n\n${settlementWarning}\n\nYour saved weekly deadline is not changed.`,
    );

    if (!shouldProgress) {
      return;
    }

    setIsProgressing(true);
    setDeadlineError(null);
    setDeadlineMessage(null);

    try {
      const status: WeekProgressStatus = await progressLeagueWeek(leagueId);
      await refreshDeadlineState();
      setDeadlineMessage(
        describeProgressResult(status, progressState, currentWeek),
      );
    } catch (caughtError) {
      setDeadlineError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to progress the week.",
      );
    } finally {
      setIsProgressing(false);
    }
  }

  /**
   * Reverts the most recent week progression after the owner confirms, reopening
   * the matches it settled and restoring the week pointer.
   *
   * @throws If the owner-only undo RPC rejects the request.
   */
  async function handleUndoProgressWeek() {
    if (!leagueId || !progressState?.latest_progress) {
      return;
    }

    const entry = progressState.latest_progress;
    const reverted =
      entry.settled_count > 0
        ? `Week ${entry.to_week} reopens: ${
            entry.settled_count
          } match(es) go back to unreported and the notifications about those losses are removed.`
        : `Week ${entry.to_week} reopens.`;

    const bracketNote =
      entry.playoff_matches > 0
        ? `\n\nThe ${entry.playoff_matches} playoff match(es) that progression created are removed again.`
        : "";

    const shouldUndo = window.confirm(
      `Undo the last week progression (${entry.from_week} to ${entry.to_week}${
        entry.source === "manual" ? ", run manually" : ", run by the weekly deadline"
      })?\n\n${reverted}${bracketNote}\n\nThe league returns to week ${entry.from_week}.`,
    );

    if (!shouldUndo) {
      return;
    }

    setIsProgressing(true);
    setDeadlineError(null);
    setDeadlineMessage(null);

    try {
      const result = await undoWeekProgress(leagueId);
      await refreshDeadlineState();

      if (result.status === "nothing_to_undo") {
        setDeadlineMessage("There is no week progression left to undo.");
        return;
      }

      if (result.status === "stale") {
        setDeadlineError(
          result.message ??
            "The league has moved on since that week was progressed, so it can no longer be undone.",
        );
        return;
      }

      const reopened = result.matches_reopened ?? 0;
      const playoffRemoved = result.playoff_matches_deleted ?? 0;
      const parts = [
        `Back to week ${result.to_week}.`,
        reopened > 0
          ? `${reopened} match(es) are open again.`
          : "No matches needed reopening.",
      ];

      if (playoffRemoved > 0) {
        parts.push(`${playoffRemoved} playoff match(es) removed.`);
      }

      if (result.will_resettle) {
        parts.push(
          "The weekly deadline has already passed, so it will settle this week again unless you pause it first.",
        );
      }

      setDeadlineMessage(parts.join(" "));
    } catch (caughtError) {
      setDeadlineError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to undo the week progression.",
      );
    } finally {
      setIsProgressing(false);
    }
  }

  /**
   * Prompts the user if there are unsaved changes before executing the next action.
   * @param nextAction - Optional callback to execute if the user chooses to leave.
   */
  function confirmLeaveWithoutSaving(nextAction?: () => void) {
    if (!hasUnsavedChanges) {
      nextAction?.();
      return;
    }

    const shouldLeave = window.confirm(
      "You have unsaved league settings changes. Leave without saving?",
    );

    if (!shouldLeave) {
      return;
    }

    nextAction?.();
  }

  /**
   * Saves league metadata to the leagues table and settings to the league_settings table.
   * Re-probes schema support before saving and throws if required columns are missing.
   */
  async function handleSaveChanges() {
    if (!leagueId || !seasonId) {
      setError("Select a league before saving settings.");
      return;
    }

    const trimmedLeagueName = leagueName.trim();
    if (!trimmedLeagueName) {
      setError("League name is required.");
      return;
    }

    const trimmedSeasonName = seasonName.trim();
    if (trimmedSeasonName.length > 80) {
      setError("Season name must be 80 characters or fewer.");
      return;
    }

    const normalizedPlayers = Number(numberOfPlayers) || 10;
    const normalizedTransactionCost = enableTransactionCosts
      ? Number(transactionCost) || 0
      : null;
    const normalizedOwnersAdminsVoteOnTrades =
      adminsApproveTrades && ownersAdminsVoteOnTrades;

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      let latestSupportsNumberOfPlayers = supportsNumberOfPlayers;
      let latestSupportsLeagueSettingsColumns = supportsLeagueSettingsColumns;
      let latestSupportsSeasonName = supportsSeasonName;

      try {
        // Re-probe the optional season name column before saving, so a league
        // whose migration landed after page load saves the name too.
        const { data: seasonProbe, error: seasonProbeError } =
          await loadLatestSeason<{ id: string; name?: string | null }>(
            leagueId,
            "id, name",
          );

        latestSupportsSeasonName = !seasonProbeError && seasonProbe?.name !== undefined;
      } catch {
        latestSupportsSeasonName = false;
      }

      try {
        // Re-probe schema support before saving to detect columns added after page load.
        const { data: schemaProbe } = await supabase
          .from("leagues")
          .select("number_of_players")
          .eq("id", leagueId)
          .limit(1);

        latestSupportsNumberOfPlayers =
          Array.isArray(schemaProbe) || !!schemaProbe;
      } catch {
        latestSupportsNumberOfPlayers = false;
      }

      try {
        // Re-probe league_settings columns before saving.
        const { data: settingsProbe, error: settingsProbeError } =
          await supabase
            .from("league_settings")
            .select(
              "enable_transaction_costs, transaction_cost, admins_approve_trades, owners_admins_vote_on_trades",
            )
            .eq("league_id", leagueId)
            .eq("season_id", seasonId)
            .limit(1);

        latestSupportsLeagueSettingsColumns =
          !settingsProbeError &&
          (Array.isArray(settingsProbe) || !!settingsProbe);
      } catch {
        latestSupportsLeagueSettingsColumns = false;
      }

      setSupportsNumberOfPlayers(latestSupportsNumberOfPlayers);
      setSupportsLeagueSettingsColumns(latestSupportsLeagueSettingsColumns);
      setSupportsSeasonName(latestSupportsSeasonName);

      if (
        // Guard against saving settings when the required migration hasn't run.
        !latestSupportsLeagueSettingsColumns &&
        !supportsLeagueSettingsColumns
      ) {
        throw new Error(
          "The database is missing the league settings columns. Run the Supabase migration before saving.",
        );
      }

      const leagueUpdatePayload: {
        name: string;
        number_of_players?: number;
      } = {
        name: trimmedLeagueName,
      };

      if (latestSupportsNumberOfPlayers) {
        leagueUpdatePayload.number_of_players = normalizedPlayers;
      }

      const { error: leagueError } = await supabase
        .from("leagues")
        .update(leagueUpdatePayload)
        .eq("id", leagueId);

      if (leagueError) {
        throw new Error(leagueError.message);
      }

      const settingsPayload: {
        league_id: string;
        season_id: string;
        enable_transaction_costs?: boolean;
        transaction_cost?: number | null;
        admins_approve_trades?: boolean;
        owners_admins_vote_on_trades?: boolean;
      } = {
        league_id: leagueId,
        season_id: seasonId,
      };

      if (latestSupportsLeagueSettingsColumns) {
        settingsPayload.enable_transaction_costs = enableTransactionCosts;
        settingsPayload.transaction_cost = normalizedTransactionCost;
        settingsPayload.admins_approve_trades = adminsApproveTrades;
        settingsPayload.owners_admins_vote_on_trades =
          normalizedOwnersAdminsVoteOnTrades;
      } else {
        throw new Error(
          "League settings columns are not present in the live database. Please apply the required schema migration first.",
        );
      }

      const { error: settingsError } = await supabase
        .from("league_settings")
        .upsert(settingsPayload, { onConflict: "league_id, season_id" });

      if (settingsError) {
        throw new Error(settingsError.message);
      }

      if (latestSupportsSeasonName) {
        await saveSeasonName(leagueId, trimmedSeasonName);
      }

      originalSettingsRef.current = {
        leagueName: trimmedLeagueName,
        numberOfPlayers: normalizedPlayers,
        enableTransactionCosts,
        transactionCost: normalizedTransactionCost ?? 0,
        adminsApproveTrades,
        ownersAdminsVoteOnTrades: normalizedOwnersAdminsVoteOnTrades,
      };

      setHasUnsavedChanges(false);
      setSuccessMessage("League settings saved successfully.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save league settings.";
      setError(message);
      setHasUnsavedChanges(true);
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading league settings...
        </div>
      </main>
    );
  }

  if (accessAllowed === false) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-red-800 bg-red-950/30 p-8 text-sm text-red-200 shadow-xl shadow-slate-950/40">
          <h1 className="mb-2 text-2xl font-bold text-white">Access Denied</h1>
          <p>
            Only the league owner can manage league settings. Returning to your
            dashboard...
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">League Settings</h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  confirmLeaveWithoutSaving(() =>
                    router.push(
                      leagueId
                        ? `/dashboard?leagueId=${leagueId}`
                        : "/dashboard",
                    ),
                  )
                }
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
              >
                Back to league
              </button>

              <button
                type="button"
                disabled={!hasUnsavedChanges || isSaving}
                onClick={handleSaveChanges}
                className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </header>

        {hasUnsavedChanges && (
          <div className="rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            You have unsaved changes.
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="rounded-xl border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200">
            {successMessage}
          </div>
        )}

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  League name
                </label>
                <input
                  type="text"
                  value={leagueName}
                  onChange={(event) => {
                    setLeagueName(event.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                />
              </div>

              {supportsSeasonName && (
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-300">
                    Season name
                  </label>
                  <input
                    type="text"
                    maxLength={80}
                    value={seasonName}
                    onChange={(event) => {
                      setSeasonName(event.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    Optional. Replaces &quot;Season {seasonNumber ?? "N"}&quot;
                    across the league for the current season. Leave blank to
                    keep the numbered label.
                  </p>
                </div>
              )}

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Number of players
                </label>
                <input
                  type="number"
                  min={1}
                  value={numberOfPlayers}
                  onChange={(event) => {
                    setNumberOfPlayers(Number(event.target.value) || 1);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                />
              </div>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Enable Transaction Costs</span>
                <input
                  type="checkbox"
                  checked={enableTransactionCosts}
                  onChange={(event) => {
                    setEnableTransactionCosts(event.target.checked);
                    setHasUnsavedChanges(true);
                  }}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              {enableTransactionCosts && (
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-300">
                    Transaction Cost
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={transactionCost}
                    onChange={(event) => {
                      setTransactionCost(Number(event.target.value) || 0);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <div className="space-y-5">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Owner has to approve trades</span>
                <input
                  type="checkbox"
                  checked={adminsApproveTrades}
                  onChange={(event) => {
                    const nextValue = event.target.checked;
                    setAdminsApproveTrades(nextValue);
                    setHasUnsavedChanges(true);
                    if (!nextValue) {
                      setOwnersAdminsVoteOnTrades(false);
                    }
                  }}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Owners/Admins vote on approving trades</span>
                <input
                  type="checkbox"
                  checked={ownersAdminsVoteOnTrades}
                  disabled={!adminsApproveTrades}
                  onChange={(event) => {
                    setOwnersAdminsVoteOnTrades(event.target.checked);
                    setHasUnsavedChanges(true);
                  }}
                  className="h-4 w-4 accent-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </label>

              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
                <p className="font-medium text-slate-200">Approval logic</p>
                <p className="mt-2 text-slate-400">
                  {adminsApproveTrades
                    ? "Trade approval is enabled. Voting requires a majority of owners and admins when the voting option is turned on."
                    : "Trade approval is currently disabled for this league."}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">
                League Format &amp; Weekly Deadline
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                When the deadline passes, unreported matches are settled and the
                league moves on to the next week automatically.
              </p>
            </div>

            <button
              type="button"
              disabled={isDeadlineSaving || !deadlineSettings}
              onClick={handleSaveDeadline}
              className="self-start rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isDeadlineSaving ? "Saving..." : "Save format & deadline"}
            </button>
          </div>

          {!deadlineSettings && (
            <div className="mt-4 rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
              This section needs the weekly deadline migration. Run supabase db
              push, then reload.
            </div>
          )}

          {deadlineSettings?.regular_season_completed_at && (
            <div className="mt-4 rounded-xl border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
              The regular season is complete, so the weekly deadline no longer
              advances weeks. The playoff bracket is managed from the schedule
              page.
            </div>
          )}

          {deadlineError && (
            <div className="mt-4 rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
              {deadlineError}
            </div>
          )}

          {deadlineMessage && (
            <div className="mt-4 rounded-xl border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200">
              {deadlineMessage}
            </div>
          )}

          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  League format
                </label>
                <select
                  value={leagueFormat}
                  disabled={isDeadlineSaving}
                  onChange={(event) =>
                    setLeagueFormat(event.target.value as LeagueFormat)
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 disabled:opacity-50"
                >
                  <option value="6v6">6v6</option>
                  <option value="4v4">4v4</option>
                </select>
                <p className="mt-2 text-xs text-slate-400">
                  Pokemon per side. A match nobody reports by the deadline is a
                  double loss: both teams take the loss and{" "}
                  {forfeitDifferential} KO differential
                  {deadlineSettings?.match_format === "single"
                    ? " (single game)."
                    : "."}
                </p>
              </div>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Close each week automatically</span>
                <input
                  type="checkbox"
                  checked={deadlineEnabled}
                  disabled={isDeadlineSaving}
                  onChange={(event) => setDeadlineEnabled(event.target.checked)}
                  className="h-4 w-4 accent-amber-500 disabled:opacity-50"
                />
              </label>

              {deadlineEnabled && (
                <>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-300">
                      First deadline date
                    </label>
                    <input
                      type="date"
                      value={deadlineDate}
                      disabled={isDeadlineSaving}
                      onChange={(event) => setDeadlineDate(event.target.value)}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 disabled:opacity-50"
                    />
                    <p className="mt-2 text-xs text-slate-400">
                      The deadline repeats every 7 days from this date.
                    </p>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-300">
                      Deadline time
                    </label>
                    <input
                      type="time"
                      value={deadlineTime}
                      disabled={isDeadlineSaving}
                      onChange={(event) => setDeadlineTime(event.target.value)}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 disabled:opacity-50"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-300">
                      Time zone
                    </label>
                    <select
                      value={deadlineTimeZone}
                      disabled={isDeadlineSaving}
                      onChange={(event) =>
                        setDeadlineTimeZone(event.target.value)
                      }
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 disabled:opacity-50"
                    >
                      {timeZoneOptionElements}
                    </select>
                  </div>
                </>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
                <p className="font-medium text-slate-200">Deadline preview</p>
                {deadlineEnabled && deadlinePreview ? (
                  <p className="mt-2 text-slate-400">
                    First deadline:{" "}
                    <span className="text-slate-200">
                      {formatInTimeZone(deadlinePreview, deadlineTimeZone)}
                    </span>
                    , then every 7 days at {deadlineTime} ({deadlineTimeZone}).
                  </p>
                ) : (
                  <p className="mt-2 text-slate-400">
                    Automatic week closing is off. Matches stay open until they
                    are reported.
                  </p>
                )}
              </div>

              {deadlineSettings?.week_deadline_enabled && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
                  <p className="font-medium text-slate-200">Current state</p>
                  <ul className="mt-2 space-y-1 text-slate-400">
                    <li>
                      Week {Math.max(deadlineSettings.current_week, 1)} of{" "}
                      {deadlineSettings.regular_season_weeks || "?"}
                    </li>
                    <li>
                      Next saved deadline:{" "}
                      {nextDeadline
                        ? formatInTimeZone(nextDeadline, deadlineTimeZone)
                        : "not scheduled"}
                    </li>
                    {deadlineSettings.week_deadline_last_advanced_at && (
                      <li>
                        Last advanced:{" "}
                        {formatInTimeZone(
                          new Date(
                            deadlineSettings.week_deadline_last_advanced_at,
                          ),
                          deadlineTimeZone,
                        )}
                        {deadlineSettings.week_deadline_settled_matches > 0
                          ? `, settling ${deadlineSettings.week_deadline_settled_matches} unreported match(es)`
                          : ""}
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {progressState && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
                  <p className="font-medium text-slate-200">Week progression</p>
                  <p className="mt-1 text-slate-400">
                    Progress the week yourself instead of waiting for the
                    deadline. Unreported matches of the closing week are settled
                    as double losses, exactly as they would be automatically.
                  </p>

                  <ul className="mt-2 space-y-1 text-slate-400">
                    <li>
                      Week {progressState.current_week} of{" "}
                      {progressState.total_weeks || "?"}
                      {progressState.unreported_matches > 0
                        ? `, ${progressState.unreported_matches} unreported match(es)`
                        : ", every match reported"}
                    </li>
                    {progressState.regular_season_completed && (
                      <li>
                        The regular season is complete
                        {progressState.playoffs_started
                          ? " and the playoffs have started."
                          : "; the bracket is waiting to open."}
                      </li>
                    )}
                    {progressState.latest_progress && (
                      <li>
                        Last progression: week{" "}
                        {progressState.latest_progress.from_week} to{" "}
                        {progressState.latest_progress.to_week}
                        {progressState.latest_progress.source === "manual"
                          ? " (manual)"
                          : " (weekly deadline)"}
                        {progressState.latest_progress.settled_count > 0
                          ? `, settling ${progressState.latest_progress.settled_count} unreported match(es)`
                          : ""}
                      </li>
                    )}
                  </ul>

                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      type="button"
                      disabled={
                        isProgressing || isDeadlineSaving || !progressState.can_progress
                      }
                      onClick={handleProgressWeek}
                      className="rounded-xl border border-sky-700 bg-sky-900/40 px-4 py-2 text-sm font-medium text-sky-100 transition hover:border-sky-500 hover:bg-sky-800/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isProgressing ? "Working..." : "Progress week"}
                    </button>
                    <button
                      type="button"
                      disabled={
                        isProgressing || isDeadlineSaving || !progressState.can_undo
                      }
                      onClick={handleUndoProgressWeek}
                      className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Undo progress week
                    </button>
                  </div>

                  {progressState.regular_season_completed && (
                    <p className="mt-2 text-slate-400">
                      The regular season is frozen, so there is no week left to
                      progress. Later playoff rounds are moved by hand.
                    </p>
                  )}

                  {!progressState.can_undo && progressState.latest_progress === null && (
                    <p className="mt-2 text-slate-400">
                      Nothing to undo yet. Undo becomes available after the first
                      week progression.
                    </p>
                  )}
                </div>
              )}

              {deadlineSettings?.week_deadline_paused && (
                <div className="rounded-xl border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-200">
                  The deadline is paused, so no week closes while it stays
                  paused. Resuming after the deadline has already passed closes
                  the current week.
                </div>
              )}

              {deadlineSettings?.week_deadline_enabled && (
                <button
                  type="button"
                  disabled={isDeadlineSaving}
                  onClick={() =>
                    handleToggleDeadlinePause(
                      !deadlineSettings.week_deadline_paused,
                    )
                  }
                  className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deadlineSettings.week_deadline_paused
                    ? "Resume deadline"
                    : "Pause deadline"}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
