/*
 * Global application chrome.
 *
 * Renders the single top navigation bar and wraps both the bar and the page
 * content in the shared shell-data provider. Wrapping the pages is what lets
 * them read the identity, league, and season the bar already resolved instead
 * of repeating those queries themselves.
 *
 * The provider needs `useSearchParams`, which suspends. It handles that with an
 * internal boundary around a parameter bridge, so the pages under it still
 * render in the prerendered HTML rather than being replaced by a skeleton.
 */
"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { LeagueBusyNotice } from "@/components/league-busy-notice";
import { LeagueShellProvider } from "@/components/league-shell-context";
import { TopNav } from "@/components/top-nav";

/**
 * Renders the app-wide navigation chrome around the current page.
 *
 * @param props.children - The rendered page content.
 * @returns The top navigation bar and the page, or only the page on the auth
 *   landing route.
 */
export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // The landing page owns the full viewport and has no league context.
  if (pathname === "/") {
    return <>{children}</>;
  }

  return (
    <>
      <LeagueShellProvider>
        <TopNav />
        {children}
      </LeagueShellProvider>
      <LeagueBusyNotice />
    </>
  );
}
