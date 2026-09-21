/*
 * Next.js instrumentation hook for the Pokemon Draft League.
 *
 * Starts the server-side draft heartbeat exactly once when the Node server
 * boots (before it serves any request), so overdue draft turns are always
 * advanced by the app server regardless of which routes or pages get rendered.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startDraftHeartbeat } = await import(
      "@/lib/supabase/draft-heartbeat"
    );
    startDraftHeartbeat();
  }
}