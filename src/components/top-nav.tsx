/*
 * Sticky top navigation bar for the Pokemon Draft League app.
 *
 * Renders the league selector, the user avatar that opens user settings, and
 * the home link. League/season settings live beside the season selector on the
 * dashboard, where the season they apply to is visible.
 * Fetches the user's active league memberships from Supabase and
 * persists the last-selected league in localStorage.
 */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { confirmDiscardUnsavedChanges } from "@/lib/unsaved-changes";
import { getSelectedLeague, setSelectedLeague } from "@/lib/league-selection";
import { MemberAvatar } from "@/components/member-avatar";

/** Reads the selected league ID from localStorage, returning null if unavailable. */
function getStoredSelectedLeagueId() {
  return getSelectedLeague();
}

/**
 * Top navigation bar that wraps content in a Suspense boundary.
 *
 * Renders a skeleton placeholder while search params are loading,
 * then delegates to {@link TopNavContent}.
 * @returns The sticky header element.
 */
export function TopNav() {
  return (
    <Suspense
      fallback={
        <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="h-10 w-20 rounded-xl border border-slate-700 bg-slate-900" />
            <div className="flex-1 px-2">
              <div className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900" />
            </div>
            <div className="h-10 w-10 rounded-xl border border-slate-700 bg-slate-900" />
          </div>
        </header>
      }
    >
      <TopNavContent />
    </Suspense>
  );
}

function TopNavContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [leagueOptions, setLeagueOptions] = useState<
    Array<{ id: string; label: string; role: string }>
  >([]);
  const [isReady, setIsReady] = useState(false);
  /**
   * The signed-in member's identity, used for the avatar button that opens user
   * settings. Read here rather than from the page because the bar is global.
   */
  const [profile, setProfile] = useState<{
    displayName: string | null;
    avatarUrl: string | null;
    avatarInitials: string | null;
    nameColor: string | null;
  }>({
    displayName: null,
    avatarUrl: null,
    avatarInitials: null,
    nameColor: null,
  });

  /**
   * Reloads the signed-in member's identity for the avatar button.
   *
   * Kept separate from the league list so a profile edit can refresh the picture
   * without re-reading every membership.
   */
  const loadProfile = useCallback(async () => {
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return;
    }

    const { data: profileRow } = await supabase
      .from("profiles")
      .select("display_name, avatar_url, avatar_initials, name_color")
      .eq("id", user.id)
      .maybeSingle();

    const identity = profileRow as {
      display_name: string | null;
      avatar_url: string | null;
      avatar_initials: string | null;
      name_color: string | null;
    } | null;

    setProfile({
      displayName: identity?.display_name ?? null,
      avatarUrl: identity?.avatar_url ?? null,
      avatarInitials: identity?.avatar_initials ?? null,
      nameColor: identity?.name_color ?? null,
    });
  }, []);

  // The bar lives in the root layout and survives a navigation, so a profile saved
  // on the settings page tells it to re-read rather than leaving a stale picture.
  useEffect(() => {
    function handleProfileUpdated() {
      void loadProfile();
    }

    window.addEventListener("profile-updated", handleProfileUpdated);
    return () =>
      window.removeEventListener("profile-updated", handleProfileUpdated);
  }, [loadProfile]);

  useEffect(() => {
    async function loadLeagueOptions() {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setLeagueOptions([]);
        return;
      }

      // The avatar is read alongside the memberships that fill the league select.
      await loadProfile();

      const { data, error } = await supabase
        .from("league_members")
        .select("league_id, role, leagues(name)")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("joined_at", { ascending: false });

      if (error) {
        setLeagueOptions([]);
        setIsReady(true);
        return;
      }

      const mapped = (data ?? [])
        .map((entry) => ({
          id: entry.league_id,
          label:
            (entry as { leagues?: { name?: string | null } }).leagues?.name ||
            "Untitled League",
          role: (entry as { role?: string | null }).role || "member",
        }))
        .filter((entry) => entry.id && entry.label);

      setLeagueOptions(mapped);
      setIsReady(true);
    }

    loadLeagueOptions();
  }, [loadProfile, searchParams]);

  const selectedLeague = useMemo(() => {
    // "create-league" is a sentinel value indicating no league is selected yet.
    if (pathname?.startsWith("/create-league")) {
      return "create-league";
    }

    // URL search param takes priority over localStorage.
    const selectedLeagueId = searchParams.get("leagueId");

    if (selectedLeagueId) {
      return selectedLeagueId;
    }

    // Fall back to the user's most recent league if available.
    const storedLeagueId = getStoredSelectedLeagueId();
    if (
      storedLeagueId &&
      leagueOptions.some((option) => option.id === storedLeagueId)
    ) {
      return storedLeagueId;
    }

    if (leagueOptions.length === 0) {
      return "create-league";
    }

    return leagueOptions[0].id;
  }, [leagueOptions, pathname, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!selectedLeague || selectedLeague === "create-league") {
      return;
    }

    setSelectedLeague(selectedLeague);
  }, [selectedLeague]);

  if (pathname === "/") {
    return null;
  }

  if (!isReady) {
    return (
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="h-10 w-20 rounded-xl border border-slate-700 bg-slate-900" />
          <div className="flex-1 px-2">
            <div className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900" />
          </div>
          <div className="h-10 w-10 rounded-xl border border-slate-700 bg-slate-900" />
        </div>
      </header>
    );
  }

  /*
   * The single exit point for every navigation this bar performs.
   *
   * `beforeunload` cannot cover these: they are client-side transitions that never
   * unload the document, so the browser's own "leave site?" dialog never appears and
   * a settings form with unsaved edits would vanish without a word. Asking the dirty
   * page first is what makes the warning actually fire on the way out of a form.
   *
   * Navigating to the page already open is left unguarded on purpose. A member on
   * /settings who picks "User Settings" from this very menu is not leaving anything,
   * and prompting them to discard edits they are still editing would be wrong.
   */
  async function navigate(href: string) {
    const targetPath = href.split("?")[0];

    if (targetPath !== pathname) {
      const allowed = await confirmDiscardUnsavedChanges();

      if (!allowed) {
        return;
      }
    }

    router.push(href);
  }

  async function handleLeagueChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextValue = event.target.value;

    if (nextValue === "create-league") {
      await navigate("/create-league");
      return;
    }

    /*
     * Written only after the dirty page has agreed to let go. Persisting the choice
     * first and then being cancelled would leave the stored league pointing
     * somewhere the member never actually navigated to.
     */
    const target = `/dashboard?leagueId=${nextValue}`;
    const targetPath = target.split("?")[0];

    if (targetPath !== pathname) {
      const allowed = await confirmDiscardUnsavedChanges();

      if (!allowed) {
        return;
      }
    }

    setSelectedLeague(nextValue);

    await navigate(target);
  }

  return (
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => {
            if (!selectedLeague || selectedLeague === "create-league") {
              void navigate("/dashboard");
              return;
            }

            void navigate(`/dashboard?leagueId=${selectedLeague}`);
          }}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-100 transition hover:border-slate-500 hover:bg-slate-800"
          aria-label="Go home"
          title="Home"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-5 w-5 fill-current"
          >
            <path d="M12 3.3 3 10.5v9.2a1.3 1.3 0 0 0 1.3 1.3h5.6v-6.3h4.2v6.3h5.6A1.3 1.3 0 0 0 21 19.7v-9.2L12 3.3Zm0-2.2 10.6 7.8c.5.4.9 1.1.9 1.7v10.2A3.3 3.3 0 0 1 20.2 21H15v-6.3a1.3 1.3 0 0 0-1.3-1.3h-3.4a1.3 1.3 0 0 0-1.3 1.3V21H3.8A3.3 3.3 0 0 1 .5 17.7V10.5c0-.6.3-1.3.8-1.7L12 1.1Z" />
          </svg>
        </button>

        <div className="flex-1 px-2">
          <label className="block">
            <span className="sr-only">League menu</span>
            <select
              value={selectedLeague}
              onChange={handleLeagueChange}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-100 outline-none transition focus:border-amber-400"
              aria-label="League dropdown"
            >
              {leagueOptions.length === 0 && (
                <option value="create-league">+ Create New League</option>
              )}

              {leagueOptions.map((league) => (
                <option key={league.id} value={league.id}>
                  {league.label}
                </option>
              ))}

              <option value="create-league">+ Create New League</option>
            </select>
          </label>
        </div>

        <button
          type="button"
          onClick={() => {
            if (!selectedLeague || selectedLeague === "create-league") {
              void navigate("/settings");
              return;
            }

            void navigate(`/settings?leagueId=${selectedLeague}`);
          }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-900 transition hover:border-slate-500 hover:bg-slate-800"
          aria-label="User settings"
          title="User settings"
        >
          <MemberAvatar
            name={profile.displayName ?? "You"}
            avatarUrl={profile.avatarUrl}
            initials={profile.avatarInitials}
            color={profile.nameColor}
            size={32}
            textClassName="text-xs"
          />
        </button>
      </div>
    </header>
  );
}
