/*
 * Tests for the read-retry wrapper.
 *
 * The important contract is the asymmetry: reads may be retried and eventually
 * show a friendly busy message, while writes must be attempted exactly once so a
 * roster move or trade cannot be replayed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry } from "@/lib/supabase/fetch-retry";

/** Restores any stubbed global after each case. */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithRetry", () => {
  it("retries a transient read failure and returns the successful response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/rest/v1/teams");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a write", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("busy", { status: 503 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/rest/v1/rpc/pickup", {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a readable busy response after the read retry budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("busy", { status: 503 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/rest/v1/teams");
    const body = (await response.json()) as { message: string; code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("league_busy");
    expect(body.message).toMatch(/league is busy/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
