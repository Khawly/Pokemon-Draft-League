/*
 * Sticky top navigation bar for the Pokemon Draft League app.
 *
 * Renders the league selector dropdown, settings menu, and home link.
 * Fetches the user's active league memberships from Supabase and
 * persists the last-selected league in localStorage.
 */
"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

/** A single entry in the settings dropdown, with optional visibility flags. */
type SettingsItem = {
  /** Display label shown in the dropdown. */
  label: string;
  /** Navigation path the entry points to. */
  path: string;
  /** When true, the entry only appears for league owners. */
  ownerOnly?: boolean;
  /** When true, the entry only appears while a league is selected. */
  requiresLeague?: boolean;
};

/** Menu entries for the settings dropdown. `ownerOnly` items are hidden from non-owners; `requiresLeague` items only show when a league is selected. */
const settingsItems: SettingsItem[] = [
  { label: "User Settings", path: "/settings" },
  { label: "Draft Settings", path: "/draft-settings", ownerOnly: true },
  { label: "League Settings", path: "/league-settings", ownerOnly: true },
  {
    label: "Members Settings",
    path: "/members-settings",
    requiresLeague: true,
  },
  {
    label: "Draft Pool",
    path: "/pool",
    requiresLeague: true,
  },
];

/** LocalStorage key used to persist the user's last-selected league across sessions. */
const SELECTED_LEAGUE_STORAGE_KEY = "pokemon-draft-league:selected-league";

/** Reads the selected league ID from localStorage, returning null if unavailable. */
function getStoredSelectedLeagueId() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(SELECTED_LEAGUE_STORAGE_KEY);
  } catch {
    return null;
  }
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isReady, setIsReady] = useState(false);

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
  }, [searchParams]);

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

    try {
      window.localStorage.setItem(SELECTED_LEAGUE_STORAGE_KEY, selectedLeague);
    } catch {
      // Ignore storage errors so the nav still works in restricted environments.
    }
  }, [selectedLeague]);

  // Only owners see settings that manage the current league.
  const isOwner =
    selectedLeague !== "create-league" &&
    leagueOptions.find((option) => option.id === selectedLeague)?.role ===
      "owner";

  const hasSelectedLeague =
    selectedLeague !== "create-league" && selectedLeague !== undefined;

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

  function handleLeagueChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextValue = event.target.value;

    if (nextValue === "create-league") {
      router.push("/create-league");
      return;
    }

    try {
      window.localStorage.setItem(SELECTED_LEAGUE_STORAGE_KEY, nextValue);
    } catch {
      // Ignore storage errors so the nav still works in restricted environments.
    }

    router.push(`/dashboard?leagueId=${nextValue}`);
  }

  function handleSettingsSelect(path: string) {
    setIsMenuOpen(false);

    if (!selectedLeague || selectedLeague === "create-league") {
      router.push(path);
      return;
    }

    const nextPath = path === "/settings" ? "/settings" : path;
    const targetUrl =
      path === "/settings"
        ? `${nextPath}?leagueId=${selectedLeague}`
        : `${nextPath}?leagueId=${selectedLeague}`;

    router.push(targetUrl);
  }

  return (
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => {
            if (!selectedLeague || selectedLeague === "create-league") {
              router.push("/dashboard");
              return;
            }

            router.push(`/dashboard?leagueId=${selectedLeague}`);
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
                <option value="create-league">Create New League</option>
              )}

              {leagueOptions.map((league) => (
                <option key={league.id} value={league.id}>
                  {league.label}
                </option>
              ))}

              <option value="create-league">Create New League</option>
            </select>
          </label>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setIsMenuOpen((current) => !current)}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-100 transition hover:border-slate-500 hover:bg-slate-800"
            aria-label="Open settings menu"
            title="Settings"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="h-5 w-5 fill-current"
            >
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.18l-2.39.96a7.03 7.03 0 0 0-1.63-.94L14.48 2.5a.5.5 0 0 0-.5-.5h-3.96a.5.5 0 0 0-.5.5l-.27 2.56c-.57.23-1.11.55-1.63.94l-2.39-.96a.5.5 0 0 0-.61.18L2.71 9.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 13.52a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.18l2.39-.96c.52.39 1.06.71 1.63.94l.27 2.56a.5.5 0 0 0 .5.5h3.96a.5.5 0 0 0 .5-.5l.27-2.56c.57-.23 1.11-.55 1.63-.94l2.39.96a.5.5 0 0 0 .61-.18l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
            </svg>
          </button>

          {isMenuOpen && (
            <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-slate-950/60">
              {settingsItems
                .filter(
                  (item) =>
                    (!item.ownerOnly || isOwner) &&
                    (!item.requiresLeague || hasSelectedLeague),
                )
                .map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => handleSettingsSelect(item.path)}
                    className="block w-full border-b border-slate-800 bg-slate-900 px-4 py-3 text-left text-sm text-slate-100 transition last:border-b-0 hover:bg-slate-800"
                  >
                    {item.label}
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
