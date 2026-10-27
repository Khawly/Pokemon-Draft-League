-- Retention for internal history that never needs to live forever
--
-- The 500 MB free-plan database is comfortable today, but notifications and the
-- heartbeat audit tables grow with every league and every season. They are
-- operational history, not user-facing league records, so they can be pruned on
-- a schedule while matches, transactions, rosters, pools, and seasons are left
-- untouched.
--
-- The prune function is deliberately conservative:
--   - notifications older than 180 days
--   - draft_sweep_heartbeats older than 90 days
--   - week_deadline_heartbeats older than 90 days
--
-- It is service-role only and uses an advisory lock so multiple app-server
-- instances can call it at the same time without duplicating the deletes. The
-- weekly heartbeat calls it once per process per day; even if several instances
-- call it, the lock makes the extra calls cheap.
--
-- Old-season pool contents are deliberately NOT deleted here. A season's pool is
-- part of its record and deciding when to archive it is a league/ops decision,
-- not a background cleanup rule.

-- The prune filters by created_at across all leagues, which the recipient-first
-- index cannot serve.
CREATE INDEX IF NOT EXISTS notifications_created_at_idx
  ON public.notifications (created_at);

CREATE OR REPLACE FUNCTION public.prune_internal_history()
RETURNS TABLE (
  notifications_deleted INTEGER,
  draft_heartbeats_deleted INTEGER,
  week_heartbeats_deleted INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notifications INTEGER := 0;
  v_draft_heartbeats INTEGER := 0;
  v_week_heartbeats INTEGER := 0;
BEGIN
  -- One prune at a time across all app-server instances. Returning no rows is a
  -- successful no-op for a concurrent heartbeat.
  IF NOT pg_try_advisory_xact_lock(814771003) THEN
    RETURN;
  END IF;

  DELETE FROM public.notifications
  WHERE created_at < NOW() - INTERVAL '180 days';
  GET DIAGNOSTICS v_notifications = ROW_COUNT;

  DELETE FROM public.draft_sweep_heartbeats
  WHERE invoked_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_draft_heartbeats = ROW_COUNT;

  DELETE FROM public.week_deadline_heartbeats
  WHERE invoked_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_week_heartbeats = ROW_COUNT;

  RETURN QUERY
    SELECT v_notifications, v_draft_heartbeats, v_week_heartbeats;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_internal_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_internal_history() TO service_role;

-- Force PostgREST to pick up the new function immediately.
NOTIFY pgrst, 'reload schema';
