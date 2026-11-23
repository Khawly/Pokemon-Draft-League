/*
 * Draft settings page for the Pokemon Draft League.
 *
 * Lets an authorized user configure draft rules (format, rounds, costs,
 * pick timeouts, and quiet hours) for a league's active season, persisting
 * them via Supabase.
 */
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  loadLeagueSettingsRow,
  saveLeagueSettingsRow,
} from "@/lib/supabase/league-settings";
import { loadUserTimeZone } from "@/lib/user-timezone";
import { useShellLeague } from "@/components/league-shell-context";
import { PageShell, PageShellError, PageShellLoading } from "@/components/page-shell";
import { getSelectedSeason } from "@/lib/season-selection";
import { isCurrentSeason as checkIsCurrentSeason, loadSeason } from "@/lib/supabase/seasons";
import { Card } from "@/components/card";
import { DateFieldWithCalendar } from "@/components/date-field-with-calendar";
import {
  browserTimeZone,
  datePartOfInputValue,
  formatTimeZoneLabel,
  fromZonedInputValue,
  timePartOfInputValue,
  toZonedInputValue,
  withInputValueDate,
  withInputValueTime,
} from "@/lib/datetime";
import { requireClock, requireInteger } from "@/lib/validation";

/**
 * Draft settings page that suspends rendering until the client-only
 * settings content has been resolved.
 */
export default function DraftSettingsPage() {
  return (
    <Suspense
      fallback={<PageShellLoading label="Loading draft settings" />}
    >
      <DraftSettingsPageContent />
    </Suspense>
  );
}

/**
 * Client component for editing and saving a league's draft settings.
 * Loads the current settings for the selected league and its most recent season.
 */
function DraftSettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const shellLeague = useShellLeague();
  /** True when the shell resolved no league for this member. */
  const shellLeagueMissing =
    !shellLeague.isResolving && !shellLeague.signedOut && !shellLeague.leagueId;

  useEffect(() => {
    if (shellLeague.signedOut) {
      router.replace("/");
    }
  }, [shellLeague.signedOut, router]);
  const [draftFormat, setDraftFormat] = useState("snake");
  /**
   * Kept as the raw input string so the field can be cleared while typing;
   * validation happens when the form is saved.
   */
  const [totalRounds, setTotalRounds] = useState("1");
  const [enableCosts, setEnableCosts] = useState(false);
  /**
   * Raw input string, like total rounds, so the field can be emptied while
   * typing; the numeric value is resolved when the form is saved.
   */
  const [totalTokenSalary, setTotalTokenSalary] = useState("100");
  const [allowPerTeamSalary, setAllowPerTeamSalary] = useState(false);
  /** Raw input string, so the pick limit can also be cleared while typing. */
  const [pickTimeLimit, setPickTimeLimit] = useState("5");
  const [autoPickOnTimeout, setAutoPickOnTimeout] = useState(false);
  const [skipPlayerOnTimeout, setSkipPlayerOnTimeout] = useState(false);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietHoursStart, setQuietHoursStart] = useState("20:00");
  const [quietHoursEnd, setQuietHoursEnd] = useState("09:00");
  /*
   * The scheduled draft start, held as one `datetime-local`-shaped string so the
   * date and time inputs cannot disagree. It is read and written in the member's
   * profile zone, the same zone the quiet hours clocks use.
   */
  const [draftAtInput, setDraftAtInput] = useState("");
  /*
   * The zone the quiet hours clocks and the draft date are read in. Left null
   * until the league's saved value is known, and defaulted to the owner's own
   * profile zone when there isn't one, so the values mean what the person
   * configuring them expects without them having to know they are stored as
   * bare wall clocks and an absolute instant.
   */
  const [userTimeZone, setUserTimeZone] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  /** False when the page is showing a finished season, which cannot be saved. */
  const [isCurrentSeason, setIsCurrentSeason] = useState(true);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const originalSettingsRef = useRef({
    draftFormat: "snake",
    totalRounds: "1",
    enableCosts: false,
    totalTokenSalary: "100",
    allowPerTeamSalary: false,
    pickTimeLimit: "5",
    autoPickOnTimeout: false,
    skipPlayerOnTimeout: false,
    quietHoursEnabled: false,
    quietHoursStart: "20:00",
    quietHoursEnd: "09:00",
    draftAtInput: "",
  });

  useEffect(() => {
    if (
      shellLeague.isResolving ||
      shellLeague.signedOut ||
      !shellLeague.leagueId
    ) {
      return;
    }

    const resolvedLeagueId = shellLeague.leagueId;

    /** Loads the active user's draft settings for the selected league and latest season. */
    async function loadLeagueSettings() {
      try {
        setLeagueId(resolvedLeagueId);

        const { data: seasonData, error: seasonError } = await loadSeason<{
          id: string;
        }>(
          resolvedLeagueId,
          "id",
          // The settings menu links carry the season on screen; direct visits fall back
          // to the last season the member chose, and then to the newest.
          searchParams.get("seasonId") ??
            getSelectedSeason(resolvedLeagueId),
        );

        if (seasonError || !seasonData) {
          setSeasonId(null);
          return;
        }

        setSeasonId(seasonData.id);
        setIsCurrentSeason(
          await checkIsCurrentSeason(resolvedLeagueId, seasonData.id),
        );

        const settingsData = await loadLeagueSettingsRow(
          resolvedLeagueId,
          seasonData.id,
        );

        if (!settingsData) {
          return;
        }

        const userTimeZone = await loadUserTimeZone();
        const nextSettings = {
          draftFormat: settingsData.draft_format || "snake",
          totalRounds: String(settingsData.total_rounds || 1),
          enableCosts: Boolean(settingsData.enable_pokemon_costs),
          totalTokenSalary: String(settingsData.total_token_salary ?? 100),
          allowPerTeamSalary: Boolean(settingsData.allow_per_team_salary),
          pickTimeLimit: String(settingsData.pick_time_limit_minutes || 5),
          autoPickOnTimeout: Boolean(settingsData.auto_pick_on_timeout),
          skipPlayerOnTimeout: Boolean(settingsData.skip_player_on_timeout),
          quietHoursEnabled: Boolean(settingsData.quiet_hours_enabled),
          quietHoursStart: settingsData.quiet_hours_start_est || "20:00",
          quietHoursEnd: settingsData.quiet_hours_end_est || "09:00",
          draftAtInput: toZonedInputValue(settingsData.draft_at, userTimeZone),
          /*
           * Always the owner's live profile zone, never the value cached on the
           * settings row. draft_quiet_hours resolves the zone the same way on every
           * sweep, so reading the row here would have the page and the engine
           * disagreeing about the window, and a zone changed in user settings would
           * look like it had done nothing until draft settings were re-saved.
           */
          userTimeZone,
        };

        originalSettingsRef.current = nextSettings;
        setDraftFormat(nextSettings.draftFormat);
        setTotalRounds(nextSettings.totalRounds);
        setEnableCosts(nextSettings.enableCosts);
        setTotalTokenSalary(nextSettings.totalTokenSalary);
        setAllowPerTeamSalary(nextSettings.allowPerTeamSalary);
        setPickTimeLimit(nextSettings.pickTimeLimit);
        setAutoPickOnTimeout(nextSettings.autoPickOnTimeout);
        setSkipPlayerOnTimeout(nextSettings.skipPlayerOnTimeout);
        setQuietHoursEnabled(nextSettings.quietHoursEnabled);
        setQuietHoursStart(nextSettings.quietHoursStart);
        setQuietHoursEnd(nextSettings.quietHoursEnd);
        setDraftAtInput(nextSettings.draftAtInput);
        setUserTimeZone(nextSettings.userTimeZone);
        setHasUnsavedChanges(false);
      } finally {
        setIsLoading(false);
      }
    }

    loadLeagueSettings();
  }, [
    router,
    searchParams,
    shellLeague.leagueId,
    shellLeague.isResolving,
    shellLeague.signedOut,
  ]);

  /**
   * Saves the current draft settings via upsert for the active league/season,
   * or nulls out cost- and quiet-hour-related fields when those features are disabled.
   */
  async function handleSaveChanges() {
    if (!isCurrentSeason) {
      setError("This is a past season, so its draft settings cannot be changed.");
      return;
    }

    if (!leagueId || !seasonId) {
      setError("Select a league before saving draft settings.");
      return;
    }

    let parsedTotalRounds: number;
    let parsedTotalTokenSalary: number | null = null;
    let parsedPickTimeLimit: number;
    let parsedQuietHoursStart: string | null = null;
    let parsedQuietHoursEnd: string | null = null;

    try {
      if (draftFormat !== "snake" && draftFormat !== "set") {
        throw new Error("Choose a valid draft format.");
      }

      parsedTotalRounds = requireInteger(totalRounds, "Total rounds", 1);
      parsedTotalTokenSalary = enableCosts
        ? requireInteger(totalTokenSalary, "Total token salary", 0)
        : null;
      parsedPickTimeLimit = requireInteger(
        pickTimeLimit,
        "Pick time limit",
        1,
      );

      if (quietHoursEnabled) {
        parsedQuietHoursStart = requireClock(
          quietHoursStart,
          "Quiet hours start",
        );
        parsedQuietHoursEnd = requireClock(quietHoursEnd, "Quiet hours end");

        if (parsedQuietHoursStart === parsedQuietHoursEnd) {
          throw new Error(
            "Quiet hours start and end must be different times.",
          );
        }
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Check the draft settings before saving.",
      );
      return;
    }

    const draftDate = datePartOfInputValue(draftAtInput);
    const draftTime = timePartOfInputValue(draftAtInput);

    if ((draftDate && !draftTime) || (!draftDate && draftTime)) {
      setError("Choose both a date and a time for the draft, or clear both.");
      return;
    }

    const draftAt = draftAtInput
      ? fromZonedInputValue(draftAtInput, userTimeZone ?? browserTimeZone())
      : null;

    if (draftAtInput && !draftAt) {
      setError(
        "That draft date and time does not exist in your time zone. Pick another time.",
      );
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await saveLeagueSettingsRow({
        league_id: leagueId,
        season_id: seasonId,
        draft_format: draftFormat,
        total_rounds: parsedTotalRounds,
        enable_pokemon_costs: enableCosts,
        total_token_salary: enableCosts ? parsedTotalTokenSalary : null,
        allow_per_team_salary: allowPerTeamSalary,
        pick_time_limit_minutes: parsedPickTimeLimit,
        auto_pick_on_timeout: autoPickOnTimeout,
        skip_player_on_timeout: skipPlayerOnTimeout,
        quiet_hours_enabled: quietHoursEnabled,
        quiet_hours_start_est: quietHoursEnabled ? parsedQuietHoursStart : null,
        quiet_hours_end_est: quietHoursEnabled ? parsedQuietHoursEnd : null,
        draft_at: draftAt,
        /*
         * quiet_hours_timezone is deliberately not written from here.
         *
         * draft_quiet_hours resolves the zone from the league owner's profile on
         * every sweep, so this page has nothing to contribute and could only
         * contribute it wrongly: the value would come from a component state
         * seeded once on mount, so a tab left open across a zone change in user
         * settings would write the old zone back over the new one on the next
         * save. The column stays as the fallback the migration populated, for
         * the case where the owner has no usable profile zone at all.
         */
      });

      originalSettingsRef.current = {
        draftFormat,
        totalRounds: String(parsedTotalRounds),
        enableCosts,
        totalTokenSalary,
        allowPerTeamSalary,
        pickTimeLimit,
        autoPickOnTimeout,
        skipPlayerOnTimeout,
        quietHoursEnabled,
        quietHoursStart,
        quietHoursEnd,
        draftAtInput,
      };

      setHasUnsavedChanges(false);
      setSuccessMessage("Draft settings saved successfully.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save draft settings.";
      setError(message);
      setHasUnsavedChanges(true);
    } finally {
      setIsSaving(false);
    }
  }

  if (shellLeagueMissing) {
    return (
      <PageShellError>
        You are not a member of any active league.
      </PageShellError>
    );
  }

  if (isLoading) {
    return <PageShellLoading label="Loading draft settings" />;
  }

  return (
    <PageShell>
      <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-2xl sm:p-6 shadow-slate-950/40">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">Draft Settings</h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  router.push(
                    leagueId ? `/pool?leagueId=${leagueId}` : "/pool",
                  )
                }
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
              >
                Update Draft Pool
              </button>

              <button
                type="button"
                disabled={!isCurrentSeason || !hasUnsavedChanges || isSaving}
                onClick={handleSaveChanges}
                className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </header>

        {!isCurrentSeason && (
          <div className="rounded-2xl border border-sky-800/60 bg-sky-950/40 px-5 py-4 text-sm text-sky-200">
            <p className="font-semibold uppercase tracking-[0.15em] text-sky-300">
              Viewing history
            </p>
            <p className="mt-1">
              This is not the league&apos;s current season, so its draft settings
              are read-only. Switch to the current season from the dashboard to
              edit them.
            </p>
          </div>
        )}

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

        <fieldset
          disabled={!isCurrentSeason}
          className="min-w-0 border-0 p-0"
        >
          <Card className="p-4 shadow-lg sm:p-6 shadow-slate-950/30">
            <div>
              <h2 className="text-lg font-semibold text-white">
                Draft date and time
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                When the draft is scheduled to start. Every other member is
                notified when you set this, and the Draft Board shows it in their
                own time zone. The draft starts automatically at this time once
                all player slots, draft positions, and the pool are ready.
              </p>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <label
                  htmlFor="draft-date"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Draft date
                </label>
                <DateFieldWithCalendar
                  id="draft-date"
                  type="date"
                  value={datePartOfInputValue(draftAtInput)}
                  onChange={(value) => {
                    setDraftAtInput((current) =>
                      withInputValueDate(current, value),
                    );
                    setHasUnsavedChanges(true);
                  }}
                  disabled={isSaving}
                  ariaLabel="Draft date"
                />
              </div>

              <div>
                <label
                  htmlFor="draft-time"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Draft time
                </label>
                <input
                  id="draft-time"
                  type="time"
                  value={timePartOfInputValue(draftAtInput)}
                  onChange={(event) => {
                    setDraftAtInput((current) =>
                      withInputValueTime(current, event.target.value),
                    );
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                />
              </div>
            </div>

            <p className="mt-3 text-xs text-slate-500">
              Times are entered in{" "}
              <span className="font-medium text-slate-400">
                {formatTimeZoneLabel(userTimeZone ?? browserTimeZone())}
              </span>
              , from your user settings. Leave both fields empty to clear the
              scheduled date.
            </p>
          </Card>

          <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card className="p-4 shadow-lg sm:p-6 shadow-slate-950/30">
            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Draft format
                </label>
                <select
                  value={draftFormat}
                  onChange={(event) => {
                    setDraftFormat(event.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                >
                  <option value="snake">Snake</option>
                  <option value="set">Set</option>
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Total rounds
                </label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={totalRounds}
                  onChange={(event) => {
                    setTotalRounds(event.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                />
              </div>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Enable Costs for Pokémon</span>
                <input
                  type="checkbox"
                  checked={enableCosts}
                  onChange={(event) => {
                    setEnableCosts(event.target.checked);
                    setHasUnsavedChanges(true);
                  }}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              {enableCosts && (
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-300">
                    Total Token Salary
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={totalTokenSalary}
                    onChange={(event) => {
                      setTotalTokenSalary(event.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                  />
                </div>
              )}

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Players can have different Total Salary</span>
                <input
                  type="checkbox"
                  checked={allowPerTeamSalary}
                  onChange={(event) => {
                    setAllowPerTeamSalary(event.target.checked);
                    setHasUnsavedChanges(true);
                  }}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>
            </div>
          </Card>

          <Card className="p-4 shadow-lg sm:p-6 shadow-slate-950/30">
            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Pick time limit (minutes)
                </label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={pickTimeLimit}
                  onChange={(event) => {
                    setPickTimeLimit(event.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                />
              </div>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Auto-pick when time expires</span>
                <input
                  type="checkbox"
                  checked={autoPickOnTimeout}
                  onChange={(event) => {
                    setAutoPickOnTimeout(event.target.checked);
                    setHasUnsavedChanges(true);
                    // Auto-pick and skip-player are mutually exclusive.
                    if (event.target.checked) setSkipPlayerOnTimeout(false);
                  }}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Skip player when time runs out</span>
                <input
                  type="checkbox"
                  checked={skipPlayerOnTimeout}
                  onChange={(event) => {
                    setSkipPlayerOnTimeout(event.target.checked);
                    setHasUnsavedChanges(true);
                    // Auto-pick and skip-player are mutually exclusive.
                    if (event.target.checked) setAutoPickOnTimeout(false);
                  }}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <span>Quiet hours enabled</span>
                <input
                  type="checkbox"
                  checked={quietHoursEnabled}
                  onChange={(event) => {
                    setQuietHoursEnabled(event.target.checked);
                    setHasUnsavedChanges(true);
                  }}
                  className="h-4 w-4 accent-amber-500"
                />
              </label>

              {quietHoursEnabled && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-300">
                      Quiet hours start
                    </label>
                    <input
                      type="time"
                      value={quietHoursStart}
                      onChange={(event) => {
                        setQuietHoursStart(event.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      required
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-300">
                      Quiet hours end
                    </label>
                    <input
                      type="time"
                      value={quietHoursEnd}
                      onChange={(event) => {
                        setQuietHoursEnd(event.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      required
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                    />
                  </div>
                </div>
              )}

{/*
                  Spelled out because the clocks mean nothing without it. The zone is
                  read live from your user settings on every load, which is also how
                  the draft engine resolves it, so changing it there moves this
                  window without anything needing re-saving here.
                */}
              {quietHoursEnabled && (
                <p className="mt-3 text-xs text-slate-500">
                  Times are in{" "}
                  <span className="font-medium text-slate-400">
                    {userTimeZone ?? "UTC"}
                  </span>
                  , from your user settings. The draft is held for the whole window,
                  and anyone looking at the board sees it converted to their own zone.
                </p>
              )}
            </div>
          </Card>
        </section>
        </fieldset>
    </PageShell>
  );
}
