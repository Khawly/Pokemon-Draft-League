-- Lets the league owner undo a forfeit and return the match to its real state.
-- Adds owner_revert_forfeit. It clears the forfeit's winner and filer, then reuses
-- recompute_match_status, so the match becomes completed, in progress, scheduled,
-- or unscheduled according to the games reported and any agreed time.

-- RPC: owner_revert_forfeit (league owner)
-- Reopens a forfeited match. Errors if the match is not currently a forfeit, so a
-- completed or open match cannot be touched through this path. Returns the status
-- the match was restored to.
CREATE OR REPLACE FUNCTION public.owner_revert_forfeit(p_match_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to revert a forfeit.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.is_league_owner(v_match.league_id) THEN
    RAISE EXCEPTION 'Only the league owner can revert a forfeit.';
  END IF;

  IF v_match.status <> 'forfeit' THEN
    RAISE EXCEPTION 'This match is not forfeited.';
  END IF;

  UPDATE public.matches
  SET winner_team_id = NULL,
      forfeited_by_user_id = NULL,
      updated_at = NOW()
  WHERE id = p_match_id;

  -- Restores completed / in_progress / scheduled / unscheduled from the reported games.
  v_status := public.recompute_match_status(p_match_id);

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.owner_revert_forfeit(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_revert_forfeit(UUID) TO authenticated;
