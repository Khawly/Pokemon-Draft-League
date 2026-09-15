/*
 * League invite page for the Pokemon Draft League.
 *
 * Validates an invite token, checks the viewer's session and league
 * membership, and lets a signed-in non-member accept the invite.
 */

"use client";

import { Suspense, use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  getLeagueInviteInfo,
  joinLeagueByInvite,
  type LeagueInviteInfo,
} from "@/lib/supabase/invites";

/**
 * Invite landing page that streams the invite content inside a Suspense
 * boundary while the token is validated.
 *
 * @param props - Component props.
 * @param props.params - Next.js async route params resolving to the invite token.
 */
export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
          <div className="rounded-2xl border border-slate-700 bg-slate-900 px-6 py-4 text-sm text-slate-300 shadow-lg shadow-slate-950/40">
            Loading invite...
          </div>
        </main>
      }
    >
      <InviteContent params={params} />
    </Suspense>
  );
}

/**
 * Validates the invite token, the viewer's session, and their membership, then
 * renders the join / sign-in / already-member UI.
 *
 * @param props - Component props.
 * @param props.params - Next.js async route params resolving to the invite token.
 */
function InviteContent({ params }: { params: Promise<{ token: string }> }) {
  // Next 16 async params pattern: params is a Promise, so unwrap it with use().
  const { token } = use(params);
  const router = useRouter();
  const [info, setInfo] = useState<LeagueInviteInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [alreadyMember, setAlreadyMember] = useState<boolean | null>(null);
  const [joined, setJoined] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        // Validate the invite token and surface readable errors for bad/expired links.
        const inviteInfo = await getLeagueInviteInfo(token);

        if (!inviteInfo) {
          setError(
            "This invite link is invalid or has been revoked. Ask the league owner for a new link.",
          );
          return;
        }

        if (inviteInfo.is_expired) {
          setError("This invite link has expired. Ask the league owner for a new link.");
          return;
        }

        setInfo(inviteInfo);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          setSignedIn(false);
          return;
        }

        setSignedIn(true);

        // Determine whether the signed-in viewer is already an active member.
        const { data: membership } = await supabase
          .from("league_members")
          .select("is_active")
          .eq("league_id", inviteInfo.league_id)
          .eq("user_id", user.id)
          .maybeSingle();

        setAlreadyMember(Boolean(membership && (membership as { is_active: boolean }).is_active));
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "This invite link could not be validated.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, [token]);

  /**
   * Accepts the invite by joining the league for the current user.
   */
  async function handleJoinLeague() {
    if (!info || isJoining) {
      return;
    }

    setIsJoining(true);
    setError(null);

    try {
      const result = await joinLeagueByInvite(token);

      if (!result) {
        throw new Error("Unable to join this league.");
      }

      setJoined(true);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to join this league.";
      setError(message);
    } finally {
      setIsJoining(false);
    }
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <div className="rounded-2xl border border-slate-700 bg-slate-900 px-6 py-4 text-sm text-slate-300 shadow-lg shadow-slate-950/40">
          Loading invite...
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 text-slate-100">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center shadow-2xl shadow-slate-950/40">
        {error && !info && (
          <>
            <p className="text-4xl" aria-hidden="true">
              🥚
            </p>
            <h1 className="mt-4 text-2xl font-bold text-white">
              Invite not found
            </h1>
            <p className="mt-3 text-sm text-slate-300">{error}</p>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="mt-6 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
            >
              Go home
            </button>
          </>
        )}

        {info && (
          <>
            <p className="text-4xl" aria-hidden="true">
              ⚔️
            </p>
            <p className="mt-4 text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">
              You&apos;re invited to
            </p>
            <h1 className="mt-2 text-3xl font-bold text-white">
              {info.league_name}
            </h1>
            <p className="mt-3 text-sm text-slate-400">
              {info.member_count} trainer{info.member_count === 1 ? "" : "s"}{" "}
              are already in this league.
            </p>

            {error && (
              <div className="mt-4 rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            {signedIn === false && (
              <div className="mt-6 space-y-2">
                <p className="text-sm text-slate-300">
                  Sign in to join this league.
                </p>
                <div className="flex justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => router.push("/")}
                    className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push("/")}
                    className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
                  >
                    Create account
                  </button>
                </div>
              </div>
            )}

            {signedIn === true && alreadyMember && (
              <div className="mt-6">
                <p className="text-sm text-emerald-300">
                  You&apos;re already in this league.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    router.push(`/dashboard?leagueId=${info.league_id}`)
                  }
                  className="mt-4 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
                >
                  Go to league
                </button>
              </div>
            )}

            {signedIn === true && !alreadyMember && (joined ? (
              <div className="mt-6">
                <p className="text-sm text-emerald-300">
                  Welcome to the league!
                </p>
                <button
                  type="button"
                  onClick={() =>
                    router.push(`/dashboard?leagueId=${info.league_id}`)
                  }
                  className="mt-4 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
                >
                  Go to league
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={isJoining}
                onClick={handleJoinLeague}
                className="mt-6 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isJoining ? "Joining..." : "Join League"}
              </button>
            ))}
          </>
        )}
      </div>
    </main>
  );
}