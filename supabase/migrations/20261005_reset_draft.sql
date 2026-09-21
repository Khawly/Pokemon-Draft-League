-- Reset draft RPC
--
-- Lets the league owner return the latest season to its pre-draft state:
-- clears the auto-created team mirror, the pick ledger, rosters,
-- transactions, and priority lists for that season, then flips the season
-- back to draft_pending so start_draft can run again. Deleting rows is done
-- in foreign-key order (picks/roster/transactions before teams).

-- Owner-only RPC that reverts a started/completed draft to draft_pending.
-- Idempotent: a season already in draft_pending is returned unchanged without
-- deleting anything.
--
-- @param p_league_id - The id of the league whose latest season to reset.
-- @returns The id and new (draft_pending) status of the season.
CREATE OR REPLACE FUNCTION public.reset_draft(
  p_league_id UUID
)
RETURNS TABLE (season_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to reset the draft.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can reset the draft.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season exists for this league.';
  END IF;

  IF v_status = 'draft_pending' THEN
    RETURN QUERY SELECT v_season_id, 'draft_pending';
    RETURN;
  END IF;

  -- Tear down the draft's generated state in foreign-key order so nothing the
  -- arena references outlives the reset.
  DELETE FROM public.draft_picks d
  WHERE d.league_id = p_league_id AND d.season_id = v_season_id;

  DELETE FROM public.team_roster r
  USING public.teams t
  WHERE r.team_id = t.id
    AND t.league_id = p_league_id
    AND t.season_id = v_season_id;

  DELETE FROM public.transactions x
  WHERE x.league_id = p_league_id AND x.season_id = v_season_id;

  DELETE FROM public.draft_priority_lists pl
  WHERE pl.season_id = v_season_id;

  DELETE FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  UPDATE public.seasons
  SET status = 'draft_pending',
      draft_started_at = NULL,
      draft_pick_started_at = NULL,
      draft_completed_at = NULL
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_pending';
END;
$$;

-- Restrict the RPC to authenticated users only, like the other engine calls.
REVOKE ALL ON FUNCTION public.reset_draft(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_draft(UUID) TO authenticated;