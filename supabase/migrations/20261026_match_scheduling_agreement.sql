-- Requires two players to agree on a match time before a match is "scheduled".
--
-- A generated matchup previously carried status 'scheduled' from the moment the
-- schedule was created, which claimed an agreement nobody had made: every card
-- read "scheduled" while scheduled_at was still null. The fix is a real state
-- machine rather than a relabelled column.
--
--   unscheduled  no agreed time (the default for a fresh matchup)
--   unscheduled  + a pending proposal row  -> waiting on the other player
--   scheduled    only once the other player accepts, which is what stamps
--                matches.scheduled_at as agreed
--
-- matches.scheduled_at is still populated while a proposal is pending so the
-- card can display what is being proposed, but the match is not "scheduled"
-- until the acceptance lands. Rescheduling an already agreed match drops it back
-- to unscheduled until the opponent accepts again, so a time can never be
-- changed unilaterally.

-- 'unscheduled' joins the status vocabulary and becomes the default for a
-- matchup nobody has agreed a time for.
ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_status_check;

ALTER TABLE public.matches
  ADD CONSTRAINT matches_status_check
  CHECK (status IN ('unscheduled','scheduled','in_progress','completed','forfeit','cancelled'));

ALTER TABLE public.matches
  ALTER COLUMN status SET DEFAULT 'unscheduled';

-- Enforces the invariant at the database rather than in each caller: a match with
-- no time cannot be "scheduled", whatever the inserting function asked for. This
-- covers generate_schedule, generate_playoff_round, and any future insert path
-- without having to redefine those large RPCs.
CREATE OR REPLACE FUNCTION public.matches_default_unscheduled()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scheduled_at IS NULL AND NEW.status = 'scheduled' THEN
    NEW.status := 'unscheduled';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matches_default_unscheduled ON public.matches;
CREATE TRIGGER matches_default_unscheduled
BEFORE INSERT ON public.matches
FOR EACH ROW EXECUTE FUNCTION public.matches_default_unscheduled();

-- A proposed match time awaiting the other player's answer. Rows are immutable
-- history: a new proposal closes the previous one rather than editing it, so the
-- audit trail shows every time that was offered and how it ended.
CREATE TABLE IF NOT EXISTS public.match_scheduling_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  proposed_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  proposed_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  responded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- At most one live proposal per match. This is what makes "one side proposes,
-- the other agrees" unambiguous, and makes a simultaneous double proposal a
-- constraint violation rather than a race.
CREATE UNIQUE INDEX IF NOT EXISTS match_scheduling_proposals_one_pending_uk
  ON public.match_scheduling_proposals (match_id)
  WHERE status = 'pending';

-- Speeds the history a matchup card renders: its proposals, newest first.
CREATE INDEX IF NOT EXISTS match_scheduling_proposals_match_id_idx
  ON public.match_scheduling_proposals (match_id, created_at DESC);

ALTER TABLE public.match_scheduling_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Match participants can view scheduling proposals" ON public.match_scheduling_proposals;

-- Participants read the proposals for their own matches; every write goes through
-- the SECURITY DEFINER RPCs below, which enforce the state machine.
CREATE POLICY "Match participants can view scheduling proposals"
ON public.match_scheduling_proposals
FOR SELECT
TO authenticated
USING (public.is_match_participant(match_id));

-- Existing matchups were created as 'scheduled' with no time and no proposal, so
-- they are exactly the rows this change is about. Open them. A match that already
-- has a time was set under the old direct path and is left as agreed.
UPDATE public.matches
SET status = 'unscheduled', updated_at = NOW()
WHERE scheduled_at IS NULL
  AND status = 'scheduled';

-- -------- RPC: recompute_match_status (revised) --------

