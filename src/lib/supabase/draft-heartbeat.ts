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
 * Errors are caught rather than crashing the process, and an in-flight guard
 * skips ticks so a hung request can never stack up connections or stall the
 * schedule.
 *
 * Logging is deliberately throttled. The sweep runs every 15 seconds for the life
 * of the process, so logging every tick produced 5,760 lines a day per active
 * draft, and on a long draft the overwhelming majority recorded that nothing had
 * happened. It now logs a line whenever a turn actually resolves, one "still
 * alive" line every LIVENESS_LOG_INTERVAL_MS so a heartbeat that has stopped is
 * still provable, and one line per distinct RPC error rather than one per tick.
 */
import { createClient } from "@supabase/supabase-js";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How often the sweep reports "still alive" while no draft is due.
 *
 * The sweep itself has to stay at HEARTBEAT_INTERVAL_MS so a pick is never late,
 * but a liveness line does not need that resolution: 15 minutes is far more often
 * than anyone reads a server log, and it cuts the idle log volume by roughly 60x
 * against the previous every-tick line. A turn that resolves always logs
 * immediately regardless of this, so the events that matter are never throttled.
 */
const LIVENESS_LOG_INTERVAL_MS = 900_000;

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
 * Log throttling bookkeeping for one heartbeat instance.
 *
 * Per instance rather than per module, so restarting the heartbeat resets it.
 * lastLivenessLogAt starts at 0 so the very first sweep always reports itself: a
 * heartbeat that started and then died has to be visible in the log within one
 * tick of going quiet.
 */
type HeartbeatLogState = {
  /** When the last "still alive" line was written. */
  lastLivenessLogAt: number;
  /** Last distinct RPC error message, so a failure that persists is logged once. */
  lastErrorMessage: string | null;
};

/**
 * Runs a single overdue-draft sweep with the public anon client.
 *
 * Guarantees one sweep-at-a-time: a promise that never settles holds the
 * single guard, later ticks skip (printing a warning) instead of stacking
 * requests. Any thrown error or supabase RPC error is logged, never swallowed
 * as an unhandled rejection — so the schedule survives and the cause is
 * always visible in the server console.
 *
 * @param client - Shared Supabase client to issue the sweep RPC with.
 * @param logState - Throttling bookkeeping for this heartbeat instance.
 *
 * Exported for the throttle tests; not part of the module's intended surface.
 */
export async function runSweep(
  client: import("@supabase/supabase-js").SupabaseClient,
  logState: HeartbeatLogState,
) {
  const result = await client.rpc("advance_overdue_drafts");
  const advanced = Number(result.data ?? 0);

  if (result.error) {
    /*
     * A failure that outlives one tick would otherwise reprint the same message
     * every 15 seconds until it was fixed, which buries the rest of the log in
     * the one thing that is already broken. Log the first occurrence and any
     * change of message, and stay quiet in between.
     */
    if (result.error.message !== logState.lastErrorMessage) {
      console.error("[draft-heartbeat] sweep RPC error:", result.error.message);
      logState.lastErrorMessage = result.error.message;
    }
    return;
  }

  logState.lastErrorMessage = null;

  // A sweep that resolved something is the event worth recording, always logged.
  if (advanced > 0) {
    console.log(`[draft-heartbeat] advanced ${String(advanced)} draft turn(s)`);
    logState.lastLivenessLogAt = Date.now();
    return;
  }

  /*
   * Nothing was due. The heartbeat still has to be provably alive, since this
   * console line is the only liveness signal now that the heartbeat tables no
   * longer record idle sweeps (see 20261112). Report it periodically instead of
   * on every tick: "still idle" repeated 5,760 times a day is noise, and the
   * events that matter have already returned above.
   */
  const now = Date.now();
  if (now - logState.lastLivenessLogAt >= LIVENESS_LOG_INTERVAL_MS) {
    console.log("[draft-heartbeat] alive, no drafts due");
    logState.lastLivenessLogAt = now;
  }
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

  const logState: HeartbeatLogState = {
    lastLivenessLogAt: 0,
    lastErrorMessage: null,
  };

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
      await runSweep(client, logState);
    } catch (err) {
      console.error(
        "[draft-heartbeat] sweep failed:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      inFlight = false;
    }
  };

  registry[HEARTBEAT_REGISTRY] = {
    interval: setInterval(() => void sweep(), intervalMs),
  };

  void sweep();
  console.log(
    `[draft-heartbeat] active, sweeping overdue drafts every ${intervalMs}ms`,
  );
}