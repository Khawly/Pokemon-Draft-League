-- Makes rejecting a trade a quorum decision, matching how approving one already works.
--
-- vote_on_trade settled a trade on the first rejection:
--
--   IF v_rejections > 0 THEN
--     RETURN public.reject_trade(p_trade_id, v_user_id);
--   END IF;
--
-- Approval required a strict majority of the approver set but rejection required
-- only one voice, so a single admin could kill a trade in a league where two of
-- three votes would have carried it. With the owner and admins checkbox on, that
-- meant the box looked like a vote and behaved like a veto -- and because the Owner's
-- own Reject button went through the same path, the Owner was told their rejection
-- had settled a trade it had not.
--
-- Rejection now needs the same quorum as approval: (n / 2) + 1. With three
-- owners/admins that is 2 rejections; one rejection leaves the trade pending, so the
-- remaining approvers can still weigh in and an approver can change their mind.
--
-- The Owner keeps a way to settle a trade immediately, which is what the p_override
-- branch above already did for approvals: voting reject with an override rejects on
-- the spot. That is now a distinct button in the UI ("Reject (Override)") rather
-- than overloading the ordinary Reject, so nothing reaches for it by accident.
--
-- Ordering note: rejection is checked before approval, exactly as before. A trade
-- cannot reach a rejection quorum and an approval quorum at the same time, because
-- each member has one vote row (UNIQUE (trade_id, voter_user_id)) and the two
-- thresholds both derive from the same approver count, but keeping the original
-- precedence means no behavioural change beyond the threshold itself.

CREATE OR REPLACE FUNCTION public.vote_on_trade(
  p_trade_id UUID,
  p_approve BOOLEAN,
  p_override BOOLEAN DEFAULT FALSE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_trade RECORD;
  v_is_owner BOOLEAN;
  v_approver_count INTEGER;
  v_required INTEGER;
  v_approvals INTEGER;
  v_rejections INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to vote on a trade.';
  END IF;

  -- FOR UPDATE locks the trade for the rest of the transaction. Without it two
  -- approvers voting at the same moment can both read a vote count below the
  -- quorum and both try to settle it.
  SELECT t.* INTO v_trade FROM public.trades t WHERE t.id = p_trade_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That trade does not exist.';
  END IF;

  IF v_trade.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'That trade is not waiting for approval.';
  END IF;

  v_is_owner := public.is_league_owner(v_trade.league_id);

  IF NOT v_is_owner AND NOT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = v_trade.league_id
      AND lm.user_id = v_user_id
      AND lm.is_active = TRUE
      AND lm.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only the owner and admins can decide a trade.';
  END IF;

  -- The override now applies to a rejection as well as an approval, so the message
  -- names the outcome rather than assuming which way it was cast.
  IF p_override AND NOT v_is_owner THEN
    RAISE EXCEPTION 'Only the owner can override the outcome of a trade.';
  END IF;

  -- The override still gets recorded, so the history shows who settled the trade
  -- and that the quorum was skipped rather than reached.
  INSERT INTO public.trade_votes (trade_id, voter_user_id, decision, is_override)
  VALUES (p_trade_id, v_user_id, CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, COALESCE(p_override, FALSE))
  ON CONFLICT (trade_id, voter_user_id) DO UPDATE
    SET decision = EXCLUDED.decision,
        is_override = EXCLUDED.is_override,
        created_at = NOW();

  IF p_override THEN
    IF p_approve THEN
      RETURN public.complete_trade(p_trade_id, v_user_id);
    END IF;

    RETURN public.reject_trade(p_trade_id, v_user_id);
  END IF;

  -- CARDINALITY counts the approvers. COUNT(*) over this function returned 1 for
  -- every league, which is what let a single vote settle a multi-approver trade.
  v_approver_count := COALESCE(
    CARDINALITY(public.trade_approver_ids(v_trade.league_id, v_trade.season_id)),
    0
  );

  -- An approver set that comes back empty would make every required count 1 and
  -- silently restore the old behaviour, so refuse instead of guessing. This should
  -- be unreachable: trade_approver_ids always includes the owner.
  IF v_approver_count = 0 THEN
    RAISE EXCEPTION 'No eligible approvers found for this league; refusing to decide the trade.';
  END IF;

  v_required := (v_approver_count / 2) + 1;

  -- Only approvers are counted, so a vote from someone who has since lost the role
  -- cannot carry a trade on its own.
  SELECT
    COUNT(*) FILTER (WHERE v.decision = 'approved'),
    COUNT(*) FILTER (WHERE v.decision = 'rejected')
  INTO v_approvals, v_rejections
  FROM public.trade_votes v
  WHERE v.trade_id = p_trade_id
    AND v.voter_user_id = ANY (
      public.trade_approver_ids(v_trade.league_id, v_trade.season_id)
    );

  -- The same quorum that carries an approval now also carries a rejection. One
  -- rejection below it is recorded and counted but leaves the trade pending, so the
  -- rest of the approvers still get to weigh in.
  IF v_rejections >= v_required THEN
    RETURN public.reject_trade(p_trade_id, v_user_id);
  END IF;

  IF v_approvals >= v_required THEN
    RETURN public.complete_trade(p_trade_id, v_user_id);
  END IF;

  RETURN 'pending_approval';
END;
$$;

REVOKE ALL ON FUNCTION public.vote_on_trade(UUID, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vote_on_trade(UUID, BOOLEAN, BOOLEAN) TO authenticated;