/*
 * Global application chrome.
 *
 * Renders the single top navigation bar inside the shared shell-data provider.
 * `useSearchParams` inside the provider needs a Suspense boundary, so the chrome
 * owns that boundary; the page content is rendered separately by the root
 * layout and is never blocked by shell loading.
 */
"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";

import { LeagueBusyNotice } from "@/components/league-busy-notice";
import { LeagueShellProvider } from "@/components/league-shell-context";
import { TopNav, TopNavSkeleton } from "@/components/top-nav";

/**
 * Renders the app-wide navigation chrome, or nothing on the auth landing page.
 *
 * @returns The top navigation bar.
 */
export function AppChrome() {
  const pathname = usePathname();

  // The landing page owns the full viewport and has no league context.
  if (pathname === "/") {
    return null;
  }

  return (
    <>
      <Suspense fallback={<TopNavSkeleton />}>
        <LeagueShellProvider>
          <TopNav />
        </LeagueShellProvider>
      </Suspense>
      <LeagueBusyNotice />
    </>
  );
}
