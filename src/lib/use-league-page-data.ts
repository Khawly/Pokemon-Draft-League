/*
 * Shared load lifecycle for a page that shows one league.
 *
 * Every league page needs the same sequence: wait for the shell to say which
 * league is on screen, load that league's payload, leave a signed-out visitor on
 * the landing page, and track loading and error state while it happens. Pages
 * used to spell it out in a ~70-line effect each, including their own auth and
 * membership lookup. The shell provider has already done that work; this hook
 * consumes its answer and runs the page's loader.
 *
 * The loader and post-load callback are held in refs, so a page can define them
 * inline (closing over its own state, season parameter, or filters) without
 * restarting the load on every render.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Options for {@link useLeaguePageData}. */
export interface UseLeaguePageDataOptions<T> {
  /** The league to load, or null when the shell resolved none. */
  leagueId: string | null;
  /** True until the shell has resolved the URL, the member, and the league. */
  isResolving: boolean;
  /** True once the shell knows the visitor is not signed in. */
  signedOut: boolean;
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
  /**
   * Replaces the payload in place.
   *
   * For updates the page can apply without a refetch, such as folding a saved
   * prediction into the match it belongs to.
   */
  setData: (update: T | null | ((current: T | null) => T | null)) => void;
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
  leagueId: requestedLeagueId,
  isResolving,
  signedOut,
  load,
  emptyLeagueMessage,
  fallbackErrorMessage,
  onLoaded,
}: UseLeaguePageDataOptions<T>): LeaguePageData<T> {
  const router = useRouter();

  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setErrorState] = useState<string | null>(null);

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

  /** The league currently loaded, readable from `reload` without a stale closure. */
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
    /*
     * The shell is still resolving the URL and the member, or there is no
     * league to load. Neither case sets state here: `isResolving` is folded
     * into the returned `isLoading`, and a missing league is folded into the
     * returned error, so this effect only ever fetches.
     */
    if (isResolving || signedOut || !requestedLeagueId) {
      return;
    }

    // Captured before the async call so the narrowing survives into it.
    const activeLeagueId = requestedLeagueId;
    let cancelled = false;

    async function loadLeague() {
      try {
        setIsLoading(true);
        setErrorState(null);

        leagueIdRef.current = activeLeagueId;
        const next = await loadRef.current(activeLeagueId);

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
    isResolving,
    signedOut,
    router,
    emptyLeagueMessage,
    fallbackErrorMessage,
    apply,
  ]);

  /*
   * A signed-out visitor is sent to the landing page. Kept as its own effect so
   * the fetch effect above contains no state writes and no navigation.
   */
  useEffect(() => {
    if (signedOut) {
      router.replace("/");
    }
  }, [signedOut, router]);

  const reload = useCallback(async (): Promise<T | null> => {
    const currentLeagueId = leagueIdRef.current;

    if (!currentLeagueId) {
      return null;
    }

    const next = await loadRef.current(currentLeagueId);
    apply(next);
    return next;
  }, [apply]);

  /** True when the shell finished resolving and found no league to show. */
  const leagueMissing = !isResolving && !signedOut && !requestedLeagueId;

  return {
    data,
    /*
     * A missing league is not a loading state: without this, the initial
     * `isLoading` would never clear (the effect returns before fetching) and the
     * page would spin instead of showing the "no league" error below.
     */
    isLoading: leagueMissing ? false : isLoading || isResolving,
    error: error ?? (leagueMissing ? emptyLeagueMessage : null),
    setError,
    setData,
    leagueId: requestedLeagueId,
    reload,
  };
}
