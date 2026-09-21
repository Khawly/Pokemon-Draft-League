/*
 * Create League page for the Pokemon Draft League.
 *
 * Captures the league name and player count, creates the league through
 * Supabase, then navigates to the dashboard scoped to the new league.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createLeagueForUser } from "@/lib/supabase/leagues";

/**
 * Renders the create-league form and submits it to createLeagueForUser on
 * success, landing on the dashboard with the new league selected.
 *
 * @returns The create-league page content.
 */
export default function CreateLeaguePage() {
  const router = useRouter();
  const [leagueName, setLeagueName] = useState("");
  const [numberOfPlayers, setNumberOfPlayers] = useState(8);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreateLeague() {
    try {
      setIsCreating(true);
      setError(null);

      // Create the league, then navigate to the dashboard pre-selecting it.
      const result = await createLeagueForUser({
        name: leagueName,
        numberOfPlayers,
      });

      router.push(`/dashboard?leagueId=${result.leagueId}`);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to create the league.";
      setError(message);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl shadow-slate-950/40">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">
          Create New League
        </p>
        <h1 className="mt-3 text-3xl font-bold text-white">
          Start a new league
        </h1>

        <div className="mt-8 space-y-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">
              League name
            </label>
            <input
              type="text"
              value={leagueName}
              onChange={(event) => setLeagueName(event.target.value)}
              placeholder="Indigo City Championship"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 focus:bg-slate-950"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">
              Number of players
            </label>
            <input
              type="number"
              min={2}
              max={50}
              value={numberOfPlayers}
              onChange={(event) =>
                setNumberOfPlayers(Math.max(2, Number(event.target.value) || 2))
              }
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 focus:bg-slate-950"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={isCreating || !leagueName.trim()}
              onClick={handleCreateLeague}
              className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? "Creating..." : "Create League"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
