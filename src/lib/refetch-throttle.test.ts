import { describe, expect, it } from "vitest";

import { isDocumentHidden, refetchDelayMs } from "./refetch-throttle";

describe("refetchDelayMs", () => {
  it("waits the quiet period before the first batch", () => {
    // Nothing has been applied yet, so only the debounce applies: a single change still
    // feels immediate rather than being held behind a cooldown it has not earned.
    expect(refetchDelayMs(1_000, null, 250, 2_000)).toBe(250);
  });

  it("waits the cooldown when changes arrive faster than it", () => {
    // The case that filled the log drain. A stream of writes arriving continuously makes
    // the debounce fire over and over, each firing a full payload refetch, so the spacing
    // since the last one has to be a floor and not just a merge window.
    const appliedAt = 10_000;

    expect(refetchDelayMs(10_100, appliedAt, 250, 2_000)).toBe(1_900);
    expect(refetchDelayMs(11_500, appliedAt, 250, 2_000)).toBe(500);
  });

  it("does not add the cooldown on top of a quiet spell", () => {
    // A change arriving well after the last batch is not slowed down for having waited;
    // the cooldown has already elapsed and only the debounce remains.
    expect(refetchDelayMs(60_000, 10_000, 250, 2_000)).toBe(250);
  });

  it("lets the debounce win when it is the longer of the two", () => {
    // A long quiet period with a short cooldown still merges a slow burst.
    expect(refetchDelayMs(10_100, 10_000, 5_000, 1_000)).toBe(5_000);
  });

  it("never returns a negative delay once the cooldown has passed", () => {
    // A negative delay would be a setTimeout that fires immediately, which is correct
    // behaviour but worth pinning: the arithmetic must not run backwards.
    expect(refetchDelayMs(99_999, 10_000, 250, 2_000)).toBeGreaterThanOrEqual(0);
  });

  it("bounds the number of refetches from a sustained stream", () => {
    // What the floor buys, stated as the property that matters for the quota: over a
    // minute of writes arriving every 100ms, the old behaviour refetched about 240 times
    // and this one refetches about 30.
    const debounceMs = 250;
    const minIntervalMs = 2_000;
    const writeEveryMs = 100;
    const minute = 60_000;

    let now = 0;
    let lastAppliedAt: number | null = null;
    let nextDue = 0;
    let refetches = 0;

    for (let t = 0; t < minute; t += writeEveryMs) {
      now = t;

      if (nextDue === 0) {
        nextDue = now + refetchDelayMs(now, lastAppliedAt, debounceMs, minIntervalMs);
      }

      if (now >= nextDue) {
        refetches += 1;
        lastAppliedAt = now;
        nextDue = 0;
      }
    }

    // 60s / 2s floor, so around 30 rather than the 240 that a bare 250ms debounce gives.
    expect(refetches).toBeLessThanOrEqual(31);
    expect(refetches).toBeGreaterThanOrEqual(29);
  });
});

describe("isDocumentHidden", () => {
  it("treats a hidden tab as not worth refetching", () => {
    expect(isDocumentHidden("hidden")).toBe(true);
  });

  it("refetches for a visible tab, and for one with no state at all", () => {
    // An unknown state is treated as visible on purpose: a refetch that turns out to be
    // unnecessary costs a little, while one that is skipped and never retried leaves the
    // page wrong.
    expect(isDocumentHidden("visible")).toBe(false);
    expect(isDocumentHidden(undefined)).toBe(false);
  });
});