/*
 * Server-side draft heartbeat for the Pokemon Draft League.
 *
 * Periodically calls the advance_overdue_drafts sweep so an active draft whose
 * current turn is due (timer expired, or an armed Auto/Skip round flag) always
 * advances even when no browser fires the per-turn resolve — a draft can no
 * longer wedge at 0:00 because every client happens to be asleep or unloaded.
 * Runs exactly once per Node process; the module-level guard is keyed on
 * globalThis so Next.js dev/HMR reloads restart the single interval instead of
 * stacking duplicates. Bootstrapped from next instrumentation.ts so it starts
 * before the server serves any request. Intended for long-lived hosts (the dev
 * server or a self-hosted Node build), not for per-request serverless
 * instances.
 *
 * Every sweep prints one line to the server console so liveness (and any RPC
 * failure) is always visible: errors are caught rather than crashing the
 * process, and an in-flight guard skips ticks so a hung request can never
 * stack up connections or stall the schedule.
 */
import { createClient } from "@supabase/supabase-js";

const HEARTBEAT_INTERVAL_MS = 15_000;

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

const HEARTBEAT_REGISTRY = Symbol.for("pdl.draftHeartbeat");

type HeartbeatState = {
  interval: ReturnType<typeof setInterval>;
};

/**
 * Runs a single overdue-draft sweep with the public anon client.
 *
 * Guarantees one sweep-at-a-time: a promise that never settles holds the
 * single guard, later ticks skip (printing a warning) instead of stacking
 * requests. Any thrown error or supabase RPC error is logged, never swallowed
 * as an unhandled rejection — so the schedule survives and the cause is
 * always visible in the server console.
 */
async function runSweep(client: import("@supabase/supabase-js").SupabaseClient) {
  const result = await client.rpc("advance_overdue_drafts");
  if (result.error) {
    console.error("[draft-heartbeat] sweep RPC error:", result.error.message);
    return;
  }
  console.log(
    `[draft-heartbeat] sweep ok (advanced=${String(result.data)})`,
  );
}

/**
 * Starts (or restarts) the draft-resolution heartbeat for this Node process.
 *
 * Safe to call from any server context; a no-op in the browser. Registering a
 * second heartbeat replaces the existing interval rather than duplicating it.
 */
export function startDraftHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS): void {
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
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
  );

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn("[draft-heartbeat] supabase env vars missing; sweep idle");
    return;
  }

  // One shared client (per-call clients leak connections), reused by every
  // sweep tick via the closure below.
  const client = createClient(supabaseUrl, supabaseAnonKey);

  let inFlight = false;
  const sweep = async () => {
    if (inFlight) {
      console.warn(
        "[draft-heartbeat] previous sweep still in flight; skipping tick",
      );
      return;
    }
    inFlight = true;
    try {
      await runSweep(client);
    } catch (err) {
      console.error(
        "[draft-heartbeat] sweep failed:",
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
    `[draft-heartbeat] active, sweeping overdue drafts every ${intervalMs}ms`,
  );
}