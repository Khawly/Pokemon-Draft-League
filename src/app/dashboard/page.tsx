/*
 * Dashboard page for the Pokemon Draft League.
 *
 * Verifies the signed-in user's session, resolves the active league name, and
 * renders the dashboard shell with the user's profile and league context.
 */

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { supabase } from "@/lib/supabase/client";

/**
 * Streams the dashboard content behind a Suspense loading fallback so the
 * useSearchParams hook can be used without an error boundary.
 */
export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading dashboard...
          </div>
        </main>
      }
    >
      <DashboardPageContent />
    </Suspense>
  );
}

/**
 * Loads the current user's profile and active league name and renders the
 * DashboardShell. Redirects to the home page when there is no session.
 */
function DashboardPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessionUser, setSessionUser] = useState<{
    email: string | null;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);
  const [leagueName, setLeagueName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function syncSessionUser(
      session: Awaited<
        ReturnType<typeof supabase.auth.getSession>
      >["data"]["session"],
    ) {
      // Auth guard: bounce unsigned-in visitors back to the landing page.
      if (!session?.user) {
        router.replace("/");
        return;
      }

      const user = session.user;
      const displayName =
        (user.user_metadata?.display_name as string | undefined) ||
        user.email?.split("@")[0] ||
        "Trainer";

      const { data: profileData } = await supabase
        .from("profiles")
        .select("avatar_url")
        .eq("id", user.id)
        .maybeSingle();

      setSessionUser({
        email: user.email ?? "Unknown email",
        displayName,
        avatarUrl: (profileData?.avatar_url as string | null) ?? null,
      });
    }

    async function loadLeagueName() {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setLeagueName("League Name");
        return;
      }

      const selectedLeagueId = searchParams.get("leagueId");

      // Prefer the league from the query param, else the most recently joined active one.
      let query = supabase
        .from("league_members")
        .select("league_id, leagues(name)")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("joined_at", { ascending: false })
        .limit(1);

      if (selectedLeagueId) {
        query = supabase
          .from("league_members")
          .select("league_id, leagues(name)")
          .eq("user_id", user.id)
          .eq("league_id", selectedLeagueId)
          .eq("is_active", true)
          .limit(1);
      }

      const { data, error } = await query;

      if (error || !data || data.length === 0) {
        setLeagueName("League Name");
        return;
      }

      const nextLeagueName = (data[0] as { leagues?: { name?: string | null } })
        .leagues?.name;
      setLeagueName(nextLeagueName || "League Name");
    }

    async function loadSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await syncSessionUser(session);
      await loadLeagueName();
      setIsLoading(false);
    }

    loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      await syncSessionUser(session);
      await loadLeagueName();
    });

    const handleProfileUpdated = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await syncSessionUser(session);
      await loadLeagueName();
    };

    window.addEventListener("profile-updated", handleProfileUpdated);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("profile-updated", handleProfileUpdated);
    };
  }, [router, searchParams]);

  if (isLoading || !sessionUser || !leagueName) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_rgba(15,23,42,0.2)_30%,_#020817_100%)] px-4 py-10">
        <div className="rounded-2xl border border-slate-700 bg-slate-900 px-6 py-4 text-sm font-medium text-slate-200 shadow-lg shadow-slate-950/40">
          Loading the Home Page...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <DashboardShell
          displayName={sessionUser.displayName}
          email={sessionUser.email ?? "Unknown email"}
          avatarUrl={sessionUser.avatarUrl}
          leagueName={leagueName}
          leagueId={searchParams.get("leagueId") ?? null}
        />
      </div>
    </main>
  );
}
