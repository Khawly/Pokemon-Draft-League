-- Delete a league's matches before the league row
--
-- matches.winner_team_id references teams with ON DELETE NO ACTION (unlike the
-- other team/season foreign keys, which cascade). Deleting a league cascades
-- through seasons -> teams and seasons -> matches, and PostgreSQL does not
-- guarantee that the match rows are removed before the team rows. In that
-- order, the winner reference can block the team deletion.
--
-- delete_league therefore removes the league's matches explicitly first. That
-- also removes match_results and match_scheduling_proposals through their
-- existing cascades, so the subsequent league delete only has cascading
-- references left.
--
-- This replaces the function added in 20261178; the ownership check and grant
-- surface are unchanged.

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

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can delete this league.';
  END IF;

  -- See the header: the winner team reference is NO ACTION, so remove matches
  -- before the league cascade can delete the teams they point at.
  DELETE FROM public.matches
  WHERE league_id = p_league_id;

  DELETE FROM public.leagues
  WHERE id = p_league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That league no longer exists.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_league(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_league(UUID) TO authenticated, service_role;
-- Supabase grants new functions to anon by default; revoke it explicitly.
REVOKE EXECUTE ON FUNCTION public.delete_league(UUID) FROM anon;

NOTIFY pgrst, 'reload schema';
