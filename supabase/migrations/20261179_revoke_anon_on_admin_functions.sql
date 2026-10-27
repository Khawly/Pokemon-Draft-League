-- Remove Supabase's default anon grant from the new admin functions
--
-- Supabase grants EXECUTE on newly created public functions to anon and
-- authenticated by default, independently of PUBLIC. Revoking from PUBLIC (as
-- the creating migrations did) does not remove those explicit grants.
--
-- delete_league is safe from anon because it checks auth.uid() and league
-- ownership, but it should not be exposed to the anonymous role at all.
-- prune_internal_history is service-role-only maintenance and must not be
-- callable from a browser.

REVOKE EXECUTE ON FUNCTION public.delete_league(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.prune_internal_history() FROM anon, authenticated;

-- Force PostgREST to pick up the grant changes immediately.
NOTIFY pgrst, 'reload schema';
