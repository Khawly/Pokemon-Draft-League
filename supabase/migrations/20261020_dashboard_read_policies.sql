-- Home page reads for trades and notifications
--
-- The Home page shows the signed-in member's open trade proposals and their
-- recent notifications, but `trades` and `notifications` only had RLS enabled
-- with no policies, so RLS denied every read and both cards rendered empty.
-- This migration adds member SELECT policies scoped to the rows a signed-in
-- user is actually party to:
--   - trades: proposals the user sent or received in a league they belong to
--   - notifications: rows addressed to the user
-- Nothing here grants write access; trades are still mutated through RPCs and
-- notifications are still only inserted by definer functions.

-- A signed-in member can view the trade proposals they proposed or were sent
-- in any league they are an active member of. Restricting to the two parties
-- keeps other members' negotiations private.
DROP POLICY IF EXISTS "Members can view their league trades" ON public.trades;
CREATE POLICY "Members can view their league trades"
ON public.trades
FOR SELECT
TO authenticated
USING (
  public.is_active_league_member(league_id)
  AND (proposer_user_id = auth.uid() OR recipient_user_id = auth.uid())
);

-- A signed-in member can view only the notifications addressed to them; the
-- league membership check keeps a former member from reading stale rows after
-- they leave.
DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;
CREATE POLICY "Users can view their own notifications"
ON public.notifications
FOR SELECT
TO authenticated
USING (
  recipient_user_id = auth.uid()
  AND public.is_active_league_member(league_id)
);

-- Force PostgREST to pick up the new policies immediately.
NOTIFY pgrst, 'reload schema';
