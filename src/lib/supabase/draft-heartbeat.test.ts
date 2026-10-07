/*
 * Tests for the draft heartbeat's log throttling.
 *
 * The heartbeat runs every 15 seconds and used to print a line every tick, which
 * is 5,760 near-identical lines a day per active draft. Throttling that is only
 * worth having if it keeps the two properties that make the console the liveness
 * signal at all: a sweep that resolved something always reports, and a heartbeat
 * that goes quiet is still visible within a bounded time. Both are pinned here
 * because a regression in either direction is silent: too little logging and a
 * dead draft looks identical to an idle one, too much and the log is unreadable
 * exactly when something has broken.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSweep } from "@/lib/supabase/draft-heartbeat";

/** The throttle window the heartbeat uses between "still alive" lines. */
const LIVENESS_LOG_INTERVAL_MS = 900_000;

/** Minimal stand-in for the Supabase client: runSweep only calls rpc(). */
function makeClient(result: {
  data?: unknown;
  error?: { message: string } | null;
}) {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as Parameters<typeof runSweep>[0];
}

describe("draft heartbeat logging", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Freeze the clock so the throttle window can be crossed deliberately.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Fresh throttle bookkeeping, as startDraftHeartbeat would create it. */
  const state = () => ({ lastLivenessLogAt: 0, lastErrorMessage: null });

  it("reports itself on the very first sweep so a heartbeat that then dies is visible", async () => {
    const s = state();
    await runSweep(makeClient({ data: 0 }), s);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("alive");
  });

  it("stays quiet across the sweeps inside one throttle window", async () => {
    const s = state();
    // 60 ticks at a 15s interval is exactly one 15 minute window, so only the
    // very first sweep should report.
    for (let i = 0; i < 60; i++) {
      await runSweep(makeClient({ data: 0 }), s);
      vi.advanceTimersByTime(15_000);
    }

    expect(log).toHaveBeenCalledTimes(1);
  });

  it("cuts a full day of idle sweeps to one line per throttle window", async () => {
    const s = state();
    // A day of heartbeat ticks at a 15s interval.
    const sweepsPerDay = (24 * 60 * 60) / 15;
    for (let i = 0; i < sweepsPerDay; i++) {
      await runSweep(makeClient({ data: 0 }), s);
      vi.advanceTimersByTime(15_000);
    }

    // 24 hours of 15 minute windows is 96, and the opening line is one of those
    // rather than an extra: the loop stops one tick short of the 97th window.
    expect(log).toHaveBeenCalledTimes(96);
    expect(log.mock.calls.length).toBeLessThan(sweepsPerDay / 50);
  });

  it("reports again once the throttle window has elapsed", async () => {
    const s = state();
    await runSweep(makeClient({ data: 0 }), s);
    log.mockClear();

    vi.advanceTimersByTime(LIVENESS_LOG_INTERVAL_MS);
    await runSweep(makeClient({ data: 0 }), s);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("alive");
  });

  it("always logs a sweep that resolved something, mid-window", async () => {
    const s = state();
    await runSweep(makeClient({ data: 0 }), s);
    log.mockClear();

    // Well inside the throttle window: the resolution is the event, not the tick.
    vi.advanceTimersByTime(60_000);
    await runSweep(makeClient({ data: 3 }), s);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("advanced 3");
  });

  it("a resolution resets the liveness clock rather than stacking on it", async () => {
    const s = state();
    await runSweep(makeClient({ data: 0 }), s);
    vi.advanceTimersByTime(LIVENESS_LOG_INTERVAL_MS - 1_000);
    await runSweep(makeClient({ data: 1 }), s);
    log.mockClear();

    // The resolution was the last thing logged, so a further 15 minutes is not
    // yet enough for another "alive" line.
    vi.advanceTimersByTime(LIVENESS_LOG_INTERVAL_MS - 1_000);
    await runSweep(makeClient({ data: 0 }), s);
    expect(log).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    await runSweep(makeClient({ data: 0 }), s);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("logs a repeated RPC error once, not on every tick", async () => {
    const s = state();
    for (let i = 0; i < 50; i++) {
      await runSweep(makeClient({ error: { message: "boom" } }), s);
      vi.advanceTimersByTime(15_000);
    }

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("sweep RPC error");
  });

  it("logs again when the failure changes, since a new cause needs a new line", async () => {
    const s = state();
    await runSweep(makeClient({ error: { message: "boom" } }), s);
    await runSweep(makeClient({ error: { message: "different" } }), s);

    expect(error).toHaveBeenCalledTimes(2);
  });

  it("recovers: once the error clears, a later failure is reported again", async () => {
    const s = state();
    await runSweep(makeClient({ error: { message: "boom" } }), s);
    await runSweep(makeClient({ data: 0 }), s);
    await runSweep(makeClient({ error: { message: "boom" } }), s);

    // Twice, not three times: the sweep in between was the only one that did not
    // report the same "boom" again.
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("treats a null or missing count as zero rather than logging a resolution", async () => {
    const s = state();
    log.mockClear();
    await runSweep(makeClient({ data: null }), s);

    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("advanced"),
    );
  });
});