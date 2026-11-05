/*
 * Unit tests for the shared deadline check.
 *
 * The database enforces the same boundary, so these pin the client-side edge:
 * before the instant the window is open, at the instant it is closed, and an
 * unset deadline never closes anything.
 */
import { describe, expect, it } from "vitest";

import { isDeadlinePassed } from "@/lib/deadlines";

describe("isDeadlinePassed", () => {
  const deadline = "2026-11-10T20:00:00.000Z";

  it("is open before the deadline", () => {
    expect(isDeadlinePassed(deadline, new Date("2026-11-10T19:59:59Z"))).toBe(
      false,
    );
  });

  it("is closed at the deadline", () => {
    expect(isDeadlinePassed(deadline, new Date("2026-11-10T20:00:00Z"))).toBe(
      true,
    );
  });

  it("is open when no deadline is set", () => {
    expect(isDeadlinePassed(null)).toBe(false);
    expect(isDeadlinePassed(undefined)).toBe(false);
  });

  it("treats an invalid stored value as no deadline", () => {
    expect(isDeadlinePassed("not-a-date")).toBe(false);
  });
});
