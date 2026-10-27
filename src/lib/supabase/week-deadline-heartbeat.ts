/*
 * Server-side weekly deadline heartbeat for the Pokemon Draft League.
 *
 * Periodically calls the advance_overdue_week_deadlines sweep so a week still
 * closes on its deadline even when nobody has the app open. The sweep is
 * idempotent and only ever advances a week that is already past its deadline, so
 * a tick can never rush a league forward.
 *
 * Runs exactly once per Node process; the module-level guard is keyed on
 * globalThis so Next.js dev/HMR reloads restart the single interval instead of
 * stacking duplicates. Bootstrapped from next instrumentation.ts. Intended for
 * long-lived hosts (the dev server or a self-hosted Node build), not for
 * per-request serverless instances — the Schedule page also nudges the sweep so
 * a serverless deployment still progresses while someone is looking at it.
 *
 * The server heartbeat uses the service role, like the draft sweep. The
 * authenticated Schedule-page nudge keeps its own grant.
 *
 * The same daily tick also calls prune_internal_history, which trims old
 * notifications and heartbeat audit rows. It is intentionally separate from the
 * league records (matches, transactions, rosters, pools).
 */
import { createClient } from "@supabase/supabase-js";

/** Deadlines are days apart, so a minute of latency is imperceptible. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Internal-history cleanup cadence; once per process per day. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Reads the first defined environment variable from the given candidate keys.
const getEnvValue = (...keys: string[]) => {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
};

const HEARTBEAT_REGISTRY = Symbol.for("pdl.weekDeadlineHeartbeat");

type HeartbeatState = {
  interval: ReturnType<typeof setInterval>;
};

/**
 * Runs a single weekly deadline sweep with the service-role client.
 *
 * Guarantees one sweep-at-a-time: a promise that never settles holds the single
 * guard and later ticks skip instead of stacking requests. Any thrown error or
 * RPC error is logged, never swallowed as an unhandled rejection.
 */
async function runSweep(
  client: import("@supabase/supabase-js").SupabaseClient,
) {
  const result = await client.rpc("advance_overdue_week_deadlines");
  if (result.error) {
    console.error(
      "[week-deadline-heartbeat] sweep RPC error:",
      result.error.message,
    );
    return;
  }
  console.log(
    `[week-deadline-heartbeat] sweep ok (leagues advanced=${String(result.data)})`,
  );
}

/**
 * Trims old notifications and heartbeat audit rows.
 *
 * The SQL function takes its own advisory lock, so multiple app-server
 * instances can call it without duplicating the deletes. A missing migration or
 * transient error only produces a log line; the league sweep itself still runs.
 *
 * @param client - Service-role client used by the heartbeat.
 */
async function runPrune(
  client: import("@supabase/supabase-js").SupabaseClient,
) {
  const result = await client.rpc("prune_internal_history");

  if (result.error) {
    console.error(
      "[week-deadline-heartbeat] retention RPC error:",
      result.error.message,
    );
    return;
  }

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  console.log(
    "[week-deadline-heartbeat] retention pruned",
    row ?? "0 rows",
  );
}

/**
 * Starts (or restarts) the weekly deadline heartbeat for this Node process.
 *
 * Safe to call from any server context; a no-op in the browser. Registering a
 * second heartbeat replaces the existing interval rather than duplicating it.
 *
 * @param intervalMs - Milliseconds between sweeps; defaults to one minute.
 */
export function startWeekDeadlineHeartbeat(
  intervalMs = HEARTBEAT_INTERVAL_MS,
): void {
  if (typeof window !== "undefined") {
    return;
  }

  const registry = globalThis as {
    [HEARTBEAT_REGISTRY]?: HeartbeatState;
  };

  if (registry[HEARTBEAT_REGISTRY]) {
    clearInterval(registry[HEARTBEAT_REGISTRY].interval);
  }

  const supabaseUrl = getEnvValue(
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_URL",
  );
  const serviceKey = getEnvValue(
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  );

  if (!supabaseUrl || !serviceKey) {
    console.warn(
      "[week-deadline-heartbeat] service-role key missing; sweep idle",
    );
    return;
  }

  // One shared client (per-call clients leak connections), reused by every tick.
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let inFlight = false;
  let lastPruneAt = 0;
  const sweep = async () => {
    if (inFlight) {
      console.warn(
        "[week-deadline-heartbeat] previous sweep still in flight; skipping tick",
      );
      return;
    }
    inFlight = true;
    try {
      await runSweep(client);

      const now = Date.now();
      if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
        // Mark before the call so a persistent failure retries on the next day
        // rather than on every 60-second tick.
        lastPruneAt = now;
        await runPrune(client);
      }
    } catch (err) {
      console.error(
        "[week-deadline-heartbeat] sweep failed:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      inFlight = false;
    }
  };

  void sweep();
  registry[HEARTBEAT_REGISTRY] = {
    interval: setInterval(() => void sweep(), intervalMs),
  };
  console.log(
    `[week-deadline-heartbeat] active, sweeping weekly deadlines every ${intervalMs}ms`,
  );
}
