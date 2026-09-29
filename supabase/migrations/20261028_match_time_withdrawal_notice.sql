-- Notifies the opponent when a proposed match time is withdrawn.
--
-- `propose_match_time`, `respond_to_match_proposal` and the result submission all
-- tell the other participant what happened, but withdrawing a proposal did not.
-- That left the recipient looking at a question that had already been taken off
-- the table, and it meant a withdrawal was invisible to the nav's match-time
-- alert badge. The alert is the only place a member sees that the other side
-- pulled a proposal, so the notice has to exist for it to work.
--
-- The withdrawal itself is unchanged: only the pending proposal is closed and the
-- staged time is cleared, and only the player who proposed may withdraw it.

CREATE OR REPLACE FUNCTION public.cancel_match_proposal(p_match_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_proposal RECORD;
  v_opponent_team_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to withdraw a match time.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  -- Lock the pending proposal for the rest of the transaction.
  SELECT * INTO v_proposal
  FROM public.match_scheduling_proposals
  WHERE match_id = p_match_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no pending time proposal for this match.';
  END IF;

  IF v_proposal.proposed_by <> v_user_id THEN
    RAISE EXCEPTION 'Only the player who proposed a time can withdraw it.';
  END IF;

  UPDATE public.match_scheduling_proposals
  SET status = 'withdrawn', responded_at = NOW(), responded_by = v_user_id
  WHERE id = v_proposal.id;

  UPDATE public.matches
  SET scheduled_at = NULL, status = 'unscheduled', updated_at = NOW()
  WHERE id = p_match_id;

  -- Tell the other player the question is gone, so they stop waiting on it.
  SELECT t.id INTO v_opponent_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_opponent_team_id IS NOT NULL THEN
    v_opponent_team_id := CASE
      WHEN v_opponent_team_id = v_match.player_1_team_id THEN v_match.player_2_team_id
      ELSE v_match.player_1_team_id
    END;

    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_opponent_team_id, v_user_id,
      'match_proposal_withdrawn',
      'A proposed match time was withdrawn, so the matchup needs a new one.',
      v_match.id
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_match_proposal(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_match_proposal(UUID) TO authenticated;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