-- Same contract as before, with one correction: clearing the last result of a
-- match now returns it to 'unscheduled' when no time was ever agreed, instead of
-- inventing a 'scheduled' status that no player confirmed.
CREATE OR REPLACE FUNCTION public.recompute_match_status(p_match_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match RECORD;
  v_p1_wins INTEGER;
  v_p2_wins INTEGER;
  v_format TEXT;
  v_needed INTEGER;
  v_reset_status TEXT;
BEGIN
  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RETURN 'unscheduled';
  END IF;

  SELECT COALESCE(
    CASE WHEN v_match.is_playoff THEN ls.playoff_match_format ELSE ls.match_format END,
    'best_of_3'
  ) INTO v_format
  FROM public.league_settings ls
  WHERE ls.season_id = v_match.season_id;

  v_needed := CASE WHEN v_format = 'single' THEN 1 ELSE 2 END;

  SELECT
    COUNT(*) FILTER (WHERE winner_team_id = v_match.player_1_team_id),
    COUNT(*) FILTER (WHERE winner_team_id = v_match.player_2_team_id)
  INTO v_p1_wins, v_p2_wins
  FROM public.match_results
  WHERE match_id = p_match_id;

  -- With no games reported the match is either back to its agreed state or back to
  -- having no agreed time, depending on whether one was ever accepted.
  v_reset_status := CASE
    WHEN v_match.scheduled_at IS NULL THEN 'unscheduled'
    ELSE 'scheduled'
  END;

  IF v_p1_wins >= v_needed THEN
    UPDATE public.matches SET status = 'completed', winner_team_id = v_match.player_1_team_id, updated_at = NOW() WHERE id = p_match_id;
    RETURN 'completed';
  ELSIF v_p2_wins >= v_needed THEN
    UPDATE public.matches SET status = 'completed', winner_team_id = v_match.player_2_team_id, updated_at = NOW() WHERE id = p_match_id;
    RETURN 'completed';
  ELSIF v_p1_wins = 0 AND v_p2_wins = 0 THEN
    UPDATE public.matches SET status = v_reset_status, winner_team_id = NULL, updated_at = NOW() WHERE id = p_match_id;
    RETURN v_reset_status;
  ELSE
    UPDATE public.matches SET status = 'in_progress', winner_team_id = NULL, updated_at = NOW() WHERE id = p_match_id;
    RETURN 'in_progress';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_match_status(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_match_status(UUID) TO authenticated;

-- -------- RPC: propose_match_time (participants) --------

-- Offers a time to the opponent. The match stays 'unscheduled' with the time
-- staged for display until the opponent accepts; a previously pending proposal
-- from either side is withdrawn first, so there is never more than one question
-- on the table and neither player can deadlock the match by waiting.
--
-- @param p_match_id - The match to propose a time for.
-- @param p_scheduled_at - The proposed instant.
-- @param p_notes - Optional notes to send along with the proposal.
CREATE OR REPLACE FUNCTION public.propose_match_time(
  p_match_id UUID,
  p_scheduled_at TIMESTAMPTZ,
  p_notes TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_my_team_id UUID;
  v_opponent_team_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to propose a match time.';
  END IF;

  IF p_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'Choose a date and time to propose.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_my_team_id IS NULL THEN
    RAISE EXCEPTION 'Only the participants can propose a match time.';
  END IF;

  v_opponent_team_id := CASE
    WHEN v_match.player_1_team_id = v_my_team_id THEN v_match.player_2_team_id
    ELSE v_match.player_1_team_id
  END;

  -- Close whatever question was already open so the opponent always has exactly
  -- one thing to answer.
  UPDATE public.match_scheduling_proposals
  SET status = 'withdrawn', responded_at = NOW(), responded_by = v_user_id
  WHERE match_id = p_match_id
    AND status = 'pending';

  INSERT INTO public.match_scheduling_proposals (
    match_id, proposed_by, proposed_at, notes, status
  )
  VALUES (
    p_match_id, v_user_id, p_scheduled_at, NULLIF(p_notes, ''), 'pending'
  );

  -- The time is staged on the match so the card can show what is being proposed,
  -- but the status stays unscheduled until the opponent accepts.
  UPDATE public.matches
  SET scheduled_at = p_scheduled_at,
      notes = NULLIF(p_notes, ''),
      status = 'unscheduled',
      updated_at = NOW()
  WHERE id = p_match_id;

  PERFORM public.notify_match_actor(
    v_match.league_id, v_match.season_id, v_opponent_team_id, v_user_id,
    'match_proposed',
    'A match time was proposed for your upcoming match. Accept or decline it on the schedule page.',
    v_match.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.propose_match_time(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_match_time(UUID, TIMESTAMPTZ, TEXT) TO authenticated;

-- -------- RPC: respond_to_match_proposal (the other participant) --------

-- Accepts or declines the pending proposal. Only the player who did not propose
-- may answer, and the proposal row is locked for the transaction so two
-- simultaneous responses cannot both land.
--
-- @param p_match_id - The match being scheduled.
-- @param p_accept - True to agree to the proposed time, false to decline it.
-- @returns The match's status after responding: 'scheduled' or 'unscheduled'.
CREATE OR REPLACE FUNCTION public.respond_to_match_proposal(
  p_match_id UUID,
  p_accept BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_my_team_id UUID;
  v_proposal RECORD;
  v_proposer_team_id UUID;
  v_new_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to respond to a match time.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_my_team_id IS NULL THEN
    RAISE EXCEPTION 'Only the participants can respond to a match time.';
  END IF;

  -- Lock the pending proposal for the rest of the transaction.
  SELECT * INTO v_proposal
  FROM public.match_scheduling_proposals
  WHERE match_id = p_match_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no pending time proposal for this match.';
  END IF;

  IF v_proposal.proposed_by = v_user_id THEN
    RAISE EXCEPTION 'You proposed this time. Wait for your opponent to respond, or withdraw it first.';
  END IF;

  IF p_accept THEN
    UPDATE public.match_scheduling_proposals
    SET status = 'accepted', responded_at = NOW(), responded_by = v_user_id
    WHERE id = v_proposal.id;

    -- The accepted proposal is the authority on the time, so re-stamp it rather
    -- than trusting whatever staged value the match currently carries.
    UPDATE public.matches
    SET scheduled_at = v_proposal.proposed_at,
        status = 'scheduled',
        updated_at = NOW()
    WHERE id = p_match_id;

    v_new_status := 'scheduled';
  ELSE
    UPDATE public.match_scheduling_proposals
    SET status = 'declined', responded_at = NOW(), responded_by = v_user_id
    WHERE id = v_proposal.id;

    -- Declining leaves no agreed time behind, so the matchup reverts to needing
    -- one rather than sitting on a rejected instant.
    UPDATE public.matches
    SET scheduled_at = NULL,
        status = 'unscheduled',
        updated_at = NOW()
    WHERE id = p_match_id;

    v_new_status := 'unscheduled';
  END IF;

  SELECT t.id INTO v_proposer_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_proposal.proposed_by
  LIMIT 1;

  IF v_proposer_team_id IS NOT NULL THEN
    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_proposer_team_id, v_user_id,
      CASE WHEN p_accept THEN 'match_proposal_accepted' ELSE 'match_proposal_declined' END,
      CASE
        WHEN p_accept THEN 'Your proposed match time was accepted.'
        ELSE 'Your proposed match time was declined.'
      END,
      v_match.id
    );
  END IF;

  RETURN v_new_status;
END;
$$;

REVOKE ALL ON FUNCTION public.respond_to_match_proposal(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_to_match_proposal(UUID, BOOLEAN) TO authenticated;

-- -------- RPC: cancel_match_proposal (the proposer) --------

-- Withdraws your own pending proposal. The proposed time is cleared so the card
-- does not keep showing a time nobody is waiting on.
--
-- @param p_match_id - The match to withdraw from.
CREATE OR REPLACE FUNCTION public.cancel_match_proposal(p_match_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_proposal RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to withdraw a match time.';
  END IF;

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
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_match_proposal(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_match_proposal(UUID) TO authenticated;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
