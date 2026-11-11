-- Clarifies the weekly-deadline notification wording.
--
-- The first version said "turned off" whenever the weekly deadline was disabled,
-- even when the enabled flag had not changed and only its time or zone was edited.
-- A settings edit now reads as an update; "turned on"/"turned off" is reserved for
-- an actual change of the enabled flag.

CREATE OR REPLACE FUNCTION public.notify_league_deadline_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_automatic_advance BOOLEAN;
  v_weekly_changed BOOLEAN;
  v_paused_changed BOOLEAN;
  v_message TEXT;
BEGIN
  IF NEW.trade_deadline_at IS DISTINCT FROM OLD.trade_deadline_at THEN
    v_message := CASE
      WHEN NEW.trade_deadline_at IS NULL THEN
        'The trade deadline was removed.'
      ELSE
        'The trade deadline was updated.'
    END;

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'trade_deadline_changed',
      v_message,
      'league_settings',
      NEW.id
    );
  END IF;

  v_automatic_advance :=
    NEW.week_deadline_last_advanced_at IS DISTINCT FROM OLD.week_deadline_last_advanced_at;

  v_weekly_changed :=
    NOT v_automatic_advance
    AND (
      NEW.week_deadline_enabled IS DISTINCT FROM OLD.week_deadline_enabled
      OR NEW.week_deadline_anchor_date IS DISTINCT FROM OLD.week_deadline_anchor_date
      OR NEW.week_deadline_time IS DISTINCT FROM OLD.week_deadline_time
      OR NEW.week_deadline_timezone IS DISTINCT FROM OLD.week_deadline_timezone
    );

  v_paused_changed :=
    NEW.week_deadline_paused IS DISTINCT FROM OLD.week_deadline_paused;

  IF v_weekly_changed THEN
    v_message := CASE
      WHEN NEW.week_deadline_enabled IS DISTINCT FROM OLD.week_deadline_enabled
        AND NEW.week_deadline_enabled THEN
        'The weekly deadline was turned on.'
      WHEN NEW.week_deadline_enabled IS DISTINCT FROM OLD.week_deadline_enabled THEN
        'The weekly deadline was turned off.'
      ELSE
        'The weekly deadline was updated.'
    END;

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'week_deadline_changed',
      v_message,
      'league_settings',
      NEW.id
    );
  ELSIF v_paused_changed THEN
    v_message := CASE
      WHEN NEW.week_deadline_paused THEN
        'The weekly deadline was paused.'
      ELSE
        'The weekly deadline was resumed.'
    END;

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'week_deadline_changed',
      v_message,
      'league_settings',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
