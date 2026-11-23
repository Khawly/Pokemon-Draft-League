-- Pokemon shown inside a notification.
--
-- Trade and free-agency notifications name a related trade or transaction, and
-- the dashboard wants to draw the Pokemon those rows involve. The browser cannot
-- read that itself: `trade_items` is scoped to the two parties and league staff,
-- while a completed-trade notice is sent to the whole league.
--
-- This RPC resolves the Pokemon for the caller's own notification ids only. It
-- is SECURITY DEFINER so it can read the underlying rows, and its WHERE clause
-- checks recipient_user_id = auth.uid(), so it cannot be used to inspect another
-- member's notifications.

CREATE OR REPLACE FUNCTION public.notification_pokemon(
  p_notification_ids UUID[]
)
RETURNS TABLE (notification_id UUID, pokemon_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mine AS (
    SELECT n.id, n.related_entity_type, n.related_entity_id
    FROM public.notifications n
    WHERE n.id = ANY (p_notification_ids)
      AND n.recipient_user_id = auth.uid()
  )
  SELECT m.id, ti.pokemon_id
  FROM mine m
  JOIN public.trade_items ti
    ON m.related_entity_type = 'trade'
   AND ti.trade_id = m.related_entity_id
  UNION
  SELECT m.id, t.pokemon_id
  FROM mine m
  JOIN public.transactions t
    ON m.related_entity_type = 'transaction'
   AND t.id = m.related_entity_id
  WHERE t.pokemon_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.notification_pokemon(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_pokemon(UUID[]) TO authenticated;

-- Force PostgREST to pick up the new function immediately.
NOTIFY pgrst, 'reload schema';
