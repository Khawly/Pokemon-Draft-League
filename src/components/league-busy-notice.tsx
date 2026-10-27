/*
 * Global "league is busy" notice.
 *
 * The retry wrapper emits this signal when a Supabase request is still
 * rate-limited after its budget, or when a write is throttled. Showing it in the
 * chrome ensures the message is visible even on pages whose loaders replace a
 * raw Supabase error with their own generic fallback.
 */
"use client";

import { useEffect, useState } from "react";

import {
  LEAGUE_BUSY_EVENT,
  LEAGUE_BUSY_MESSAGE,
} from "@/lib/busy-signal";

/** How long the notice stays up before dismissing itself. */
const DISMISS_AFTER_MS = 8_000;

/**
 * Renders a transient busy banner when Supabase is throttling requests.
 *
 * @returns The notice, or null when nothing is busy.
 */
export function LeagueBusyNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function handleBusy() {
      setVisible(true);

      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => setVisible(false), DISMISS_AFTER_MS);
    }

    window.addEventListener(LEAGUE_BUSY_EVENT, handleBusy);

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      window.removeEventListener(LEAGUE_BUSY_EVENT, handleBusy);
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-[60] w-[min(92vw,32rem)] -translate-x-1/2 rounded-xl border border-amber-700 bg-amber-950/95 px-4 py-3 text-sm text-amber-100 shadow-2xl shadow-slate-950/60 backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <p>{LEAGUE_BUSY_MESSAGE}</p>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="shrink-0 rounded-lg border border-amber-700 px-2 py-1 text-xs font-semibold text-amber-200 transition hover:border-amber-400 hover:text-amber-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
