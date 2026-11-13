/*
 * Pre-draft preparation panel for the league dashboard.
 *
 * A league whose draft has not started shows almost nothing on the dashboard:
 * the standings, schedule, and roster panels all wait for the draft. This panel
 * fills that gap for the owner by naming the preparation tasks that can be done
 * first, linking each one to the page that owns it, and offering a one-click
 * copy of the invite link so players can join.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createLeagueInvite,
  getLatestLeagueInviteToken,
} from "@/lib/supabase/invites";
import { routeFor } from "@/lib/league-routes";

/** Props for the {@link PreDraftPanel} component. */
export interface PreDraftPanelProps {
  /** The league whose setup pages the panel links to. */
  leagueId: string;
  /**
   * The season on screen, carried into the season-scoped settings pages so they
   * open the season the dashboard is showing rather than resolving the newest.
   */
  seasonId?: string | null;
}

/**
 * Builds a settings route scoped to the league and season on screen.
 *
 * @param slug - The settings route, e.g. "league-settings".
 * @param leagueId - The league to open settings for.
 * @param seasonId - The season to open, or null to let the page resolve one.
 * @returns The route with its query string.
 */
function settingsRoute(
  slug: string,
  leagueId: string,
  seasonId?: string | null,
): string {
  const params = new URLSearchParams({ leagueId });

  if (seasonId) {
    params.set("seasonId", seasonId);
  }

  return `/${slug}?${params.toString()}`;
}

/** Props for the {@link PreDraftTask} component. */
interface PreDraftTaskProps {
  /** Short name of the task. */
  title: string;
  /** One or two sentences on what the task covers. */
  description: string;
  /** The controls that take the owner to where the task is done. */
  children: React.ReactNode;
}

/**
 * One row in the pre-draft panel: a task, why it matters, and where to do it.
 *
 * @param props - {@link PreDraftTaskProps}
 * @returns A bordered card containing the task's copy and actions.
 */
function PreDraftTask({ title, description, children }: PreDraftTaskProps) {
  return (
    <li className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="mt-1 flex-1 text-sm leading-relaxed text-slate-400">
        {description}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
    </li>
  );
}

/**
 * Owner guidance shown above the draft preview while the draft is pending.
 *
 * The panel deliberately carries no league state beyond the invite token: the
 * preparation tasks are the same for every pending draft, so there is nothing to
 * derive from the dashboard payload. The invite link is loaded here because
 * copying it is the one action the panel performs itself.
 *
 * @param props - {@link PreDraftPanelProps}
 * @returns The pre-draft preparation panel.
 */
export function PreDraftPanel({ leagueId, seasonId }: PreDraftPanelProps) {
  const router = useRouter();
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [isInviteLoading, setIsInviteLoading] = useState(true);
  const [isCopying, setIsCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  /*
   * Read any existing invite as soon as the panel appears, so the copy button
   * works on the first click. A failure is left silent: pressing copy will try
   * again and report the error in the panel, which is where the owner is
   * looking rather than a dead link sitting in the page.
   */
  useEffect(() => {
    let cancelled = false;

    getLatestLeagueInviteToken(leagueId)
      .then((token) => {
        if (!cancelled) {
          setInviteToken(token);
        }
      })
      .catch(() => {
        // Left to the copy action, which creates a token if none is readable.
      })
      .finally(() => {
        if (!cancelled) {
          setIsInviteLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const inviteUrl =
    inviteToken && typeof window !== "undefined"
      ? `${window.location.origin}/invite/${inviteToken}`
      : null;

  /**
   * Copies the league's invite link, creating an invite the first time so a
   * brand-new league still has something to share.
   *
   * The existing token is reused when there is one, because an invite link
   * someone may already have shared must keep working; generating a new one on
   * every copy would silently break the links already sent out.
   */
  async function handleCopyInvite() {
    if (isCopying) {
      return;
    }

    setIsCopying(true);
    setInviteError(null);

    try {
      const token = inviteToken ?? (await createLeagueInvite(leagueId)).token;

      if (!inviteToken) {
        setInviteToken(token);
      }

      await navigator.clipboard.writeText(
        `${window.location.origin}/invite/${token}`,
      );

      setCopied(true);

      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }

      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 1600);
    } catch (caughtError) {
      setInviteError(
        caughtError instanceof Error
          ? caughtError.message
          : "The invite link could not be copied.",
      );
    } finally {
      setIsCopying(false);
    }
  }

  /** Shared style for the buttons that open another page. */
  const pageButtonClass =
    "rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700";

  return (
    <section className="rounded-2xl border border-amber-500/30 bg-slate-900/80 p-4 shadow-lg sm:p-6 shadow-slate-950/30">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">
        Before the draft
      </p>
      <h2 className="mt-2 text-xl font-bold text-white">
        Get your league ready
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-slate-400">
        The draft has not started yet. These are the things you can set up
        first, and where to do each one.
      </p>

      <ul className="mt-5 grid gap-3 md:grid-cols-2">
        <PreDraftTask
          title="Settings"
          description="Set the player count, match format, trade rules and weekly deadline, or tune the draft format, rounds, costs and pick the time limit."
        >
          <button
            type="button"
            onClick={() =>
              router.push(settingsRoute("league-settings", leagueId, seasonId))
            }
            className={pageButtonClass}
          >
            League settings
          </button>
          <button
            type="button"
            onClick={() =>
              router.push(settingsRoute("draft-settings", leagueId, seasonId))
            }
            className={pageButtonClass}
          >
            Draft settings
          </button>
        </PreDraftTask>

        <PreDraftTask
          title="Draft pool"
          description="Choose which Pokémon are available in the draft and assign each one its tier before picks begin."
        >
          <button
            type="button"
            onClick={() => router.push(routeFor("pool", leagueId))}
            className={pageButtonClass}
          >
            Set up draft pool
          </button>
        </PreDraftTask>

        <PreDraftTask
          title="League rules"
          description="Write the rules your trainers should read before the draft, from scheduling expectations to trade limits."
        >
          <button
            type="button"
            onClick={() => router.push(routeFor("rules", leagueId))}
            className={pageButtonClass}
          >
            Edit rules
          </button>
        </PreDraftTask>

        <PreDraftTask
          title="Invite trainers"
          description="Share the invite link so players can join, fill the open player slots, and see the league before the draft."
        >
          <button
            type="button"
            disabled={isInviteLoading || isCopying}
            onClick={() => void handleCopyInvite()}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCopying
              ? "Copying..."
              : copied
                ? "Copied!"
                : isInviteLoading
                  ? "Preparing link..."
                  : "Copy invite link"}
          </button>
        </PreDraftTask>
      </ul>

      {inviteError && (
        <p className="mt-3 text-xs text-rose-300">{inviteError}</p>
      )}

      {/*
        The URL is shown as well as copied, so a browser that refuses clipboard
        access still gives the owner a link they can select by hand instead of a
        button that appears to do nothing.
      */}
      {inviteUrl && (
        <p className="mt-3 break-all rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
          {inviteUrl}
        </p>
      )}

      <p className="mt-4 text-xs text-slate-500">
        Draft positions and the Start Draft button live on the{" "}
        <button
          type="button"
          onClick={() => router.push(routeFor("draftboard", leagueId))}
          className="font-medium text-amber-300 underline-offset-2 transition hover:underline"
        >
          Draft Board
        </button>
        .
      </p>
    </section>
  );
}
