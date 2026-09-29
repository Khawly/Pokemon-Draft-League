/*
 * Targeted realtime invalidation for the Pokemon Draft League.
 *
 * Realtime here is a "this data is stale now" signal, never a data source. An
 * event carries no usable payload for this app's pages: the schedule page renders
 * a week, several derived matchup states, and availability projections, none of
 * which a single row change describes. So an event only marks the data dirty and
 * triggers the same scoped refetch the page already runs on mount, which keeps one
 * code path for loading instead of two that have to agree.
 *
 * Two properties make that safe:
 *
 *   Coalescing. A single logical change can write many rows. Settling a week
 *   updates every match in it, and a week has as many matches as it has players
 *   divided by two. Events are therefore collected and flushed once after a short
 *   quiet period, so a burst of writes costs exactly one refetch.
 *
 *   Pausing. A refetch replaces the page's data, which can move the user off the
 *   matchup they are looking at and throw away a half-filled form. A caller can
 *   suspend invalidation while it is mid-interaction; the pending signal is
 *   remembered and applied when the caller resumes, so the update is deferred
 *   rather than lost.
 *
 * Only the tables a member can notice changing are published; see
 * supabase/migrations/20261029_realtime_publication.sql.
 */
"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";

/** Tables a page may ask to watch. */
export type RealtimeTable = "matches" | "notifications" | "match_scheduling_proposals";

/** One table to watch and what to do when it changes. */
export type RealtimeWatcher = {
  /** The table to subscribe to. */
  table: RealtimeTable;
  /**
   * Called once per coalesced batch of changes to this table. A page uses this to
   * pick how much to re-read: a notification only moves a badge, while a match
   * changing invalidates the whole schedule.
   */
  onChange: () => void;
};

/** Options for {@link useRealtimeInvalidation}. */
export type RealtimeInvalidationOptions = {
  /** League whose rows to watch, or null to stay unsubscribed. */
  leagueId: string | null;
  /** The tables to watch and what to do for each. */
  watchers: RealtimeWatcher[];
  /**
   * Returns true to suspend refetching, e.g. while a form is open. A batch that
   * arrives while paused is remembered and replayed when the caller calls
   * {@link RealtimeInvalidation.flush}, so the update is deferred, not lost.
   */
  isPaused?: () => boolean;
  /**
   * Quiet period before a batch is flushed, in milliseconds. Long enough to merge
   * a multi-row write, short enough that a single change still feels immediate.
   */
  debounceMs?: number;
};

/** Default quiet period before a coalesced batch is flushed. */
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * The handle a page gets back from {@link useRealtimeInvalidation}.
 */
export type RealtimeInvalidation = {
  /**
   * Applies an update that was deferred while paused. Safe to call at any time:
   * it does nothing unless a batch is actually waiting, so a page can call it
   * unconditionally when it finishes an interaction.
   */
  flush: () => void;
};

/**
 * Refetches when a watched table changes, coalescing bursts and deferring while
 * the caller is busy.
 *
 * @param options - The league, the tables to watch, and the callbacks to drive.
 * @returns A handle with `flush`, for applying deferred updates.
 */
export function useRealtimeInvalidation({
  leagueId,
  watchers,
  isPaused,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: RealtimeInvalidationOptions): RealtimeInvalidation {
  /*
   * Watchers are read through a ref so a new array identity on every render does
   * not tear down and rebuild the channel. Without this, inline arrow functions
   * would resubscribe constantly, which is wasteful and loses events in the gap.
   */
  const watchersRef = useRef(watchers);
  const isPausedRef = useRef(isPaused);

  useEffect(() => {
    watchersRef.current = watchers;
    isPausedRef.current = isPaused;
  }, [watchers, isPaused]);

  /*
   * Only the watched set, not the callbacks, decides the channel's identity. A
   * change to which tables are watched rebuilds; a change to a callback does not.
   */
  const tableKey = watchers.map((watcher) => watcher.table).sort().join(",");

  const flushRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!leagueId) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let queued: Set<RealtimeTable> | null = null;
    let disposed = false;

    const deliver = () => {
      timer = null;

      if (disposed || !queued) {
        return;
      }

      if (isPausedRef.current?.()) {
        // Remember it, and apply it when the caller calls flush().
        return;
      }

      const due = new Set(queued);
      queued = null;

      for (const watcher of watchersRef.current) {
        if (due.has(watcher.table)) {
          watcher.onChange();
        }
      }
    };

    const schedule = (table: RealtimeTable) => () => {
      if (disposed) {
        return;
      }

      if (!queued) {
        queued = new Set();
      }
      queued.add(table);

      if (!timer) {
        timer = setTimeout(deliver, debounceMs);
      }
    };

    flushRef.current = () => {
      if (disposed) {
        return;
      }

      if (timer) {
        clearTimeout(timer);
      }

      deliver();
    };

    const channel = supabase.channel(`realtime:${tableKey}:${leagueId}`);

    for (const watcher of watchersRef.current) {
      if (watcher.table === "match_scheduling_proposals") {
        // Proposals carry no league column, so nothing can be filtered on and every
        // proposal event arrives. It is only a staleness signal, and it always
        // accompanies a change to the match it belongs to.
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table: watcher.table },
          schedule(watcher.table),
        );
        continue;
      }

      channel.on(
        "postgres_changes",
        {
          event: "*",
        schema: "public",
          table: watcher.table,
          filter: `league_id=eq.${leagueId}`,
        },
        schedule(watcher.table),
      );
    }

    void channel.subscribe();

    return () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      void supabase.removeChannel(channel);
      flushRef.current = () => undefined;
    };
  }, [leagueId, tableKey, debounceMs]);

  return { flush: () => flushRef.current() };
}
