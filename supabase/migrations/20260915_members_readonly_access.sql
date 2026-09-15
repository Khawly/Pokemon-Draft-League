-- Members Settings read-only access + self-leave
--
-- Adds:
--   - a SELECT policy letting any active member view the membership roster of
--     leagues they belong to (previously SELECT was restricted to one's own row)
--   - a SELECT policy letting members view the basic profiles of their
--     co-members so the roster shows display names and avatars
--   - a SECURITY DEFINER RPC (leave_league) so any member can deactivate only
--     their own membership, without granting a broad UPDATE policy on
--     league_members

-- Members can view the roster of any league they actively belong to.
DROP POLICY IF EXISTS "Members can view their league roster" ON public.league_members;

CREATE POLICY "Members can view their league roster"
ON public.league_members
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.league_members active_member
    WHERE active_member.league_id = league_members.league_id
      AND active_member.user_id = auth.uid()
      AND active_member.is_active = TRUE
  )
);

-- Members can view the basic profile of any active member in a league they
-- belong to, so roster rows resolve display names and avatars.
DROP POLICY IF EXISTS "League members can view co-member profiles" ON public.profiles;

CREATE POLICY "League members can view co-member profiles"
ON public.profiles
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.league_members member
    JOIN public.league_members viewer
      ON viewer.league_id = member.league_id
    WHERE member.user_id = profiles.id
      AND member.is_active = TRUE
      AND viewer.user_id = auth.uid()
      AND viewer.is_active = TRUE
  )
);

-- SECURITY DEFINER RPC that deactivates only the caller's own membership in a
-- league. Validates the sign-in state and that the caller is an active member,
-- and refuses the operation otherwise.
CREATE OR REPLACE FUNCTION public.leave_league(
  p_league_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to leave a league.';
  END IF;

  UPDATE public.league_members
  SET is_active = FALSE
  WHERE league_id = p_league_id
    AND user_id = v_user_id
    AND is_active = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;
END;
$$;