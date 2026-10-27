/*
 * League settings menu for the Pokemon Draft League.
 *
 * The gear beside the season selector in the global league sub-navigation. Its
 * entries carry the league and season currently on screen, so opening League or
 * Draft Settings lands on the season the member is looking at rather than
 * resolving the newest one for itself.
 *
 * User settings deliberately live on the avatar in the top bar instead: that is
 * the one entry that is not about a league or a season.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Props for {@link LeagueSettingsMenu}. */
export interface LeagueSettingsMenuProps {
  /** The league whose settings are opened. */
  leagueId: string | null;
  /** The season on screen, carried into every season-scoped settings page. */
  seasonId: string | null;
  /** League settings are owner-only; members settings are not. */
  isOwner: boolean;
}

/**
 * Renders the gear button and its league/season settings menu.
 *
 * @param props - {@link LeagueSettingsMenuProps}
 * @returns The gear button and its dropdown.
 */
export function LeagueSettingsMenu({
  leagueId,
  seasonId,
  isOwner,
}: LeagueSettingsMenuProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [isOpen]);

  const items = [
    ...(isOwner
      ? [
          { label: "Draft Settings", slug: "draft-settings" },
          { label: "League Settings", slug: "league-settings" },
        ]
      : []),
    { label: "Members Settings", slug: "members-settings" },
  ];

  /**
   * Builds a settings route for the season on screen.
   *
   * @param slug - The settings route, e.g. "draft-settings".
   * @returns The route with the league and season attached.
   */
  function hrefFor(slug: string): string {
    const params = new URLSearchParams();

    if (leagueId) {
      params.set("leagueId", leagueId);
    }
    if (seasonId) {
      params.set("seasonId", seasonId);
    }

    const query = params.toString();
    return query ? `/${slug}?${query}` : `/${slug}`;
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-950 text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
        aria-label="Open settings menu"
        aria-expanded={isOpen}
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

      {isOpen && (
        <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-slate-950/60">
          {items.map((item) => (
            <button
              key={item.slug}
              type="button"
              onClick={() => {
                setIsOpen(false);
                router.push(hrefFor(item.slug));
              }}
              className="block w-full border-b border-slate-800 bg-slate-900 px-4 py-3 text-left text-sm text-slate-100 transition last:border-b-0 hover:bg-slate-800"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
