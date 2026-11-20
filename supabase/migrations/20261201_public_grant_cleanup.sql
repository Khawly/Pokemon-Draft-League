-- Remove the implicit PUBLIC EXECUTE grant from two owner RPCs
--
-- The blanket anon revoke in 20261200 removed the explicit anon grant, but
-- create_league_invite and set_active_draft_pool were created without a
-- REVOKE ... FROM PUBLIC, so anon still inherited EXECUTE through PUBLIC. Both
-- check auth.uid() and league ownership before doing anything, so this is
-- least-privilege cleanup rather than a live data exposure, but the anonymous
-- role should not see them at all.
--
-- Both are called by the browser as a signed-in user, so grant them back to
-- authenticated after removing the PUBLIC and anon grants.

REVOKE EXECUTE ON FUNCTION public.create_league_invite(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_league_invite(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.set_active_draft_pool(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_active_draft_pool(UUID) TO authenticated;

-- Force PostgREST to pick up the grant changes immediately.
NOTIFY pgrst, 'reload schema';
