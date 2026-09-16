-- Fix infinite RLS recursion on league_members-based policies
--
-- The roster policy ("Members can view their league roster") subselected the
-- same table it was defined on, and the profiles / draft-pool policies
-- subselected league_members while that policy was being evaluated, causing
-- "infinite recursion detected in policy for relation league_members".
--
-- Fix: a SECURITY DEFINER helper (is_active_league_member) performs the
-- membership check outside RLS, so policies can call it without re-entering
-- themselves.

-- SECURITY DEFINER helper that reports whether the calling user is an active
-- member of the given league. Runs as the definer so it bypasses RLS (avoiding
-- recursion) while still checking auth.uid().
CREATE OR REPLACE FUNCTION public.is_active_league_member(p_league_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = p_league_id
      AND lm.user_id = auth.uid()
      AND lm.is_active = TRUE
  );
$$;

-- Do not expose the helper directly to the API; it is only used inside policies.
REVOKE ALL ON FUNCTION public.is_active_league_member(UUID) FROM PUBLIC;

-- Roster access: members of a league can view that league's full membership
-- roster without re-entering the policy through a self-subquery.
DROP POLICY IF EXISTS "Members can view their league roster" ON public.league_members;
CREATE POLICY "Members can view their league roster"
ON public.league_members
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

-- Co-member profiles: a profile row is visible when its owner is an active
-- member of a league the viewer also actively belongs to.
DROP POLICY IF EXISTS "League members can view co-member profiles" ON public.profiles;
CREATE POLICY "League members can view co-member profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.league_members member
    WHERE member.user_id = profiles.id
      AND member.is_active = TRUE
      AND public.is_active_league_member(member.league_id)
  )
);