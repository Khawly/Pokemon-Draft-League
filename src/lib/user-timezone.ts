/*
 * Resolves the time zone a member wants league timestamps rendered in.
 *
 * The choice lives on `profiles.timezone` so it follows the user across devices
 * rather than tracking whichever device happens to be open. Pages cannot afford a
 * profile round trip on every render, so the resolved zone is mirrored into
 * localStorage: the hook paints with the cached value (falling back to the
 * browser's own zone on a cold cache) and then reconciles against the profile in
 * the background. Saving from user settings updates the cache immediately, so a
 * zone change is visible on the next page without a reload.
 */
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { browserTimeZone } from "@/lib/datetime";

/** LocalStorage key holding the member's resolved display time zone. */
const USER_TIME_ZONE_STORAGE_KEY = "pokemon-draft-league:user-time-zone";

/**
 * Reads the display time zone cached by a previous page load or save.
 *
 * @returns The cached IANA time zone, or null when nothing is cached.
 */
export function cachedUserTimeZone(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(USER_TIME_ZONE_STORAGE_KEY);
    return stored && stored.trim() ? stored : null;
  } catch {
    // Private browsing modes can throw on storage access; fall back to the zone.
    return null;
  }
}

/**
 * Mirrors the resolved display time zone so later pages render correctly before
 * their profile query resolves.
 *
 * @param timeZone - IANA time zone to cache.
 */
export function cacheUserTimeZone(timeZone: string): void {
  if (typeof window === "undefined" || !timeZone) {
    return;
  }

  try {
    window.localStorage.setItem(USER_TIME_ZONE_STORAGE_KEY, timeZone);
  } catch {
    // A cache miss only costs a profile round trip, so it is not worth failing on.
  }
}

/**
 * The zone to render with right now, without waiting for the profile.
 *
 * @returns The cached zone, or the browser's zone on a cold cache.
 */
export function resolveDisplayTimeZone(): string {
  return cachedUserTimeZone() ?? browserTimeZone();
}

/**
 * Reads the signed-in member's saved display time zone and refreshes the cache.
 *
 * A profile that has never been configured falls back to the browser's zone
 * rather than the column's 'UTC' default, which is what a brand new account
 * wants; the value is not written back here so merely viewing a page never
 * persists a preference the member did not choose.
 *
 * @returns The IANA time zone to render league timestamps in.
 */
export async function loadUserTimeZone(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    return resolveDisplayTimeZone();
  }

  const { data } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("id", session.user.id)
    .maybeSingle();

  const stored = (data?.timezone as string | null | undefined)?.trim();
  const resolved = stored || browserTimeZone();

  cacheUserTimeZone(resolved);

  return resolved;
}

/**
 * Returns the display time zone for a page, seeded from cache and reconciled
 * against the profile once it loads.
 *
 * The initial value is resolved synchronously so the first paint already uses the
 * right zone instead of flashing the browser's.
 *
 * @returns The IANA time zone to render league timestamps in.
 */
export function useUserTimeZone(): string {
  const [timeZone, setTimeZone] = useState(resolveDisplayTimeZone);

  useEffect(() => {
    let cancelled = false;

    loadUserTimeZone()
      .then((resolved) => {
        if (!cancelled) {
          setTimeZone(resolved);
        }
      })
      .catch(() => {
        // Keep the cached or browser zone; a failed preference read is not fatal.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return timeZone;
}
