/*
 * Rules page for a league (spec section 13).
 *
 * Shows the league's rules for the current season, which the league owner
 * authors by typing them into a text area or uploading a text file. Every other
 * member reads the same document. Saving goes through the owner-gated
 * `save_league_rules` RPC, so the page can offer the editor freely and let the
 * database refuse anyone who turns out not to be the owner.
 *
 * The document carries a last-updated timestamp, which is the minimum the spec
 * asks for in place of version history; it is shown next to the rules so a member
 * can tell whether what they are reading is current.
 */

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  loadRulesPageData,
  normalizeRulesText,
  saveLeagueRules,
  type LeagueRules,
} from "@/lib/supabase/rules";
import { useUserTimeZone } from "@/lib/user-timezone";
import { formatDateTimeInZone } from "@/lib/datetime";

/** LocalStorage key used by the top nav to persist the selected league. */
const SELECTED_LEAGUE_STORAGE_KEY = "pokemon-draft-league:selected-league";

/**
 * Entry point for the rules route.
 *
 * Wraps the content in a Suspense boundary so that useSearchParams meets Next.js's
 * client-side streaming requirement.
 *
 * @returns The rules page with a loading fallback.
 */
export default function RulesPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-6xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading rules...
          </div>
        </main>
      }
    >
      <RulesPageContent />
    </Suspense>
  );
}

/**
 * The interactive rules page.
 *
 * @returns The league's rules, with an editor for the owner.
 */
function RulesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const timeZone = useUserTimeZone();

  const [leagueName, setLeagueName] = useState<string>("");
  const [rules, setRules] = useState<LeagueRules | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (leagueId: string) => {
    const data = await loadRulesPageData(leagueId);
    setLeagueName(data.league?.name ?? "");
    setRules(data.rules);
    setIsOwner(!!data.league && data.league.ownerId === data.currentUserId);
    // Seeds the editor from what was saved, so opening the page never looks like
    // an unsaved change.
    setDraft(data.rules?.content ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function resolveLeagueId(): Promise<string | null> {
      const fromQuery = searchParams.get("leagueId");
      if (fromQuery) {
        return fromQuery;
      }

      try {
        const cached =
          window.localStorage.getItem(SELECTED_LEAGUE_STORAGE_KEY) ?? null;
        if (cached) {
          return cached;
        }
      } catch {
        // Private browsing can throw on storage access; fall through to a lookup.
      }

      const { data: memberships } = await supabase
        .from("league_members")
        .select("league_id")
        .eq("is_active", true)
        .order("joined_at", { ascending: false })
        .limit(1);

      return memberships?.[0]?.league_id ?? null;
    }

    async function run() {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.replace("/");
          return;
        }

        const leagueId = await resolveLeagueId();
        if (!leagueId) {
          setError("Select a league before opening the rules.");
          return;
        }

        const data = await loadRulesPageData(leagueId);
        if (cancelled) {
          return;
        }
        setLeagueName(data.league?.name ?? "");
        setRules(data.rules);
        setIsOwner(!!data.league && data.league.ownerId === data.currentUserId);
        setDraft(data.rules?.content ?? "");
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "The league rules could not be loaded.",
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  /**
   * Saves the editor's contents through the owner-gated RPC.
   */
  async function handleSave() {
    if (!isOwner || isSaving) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const leagueId = searchParams.get("leagueId");
      if (!leagueId) {
        throw new Error("Select a league before saving the rules.");
      }

      const updatedAt = await saveLeagueRules(leagueId, draft);

      // Re-read rather than patching locally: the RPC decides what blank content
      // means (it clears the document), so what is stored may not be what was typed.
      await load(leagueId);
      setRules((current) =>
        current ? { ...current, updatedAt } : current,
      );
      setNotice("Rules saved.");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save the league rules.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  /**
   * Reads an uploaded text file into the editor.
   *
   * The file's contents become the rules text itself rather than being stored
   * alongside it, so there is a single source of truth for what the page displays
   * and no second artifact that can drift from it.
   */
  async function handleFile(file: File) {
    setError(null);
    setNotice(null);

    try {
      setDraft(normalizeRulesText(await file.text()));
      setNotice(
        `Loaded ${file.name}. Review it, then save to publish the change.`,
      );
    } catch {
      setError("That file could not be read. Try a plain text file.");
    }
  }

  const savedContent = rules?.content ?? "";
  const hasUnsavedChanges = isOwner && draft !== savedContent;

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-6xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading rules...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">
            Rules
          </p>
          <h1 className="mt-2 text-3xl font-bold text-white">
            {leagueName || "League rules"}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {isOwner
              ? "Set the rules for this season. Members see them as soon as you save."
              : "The rules the league owner has set for this season."}
          </p>
        </header>

        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {isOwner && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <h2 className="text-lg font-semibold text-white">Edit rules</h2>
            <p className="mt-1 text-sm text-slate-400">
              Type the rules below, or load them from a text file. Nothing is
              published until you save.
            </p>

            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice(null);
              }}
              rows={16}
              spellCheck={false}
              placeholder="Draft order, roster size, match reporting, tiebreakers..."
              className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-amber-400"
            />

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={isSaving || !hasUnsavedChanges}
                onClick={handleSave}
                className="rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isSaving ? "Saving..." : "Save rules"}
              </button>

              <label className="cursor-pointer rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700">
                Load a text file
                <input
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Cleared so re-picking the same file fires change again.
                    event.target.value = "";
                    if (file) {
                      void handleFile(file);
                    }
                  }}
                />
              </label>

              {hasUnsavedChanges && (
                <span className="text-sm text-amber-300">Unsaved changes</span>
              )}
            </div>

            {notice && (
              <p className="mt-3 text-sm text-emerald-300">{notice}</p>
            )}
          </section>
        )}

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-white">League rules</h2>
            {rules && (
              <p className="text-xs text-slate-500">
                Last updated {formatDateTimeInZone(rules.updatedAt, timeZone)}
                {rules.authorName ? ` by ${rules.authorName}` : ""}
              </p>
            )}
          </div>

          {savedContent ? (
            /*
              whitespace-pre-wrap so the owner's own line breaks and indentation
              survive; the rules are authored as plain text and re-flowing them
              would quietly change what they say.
            */
            <div className="mt-4 whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm leading-relaxed text-slate-200">
              {savedContent}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
              {isOwner
                ? "No rules have been set for this season yet."
                : "The league owner has not set any rules for this season yet."}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}