/*
 * Tests for the cross-context UUID helper used by draft pool saves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUuid } from "./uuid";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a version-4 UUID", () => {
    expect(createUuid()).toMatch(UUID_V4);
  });

  it("falls back when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});

    expect(createUuid()).toMatch(UUID_V4);
  });

  it("returns distinct values", () => {
    const values = new Set(Array.from({ length: 20 }, () => createUuid()));

    expect(values.size).toBe(20);
  });
});
