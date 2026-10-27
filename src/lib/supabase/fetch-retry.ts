/*
 * Retry wrapper for Supabase HTTP reads.
 *
 * Shared CPU and the connection pooler can answer a request with 429/502/503/504
 * under load. Supabase-js does not retry by default, so a transient response
 * would surface as a page error. This wrapper retries GET/HEAD requests with
 * exponential backoff and jitter, and leaves every write untouched: retrying a
 * POST RPC blindly could repeat a roster move or a trade.
 *
 * After the retry budget is spent, a read still gets a clear message rather
 * than a raw platform error. The synthetic response keeps the original status
 * but replaces the body with the app's "league is busy" wording, and the global
 * chrome shows the same wording even when a page loader replaces the error with
 * its own generic fallback.
 */

import {
  announceLeagueBusy,
  LEAGUE_BUSY_MESSAGE,
} from "@/lib/busy-signal";

/** Statuses that are safe to retry for a read. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Initial delay; doubled per attempt and capped below. */
const BASE_DELAY_MS = 250;

/** Upper bound for a single backoff wait. */
const MAX_DELAY_MS = 2_000;

/** Initial attempt plus two retries. */
const MAX_ATTEMPTS = 3;

/**
 * Waits for a retry.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise that settles after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes the backoff for one attempt, with a little jitter so many clients
 * do not retry in lockstep.
 *
 * @param attempt - Zero-based retry attempt.
 * @returns Delay in milliseconds.
 */
function backoffMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS) + Math.random() * 100;
}

/**
 * Reads a `Retry-After` header in seconds or as an HTTP date.
 *
 * @param value - The header value, or null.
 * @returns A bounded delay, or null when the header is absent/unparseable.
 */
function retryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_DELAY_MS);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, Math.min(timestamp - Date.now(), MAX_DELAY_MS));
}

/**
 * Builds the response the page sees when a read is still rate-limited after
 * retries.
 *
 * @param status - The final upstream status.
 * @returns A JSON response carrying the friendly message.
 */
function busyResponse(status: number): Response {
  announceLeagueBusy();

  return new Response(
    JSON.stringify({ message: LEAGUE_BUSY_MESSAGE, code: "league_busy" }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

/**
 * Fetch wrapper for Supabase clients.
 *
 * Retries only GET/HEAD requests. Any other method is passed through unchanged
 * so writes keep their existing single-attempt, error-visible behaviour.
 *
 * @param input - Request URL or Request object.
 * @param init - Fetch options.
 * @returns The upstream response, or a friendly busy response after retries.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = (
    init?.method ??
    (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const isRead = method === "GET" || method === "HEAD";

  if (!isRead) {
    const response = await fetch(input, init);

    // Writes are not retried, but a platform-level throttle still deserves the
    // same clear state as a read that exhausted its retries.
    if (RETRYABLE_STATUS.has(response.status)) {
      announceLeagueBusy();
    }

    return response;
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(input, init);

      if (!RETRYABLE_STATUS.has(response.status)) {
        return response;
      }

      if (attempt >= MAX_ATTEMPTS - 1) {
        return busyResponse(response.status);
      }

      await delay(
        retryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt),
      );
    } catch (error) {
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : null);

      // Do not keep retrying after the caller has cancelled the request.
      if (signal?.aborted || attempt >= MAX_ATTEMPTS - 1) {
        throw error;
      }

      await delay(backoffMs(attempt));
    }
  }
}
