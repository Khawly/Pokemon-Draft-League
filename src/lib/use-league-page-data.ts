/*
 * Shared load lifecycle for a page that shows one league.
 *
 * Every league page needs the same sequence: find the signed-in member's league,
 * load that league's payload, redirect a signed-out visitor, and track loading
 * and error state while it happens. Pages used to spell it out in a ~70-line
 * effect each. This hook owns the sequence once; a page supplies only its loader
 * and the two messages a failure can produce.
 *
 * The loader and post-load callback are held in refs, so a page can define them
 * inline (closing over its own state, season parameter, or filters) without
 * restarting the load on every render.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { resolveActiveLeague } from "@/lib/active-league";

/** Options for {@link useLeaguePageData}. */
export interface UseLeaguePageDataOptions<T> {
  /** The `leagueId` search param, or null when absent. */
  requestedLeagueId: string | null;
  /** Loads one league's payload. */
  load: (leagueId: string) => Promise<T>;
  /** Shown when no league can be resolved, e.g. "Select a league before opening X." */
  emptyLeagueMessage: string;
  /** Shown when the loader throws something that is not an Error. */
  fallbackErrorMessage: string;
  /**
   * Runs after every successful load, for state derived from the payload (a
   * default selection, a form mirror, a week summary).
   */
  onLoaded?: (data: T) => void;
}

/** State returned by {@link useLeaguePageData}. */
export interface LeaguePageData<T> {
  /** The loaded payload, or null before it arrives. */
  data: T | null;
  /** True until the first load settles. */
  isLoading: boolean;
  /** Display copy for a failed load or a refused action. */
  error: string | null;
  /** Lets an action handler report or clear an error. */
  setError: (message: string | null) => void;
  /** The league the payload belongs to, once resolved. */
  leagueId: string | null;
  /**
   * Reloads the resolved league and replaces the payload.
   *
   * @returns The fresh payload, or null when no league has been resolved yet.
   */
  reload: () => Promise<T | null>;
}

/**
 * Loads and tracks one league's page payload.
 *
 * @param options - {@link UseLeaguePageDataOptions}
 * @returns The payload plus its loading, error, and reload controls.
 */
export function useLeaguePageData<T>({
  requestedLeagueId,
  load,
  emptyLeagueMessage,
  fallbackErrorMessage,
  onLoaded,
}: UseLeaguePageDataOptions<T>): LeaguePageData<T> {
  const router = useRouter();

  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setErrorState] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);

  /*
   * The latest loader and callback live in refs so the load effect does not
   * depend on them. The sync effect below runs before the load effect on a
   * dep change, so the load always sees the current render's closures.
   */
  const loadRef = useRef(load);
  const onLoadedRef = useRef(onLoaded);

  useEffect(() => {
    loadRef.current = load;
    onLoadedRef.current = onLoaded;
  });

  /** The league last resolved, readable from `reload` without a stale closure. */
  const leagueIdRef = useRef<string | null>(null);

  const setError = useCallback((message: string | null) => {
    setErrorState(message);
  }, []);

  /** Stores a fresh payload and runs the page's post-load work. */
  const apply = useCallback((next: T) => {
    setData(next);
    onLoadedRef.current?.(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadLeague() {
      try {
        setIsLoading(true);
        setErrorState(null);

        const league = await resolveActiveLeague(
          requestedLeagueId,
          emptyLeagueMessage,
        );

        if (league.status === "unauthenticated") {
          router.replace("/");
          return;
        }

        if (league.status === "error") {
          if (!cancelled) {
            setErrorState(league.message);
          }
          return;
        }

        leagueIdRef.current = league.leagueId;
        if (!cancelled) {
          setLeagueId(league.leagueId);
        }

        const next = await loadRef.current(league.leagueId);

        if (!cancelled) {
          apply(next);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setErrorState(
            caughtError instanceof Error
              ? caughtError.message
              : fallbackErrorMessage,
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadLeague();

    return () => {
      cancelled = true;
    };
  }, [
    requestedLeagueId,
    router,
    emptyLeagueMessage,
    fallbackErrorMessage,
    apply,
  ]);

  const reload = useCallback(async (): Promise<T | null> => {
    const currentLeagueId = leagueIdRef.current;

    if (!currentLeagueId) {
      return null;
    }

    const next = await loadRef.current(currentLeagueId);
    apply(next);
    return next;
  }, [apply]);

  return { data, isLoading, error, setError, leagueId, reload };
}
