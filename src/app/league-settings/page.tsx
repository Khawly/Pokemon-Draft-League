/*
 * League settings page for the Pokemon Draft League.
 *
 * Lets an authorized user edit league metadata (name, player count) and
 * transaction/trade rules for the active season, persisting changes via Supabase.
 */
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

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
  const [accessAllowed, setAccessAllowed] = useState<boolean | null>(null);
  const [leagueName, setLeagueName] = useState("");
  const [numberOfPlayers, setNumberOfPlayers] = useState(10);
  const [isLoading, setIsLoading] = useState(true);
  const [supportsNumberOfPlayers, setSupportsNumberOfPlayers] = useState(false);
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

        const { data: seasonData, error: seasonError } = await supabase
          .from("seasons")
          .select("id")
          .eq("league_id", activeLeagueId)
          .order("season_number", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (seasonError || !seasonData) {
          setSeasonId(null);
          return;
        }

        setSeasonId(seasonData.id);

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
          <h1 className="mb-2 text-2xl font-bold text-white">
            Access Denied
          </h1>
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
      </div>
    </main>
  );
}
