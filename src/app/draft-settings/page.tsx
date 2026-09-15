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
import { supabase } from "@/lib/supabase/client";

/**
 * Draft settings page that suspends rendering until the client-only
 * settings content has been resolved.
 */
export default function DraftSettingsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading draft settings...
          </div>
        </main>
      }
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
  const [draftFormat, setDraftFormat] = useState("snake");
  const [totalRounds, setTotalRounds] = useState(1);
  const [enableCosts, setEnableCosts] = useState(false);
  const [totalTokenSalary, setTotalTokenSalary] = useState(100);
  const [allowPerTeamSalary, setAllowPerTeamSalary] = useState(false);
  const [pickTimeLimit, setPickTimeLimit] = useState(5);
  const [autoPickOnTimeout, setAutoPickOnTimeout] = useState(false);
  const [skipPlayerOnTimeout, setSkipPlayerOnTimeout] = useState(false);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietHoursStart, setQuietHoursStart] = useState("20:00");
  const [quietHoursEnd, setQuietHoursEnd] = useState("09:00");
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const originalSettingsRef = useRef({
    draftFormat: "snake",
    totalRounds: 1,
    enableCosts: false,
    totalTokenSalary: 100,
    allowPerTeamSalary: false,
    pickTimeLimit: 5,
    autoPickOnTimeout: false,
    skipPlayerOnTimeout: false,
    quietHoursEnabled: false,
    quietHoursStart: "20:00",
    quietHoursEnd: "09:00",
  });

  useEffect(() => {
    /** Loads the active user's draft settings for the selected league and latest season. */
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

        setLeagueId(selectedLeagueId);

        const { data: seasonData, error: seasonError } = await supabase
          .from("seasons")
          .select("id")
          .eq("league_id", selectedLeagueId)
          .order("season_number", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (seasonError || !seasonData) {
          setSeasonId(null);
          return;
        }

        setSeasonId(seasonData.id);

        const { data: settingsData, error: settingsError } = await supabase
          .from("league_settings")
          .select("*")
          .eq("league_id", selectedLeagueId)
          .eq("season_id", seasonData.id)
          .maybeSingle();

        if (settingsError || !settingsData) {
          return;
        }

        const nextSettings = {
          draftFormat: settingsData.draft_format || "snake",
          totalRounds: settingsData.total_rounds || 1,
          enableCosts: Boolean(settingsData.enable_pokemon_costs),
          totalTokenSalary: settingsData.total_token_salary ?? 100,
          allowPerTeamSalary: Boolean(settingsData.allow_per_team_salary),
          pickTimeLimit: settingsData.pick_time_limit_minutes || 5,
          autoPickOnTimeout: Boolean(settingsData.auto_pick_on_timeout),
          skipPlayerOnTimeout: Boolean(settingsData.skip_player_on_timeout),
          quietHoursEnabled: Boolean(settingsData.quiet_hours_enabled),
          quietHoursStart: settingsData.quiet_hours_start_est || "20:00",
          quietHoursEnd: settingsData.quiet_hours_end_est || "09:00",
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
        setHasUnsavedChanges(false);
      } finally {
        setIsLoading(false);
      }
    }

    loadLeagueSettings();
  }, [router, searchParams]);

  /**
   * Saves the current draft settings via upsert for the active league/season,
   * or nulls out cost- and quiet-hour-related fields when those features are disabled.
   */
  async function handleSaveChanges() {
    if (!leagueId || !seasonId) {
      setError("Select a league before saving draft settings.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { error: saveError } = await supabase
        .from("league_settings")
        .upsert(
          {
            league_id: leagueId,
            season_id: seasonId,
            draft_format: draftFormat,
            total_rounds: Number(totalRounds) || 1,
            enable_pokemon_costs: enableCosts,
            total_token_salary: enableCosts
              ? Number(totalTokenSalary) || 0
              : null,
            allow_per_team_salary: allowPerTeamSalary,
            pick_time_limit_minutes: Number(pickTimeLimit) || 5,
            auto_pick_on_timeout: autoPickOnTimeout,
            skip_player_on_timeout: skipPlayerOnTimeout,
            quiet_hours_enabled: quietHoursEnabled,
            quiet_hours_start_est: quietHoursEnabled ? quietHoursStart : null,
            quiet_hours_end_est: quietHoursEnabled ? quietHoursEnd : null,
          },
          { onConflict: "league_id, season_id" },
        );

      if (saveError) {
        throw new Error(saveError.message);
      }

      originalSettingsRef.current = {
        draftFormat,
        totalRounds,
        enableCosts,
        totalTokenSalary,
        allowPerTeamSalary,
        pickTimeLimit,
        autoPickOnTimeout,
        skipPlayerOnTimeout,
        quietHoursEnabled,
        quietHoursStart,
        quietHoursEnd,
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

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading draft settings...
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
              <h1 className="text-3xl font-bold text-white">Draft Settings</h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
              >
                Update Draft Pool
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
                  value={totalRounds}
                  onChange={(event) => {
                    setTotalRounds(Number(event.target.value) || 1);
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
                    value={totalTokenSalary}
                    onChange={(event) => {
                      setTotalTokenSalary(Number(event.target.value) || 0);
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
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Pick time limit (minutes)
                </label>
                <input
                  type="number"
                  min={1}
                  value={pickTimeLimit}
                  onChange={(event) => {
                    setPickTimeLimit(Number(event.target.value) || 1);
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
                      Quiet hours start (EST)
                    </label>
                    <input
                      type="time"
                      value={quietHoursStart}
                      onChange={(event) => {
                        setQuietHoursStart(event.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-300">
                      Quiet hours end (EST)
                    </label>
                    <input
                      type="time"
                      value={quietHoursEnd}
                      onChange={(event) => {
                        setQuietHoursEnd(event.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
