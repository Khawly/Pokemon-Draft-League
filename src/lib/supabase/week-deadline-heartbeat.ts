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
 */
import { createClient } from "@supabase/supabase-js";

/** Deadlines are days apart, so a minute of latency is imperceptible. */
const HEARTBEAT_INTERVAL_MS = 60_000;

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
 * Runs a single weekly deadline sweep with the public anon client.
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
  const supabaseAnonKey = getEnvValue(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
  );

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(
      "[week-deadline-heartbeat] supabase env vars missing; sweep idle",
    );
    return;
  }

  // One shared client (per-call clients leak connections), reused by every tick.
  const client = createClient(supabaseUrl, supabaseAnonKey);

  let inFlight = false;
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
