-- Fixes the trade approval quorum so it reflects the real number of approvers.
--
-- vote_on_trade computed how many approvals a trade needed with:
--
--   SELECT COUNT(*)::INTEGER FROM public.trade_approver_ids(...) AS a
--
-- trade_approver_ids returns UUID[]. Used in a FROM clause, a set-returning
-- function that returns a single array value produces exactly one row, so
-- COUNT(*) counts that row rather than the array's elements and always yields 1.
--
-- The consequence was that v_required was (1 / 2) + 1 = 1 for every league, so a
-- single approval completed any trade awaiting approval. The
-- owners_admins_vote_on_trades setting still decided *who* was eligible to vote --
-- trade_approver_ids builds that set correctly, and the counting query uses
-- = ANY(...) over the same function -- but the *number of approvals required* was
-- pinned at one regardless of how many owners and admins the league had.
--
-- Confirmed in production data before this fix: a league with one owner and one
-- admin completed a trade on the admin's single approval, where the intended
-- quorum is 2 of 2.
--
-- CARDINALITY is the function that counts array elements. It returns 0 for an
-- empty array, never NULL, so the COALESCE is kept only as a belt-and-braces
-- guard against a NULL return from a future redefinition of the helper.
--
-- The majority formula is unchanged: (n / 2) + 1 is integer floor division, which
-- is a correct strict majority for every n. It now receives the real n.

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

  IF p_override AND NOT v_is_owner THEN
    RAISE EXCEPTION 'Only the owner can override an approval.';
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

  IF v_rejections > 0 THEN
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