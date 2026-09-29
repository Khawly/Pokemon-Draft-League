-- Lets a member clear their own notifications from the dashboard panel.
--
-- Previously the only write path on notifications was
-- `mark_notifications_read`, which flips `is_read` and leaves the rows in place.
-- That is right for the Schedule nav badge, which counts unread match-time
-- alerts, but it cannot empty the dashboard's notification panel: the panel lists
-- read and unread alike, so a panel that could only mark rows read would still
-- show every one of them and the control would look like it had done nothing.
--
-- The policy is deliberately narrow and mirrors the SELECT policy beside it: a
-- member may delete only rows addressed to them, and only while they are still an
-- active member of the league. A former member cannot delete a backlog they can
-- no longer read, and no member can delete anyone else's notifications, so the
-- actor's copy of an event is the only thing that changes.
--
-- This is the one place a delete is offered on this table, so it is
-- irreversible: the dashboard's clear button confirms before calling it.

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can delete their own notifications" ON public.notifications;

CREATE POLICY "Users can delete their own notifications"
ON public.notifications
FOR DELETE
TO authenticated
USING (
  recipient_user_id = auth.uid()
  AND public.is_active_league_member(league_id)
);

-- Force PostgREST to pick up the new policy immediately.
NOTIFY pgrst, 'reload schema';
