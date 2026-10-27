/*
 * Sticky top navigation bar for the Pokemon Draft League app.
 *
 * Renders the league selector, the user avatar that opens user settings, and
 * the home link. The profile, memberships, selected league, and loaded state all
 * come from the shared league shell provider, so this bar and the league sub-
 * navigation issue one set of shell queries per page load instead of two.
 *
 * League/season settings live beside the season selector in the league sub-
 * navigation below this bar, where the season they apply to is visible.
 */
"use client";

import { usePathname, useRouter } from "next/navigation";

import { MemberAvatar } from "@/components/member-avatar";
import { useLeagueShell } from "@/components/league-shell-context";
import { setSelectedLeague } from "@/lib/league-selection";
import { confirmDiscardUnsavedChanges } from "@/lib/unsaved-changes";

/**
 * Placeholder header shown while the shell identity and league list load, and
 * while Next.js resolves the client search params that the shell provider reads.
 *
 * @returns The skeleton top bar.
 */
export function TopNavSkeleton() {
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

/**
 * Sticky top navigation bar.
 *
 * @returns The header, a loading skeleton, or nothing outside the app shell.
 */
export function TopNav() {
  const router = useRouter();
  const pathname = usePathname();
  const { isReady, profile, leagueOptions, selectedLeague } = useLeagueShell();

  if (pathname === "/") {
    return null;
  }

  if (!isReady) {
    return <TopNavSkeleton />;
  }

  /*
   * The single exit point for every navigation this bar performs.
   *
   * `beforeunload` cannot cover client-side transitions, so a dirty settings
   * form would otherwise disappear without a warning. Navigating to the page
   * already open is left unguarded on purpose.
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

  async function handleLeagueChange(
    event: React.ChangeEvent<HTMLSelectElement>,
  ) {
    const nextValue = event.target.value;

    if (nextValue === "create-league") {
      await navigate("/create-league");
      return;
    }

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
          onClick={() => void navigate("/")}
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
