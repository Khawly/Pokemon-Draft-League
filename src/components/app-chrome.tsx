/*
 * Global application chrome.
 *
 * Renders the top bar and league sub-navigation inside one shared shell-data
 * provider. `useSearchParams` inside the provider needs a Suspense boundary, so
 * the chrome owns that boundary; the page content is rendered separately by the
 * root layout and is never blocked by shell loading.
 */
"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";

import { LeagueSubNav } from "@/components/league-sub-nav";
import { LeagueBusyNotice } from "@/components/league-busy-notice";
import { LeagueShellProvider } from "@/components/league-shell-context";
import { TopNav, TopNavSkeleton } from "@/components/top-nav";

/**
 * Renders the app-wide navigation chrome, or nothing on the auth landing page.
 *
 * @returns The top bar and league sub-navigation.
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
          <LeagueSubNav />
        </LeagueShellProvider>
      </Suspense>
      <LeagueBusyNotice />
    </>
  );
}
