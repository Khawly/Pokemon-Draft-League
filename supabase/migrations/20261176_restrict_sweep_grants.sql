-- Restrict the league-wide sweeps to the server heartbeat
--
-- advance_overdue_drafts scans every active draft and calls
-- resolve_draft_timeout for each. It was granted to anon so the app-server
-- heartbeat could call it with the public key. That also made it callable from
-- any browser or script, which is an unnecessary scanning/abuse surface.
--
-- The heartbeat now uses the service-role key, so this migration:
--   - revokes the anon grant from the draft sweep
--   - grants both sweeps to service_role
--   - leaves the weekly sweep's authenticated grant intact because the
--     Schedule page nudges it as the signed-in user
--
-- The advisory-lock guard added in 20261175 still makes concurrent calls cheap;
-- this migration removes the public entry point entirely.

REVOKE EXECUTE ON FUNCTION public.advance_overdue_drafts() FROM anon;
GRANT EXECUTE ON FUNCTION public.advance_overdue_drafts() TO service_role;

REVOKE EXECUTE ON FUNCTION public.advance_overdue_week_deadlines() FROM anon;
GRANT EXECUTE ON FUNCTION public.advance_overdue_week_deadlines() TO service_role;
-- Keep the authenticated Schedule-page nudge; do not re-grant anon.

-- Force PostgREST to pick up the grant changes immediately.
NOTIFY pgrst, 'reload schema';
