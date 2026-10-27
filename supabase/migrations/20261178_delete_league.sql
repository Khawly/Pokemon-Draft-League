-- Permanently delete a league and all of its data
--
-- The league settings page now has an owner-only "Delete League" action. A
-- direct DELETE from the browser would be the wrong boundary: it must be
-- impossible for a non-owner to remove a league, and the whole removal needs to
-- be one transaction.
--
-- Every league-scoped table references public.leagues(id) with ON DELETE
-- CASCADE (seasons, settings, teams, rosters, draft pools/picks/priorities,
-- transactions, trades/items/votes, matches/results/proposals, rules,
-- notifications, invites, and week progress). Deleting the league row therefore
-- removes the entire league atomically.
--
-- Global tables deliberately survive: type_chart, the Pokémon catalog, user
-- availability, and the aggregate heartbeat audit tables are not league data.
--
-- This function does not clear local browser preferences; the client clears the
-- selected league/season after the RPC succeeds.

CREATE OR REPLACE FUNCTION public.delete_league(p_league_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  -- Ownership is leagues.owner_id, matching the rest of the owner-only actions.
  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can delete this league.';
  END IF;

  DELETE FROM public.leagues
  WHERE id = p_league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That league no longer exists.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_league(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_league(UUID) TO authenticated, service_role;

-- Force PostgREST to pick up the new function immediately.
NOTIFY pgrst, 'reload schema';
