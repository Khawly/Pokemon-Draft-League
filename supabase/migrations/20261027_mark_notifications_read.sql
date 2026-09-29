-- Lets a member mark their own notifications as read.
--
-- The dashboard has always displayed notifications as a running history, which
-- is fine there, but it means a notification can never be cleared. The schedule
-- page needs the opposite: a member answering a proposed match time has to be
-- able to dismiss the notice, or the card sits there forever telling them to
-- accept a time they already answered.
--
-- Read state is per notification and owned by the recipient, so the write is
-- scoped by `auth.uid()` in the WHERE clause rather than by trusting a passed-in
-- recipient id. The function is SECURITY DEFINER only because `notifications`
-- has no UPDATE policy by design; it grants nothing beyond flipping the caller's
-- own rows.

-- Marks the caller's notifications as read, optionally only a named set.
--
-- @param p_notification_ids - Notifications to mark read; an empty or null array
--   marks every one of the caller's unread notifications as read.
-- @returns The number of rows updated.
CREATE OR REPLACE FUNCTION public.mark_notifications_read(
  p_notification_ids UUID[] DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to mark notifications as read.';
  END IF;

  IF p_notification_ids IS NULL OR array_length(p_notification_ids, 1) IS NULL THEN
    UPDATE public.notifications
    SET is_read = TRUE
    WHERE recipient_user_id = v_user_id
      AND is_read = FALSE;
  ELSE
    UPDATE public.notifications
    SET is_read = TRUE
    WHERE recipient_user_id = v_user_id
      AND id = ANY(p_notification_ids)
      AND is_read = FALSE;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_notifications_read(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(UUID[]) TO authenticated;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
