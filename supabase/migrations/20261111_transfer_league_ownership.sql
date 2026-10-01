-- Adds transfer_league_ownership so an owner can hand a league to an admin, and
-- surfaces a "Promote to Owner" action on admin member cards.
--
-- Why an RPC rather than a client-side update
-- -------------------------------------------
-- Ownership is recorded in leagues.owner_id, not in league_members.role. Every
-- owner-gated policy in the schema reads that column (is_league_owner, and roughly
-- fifteen RLS policies testing l.owner_id = auth.uid()), so promoting someone means
-- moving that column, not editing a role string.
--
-- A client cannot do it safely. The "Owners can update their leagues" policy has
-- WITH CHECK (owner_id = auth.uid()), which forbids the owner from pointing
-- owner_id at anybody else -- the row they would be writing is one they are no
-- longer permitted to own. Making the previous owner the sole owner of a league
-- they just gave away would also leave zero admins able to manage it.
--
-- The handover is therefore one SECURITY DEFINER function that does both writes in
-- a single transaction: leagues.owner_id moves to the new owner, and the old
-- owner's membership row becomes an admin. Both tables always agree, and the
-- league always retains an owner.
--
-- Guards: the caller must be the current owner, the recipient must be an active
-- member of the same league holding the admin role, and the caller cannot promote
-- themselves (they already own it).

CREATE OR REPLACE FUNCTION public.transfer_league_ownership(
  p_league_id UUID,
  p_new_owner_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_current_owner UUID;
  v_new_owner_membership RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to transfer ownership.';
  END IF;

  IF p_new_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Choose a member to promote to Owner.';
  END IF;

  IF p_new_owner_user_id = v_user_id THEN
    RAISE EXCEPTION 'You already own this league.';
  END IF;

  -- FOR UPDATE serialises concurrent handovers, so two owners clicking at once
  -- cannot both pass this check and each believe they handed the league over.
  SELECT l.owner_id INTO v_current_owner
  FROM public.leagues l
  WHERE l.id = p_league_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That league does not exist.';
  END IF;

  IF v_current_owner <> v_user_id THEN
    RAISE EXCEPTION 'Only the league owner can transfer ownership.';
  END IF;

  -- Lock the recipient's membership for the rest of the transaction so their role
  -- or active flag cannot change between this check and the write below.
  SELECT * INTO v_new_owner_membership
  FROM public.league_members lm
  WHERE lm.league_id = p_league_id
    AND lm.user_id = p_new_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That person is not a member of this league.';
  END IF;

  IF NOT v_new_owner_membership.is_active THEN
    RAISE EXCEPTION 'That member has been removed from this league.';
  END IF;

  -- Admin only. The button is owner-only in the UI, but this is the real check and
  -- it must not depend on that: promoting a plain member to owner would let any
  -- owner skip the admin step, and admins are the group the owner has been
  -- explicitly delegating to.
  IF v_new_owner_membership.role <> 'admin' THEN
    RAISE EXCEPTION 'Only an admin can be promoted to Owner.';
  END IF;

  -- Ownership moves first. If the second write fails the transaction rolls back,
  -- so leagues.owner_id never points at someone whose membership row does not
  -- agree with it.
  UPDATE public.leagues
  SET owner_id = p_new_owner_user_id,
      updated_at = NOW()
  WHERE id = p_league_id;

  -- The new owner must hold the owner role on their own membership row, because
  -- the UI renders the role badge from league_members and several role checks
  -- read it directly rather than going through is_league_owner.
  UPDATE public.league_members
  SET role = 'owner'
  WHERE league_id = p_league_id
    AND user_id = p_new_owner_user_id;

  -- The previous owner becomes an admin rather than a plain member, so they keep
  -- working access to league management instead of losing everything on handover.
  UPDATE public.league_members
  SET role = 'admin'
  WHERE league_id = p_league_id
    AND user_id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_league_ownership(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_league_ownership(UUID, UUID) TO authenticated;