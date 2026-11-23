-- Date and time notifications for the owner, with the new value in the message.
--
-- Deadline and draft-time changes were announced to everyone except the person
-- who made them. That is right for an action like a trade, but not for a league
-- setting: the owner needs the same record in their own notifications panel,
-- and the panel now shows the newest entry at the top.
--
-- This migration:
--   * gives notify_league_members an opt-in include_actor flag,
--   * re-issues the deadline trigger with the flag on for changed dates/times,
--   * re-issues the draft-time trigger so the new instant is in the message and
--     the owner receives it too.
--
-- Timestamps are rendered in UTC inside the message because the text is shared
-- by the whole league. The Draft Board still shows the draft time in each
-- member's own zone.

-- The old 8-argument helper is replaced rather than overloaded: a new trailing
-- default argument would leave two candidates for every existing 7-argument
-- call and PostgreSQL would refuse to pick one.
DROP FUNCTION IF EXISTS public.notify_league_members(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID[]
);

-- Inserts one notification for every active member of the league.
--
-- SECURITY DEFINER because `notifications` has no client INSERT policy; the
-- trigger functions that call this are the trusted writers. The actor is
-- normally skipped so a member is not told about an action they just took;
-- include_actor lets a league-setting change reach the owner as well.
CREATE FUNCTION public.notify_league_members(
  p_league_id UUID,
  p_season_id UUID,
  p_actor_user_id UUID,
  p_type TEXT,
  p_message TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_exclude_user_ids UUID[] DEFAULT ARRAY[]::UUID[],
  p_include_actor BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member UUID;
BEGIN
  FOR v_member IN
    SELECT lm.user_id
    FROM public.league_members lm
    WHERE lm.league_id = p_league_id
      AND lm.is_active = TRUE
  LOOP
    IF NOT p_include_actor
       AND p_actor_user_id IS NOT NULL
       AND v_member = p_actor_user_id THEN
      CONTINUE;
    END IF;

    IF p_exclude_user_ids IS NOT NULL
       AND v_member = ANY (p_exclude_user_ids) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.notifications (
      league_id, season_id, recipient_user_id, actor_user_id, type, message,
      related_entity_type, related_entity_id
    ) VALUES (
      p_league_id, p_season_id, v_member, p_actor_user_id, p_type, p_message,
      p_entity_type, p_entity_id
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_league_members(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID[], BOOLEAN
) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------- deadline wording

-- Re-issues the deadline trigger from 20261192 with include_actor on for every
-- date/time change. Trade and free agency deadlines are instants rendered in
-- UTC; the weekly deadline keeps its calendar date, local time, and zone.
-- Pause/resume is still informational and stays owner-excluded.
CREATE OR REPLACE FUNCTION public.notify_league_deadline_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_automatic_advance BOOLEAN;
  v_old_weekly TEXT;
  v_new_weekly TEXT;
  v_old_trade TEXT;
  v_new_trade TEXT;
  v_old_free_agency TEXT;
  v_new_free_agency TEXT;
  v_paused_changed BOOLEAN;
BEGIN
  IF NEW.trade_deadline_at IS DISTINCT FROM OLD.trade_deadline_at THEN
    v_old_trade := COALESCE(
      to_char(OLD.trade_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );
    v_new_trade := COALESCE(
      to_char(NEW.trade_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'trade_deadline_changed',
      format('The trade deadline was changed from %s to %s.', v_old_trade, v_new_trade),
      'league_settings',
      NEW.id,
      ARRAY[]::UUID[],
      TRUE
    );
  END IF;

  IF NEW.free_agency_deadline_at IS DISTINCT FROM OLD.free_agency_deadline_at THEN
    v_old_free_agency := COALESCE(
      to_char(OLD.free_agency_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );
    v_new_free_agency := COALESCE(
      to_char(NEW.free_agency_deadline_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );

    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'free_agency_deadline_changed',
      format('The free agency deadline was changed from %s to %s.', v_old_free_agency, v_new_free_agency),
      'league_settings',
      NEW.id,
      ARRAY[]::UUID[],
      TRUE
    );
  END IF;

  v_old_weekly := CASE
    WHEN OLD.week_deadline_enabled THEN
      COALESCE(to_char(OLD.week_deadline_anchor_date, 'Mon DD, YYYY'), 'no start date')
        || ' at ' || OLD.week_deadline_time
        || ' (' || OLD.week_deadline_timezone || ')'
    ELSE 'off'
  END;

  v_new_weekly := CASE
    WHEN NEW.week_deadline_enabled THEN
      COALESCE(to_char(NEW.week_deadline_anchor_date, 'Mon DD, YYYY'), 'no start date')
        || ' at ' || NEW.week_deadline_time
        || ' (' || NEW.week_deadline_timezone || ')'
    ELSE 'off'
  END;

  v_automatic_advance :=
    NEW.week_deadline_last_advanced_at IS DISTINCT FROM OLD.week_deadline_last_advanced_at;
  v_paused_changed :=
    NEW.week_deadline_paused IS DISTINCT FROM OLD.week_deadline_paused;

  /*
   * The deadline sweep rewrites the anchor date as it advances a week. That is
   * not an owner change, so the last-advanced marker suppresses it. Comparing
   * the rendered labels also suppresses an edit to a disabled deadline that
   * cannot change what anyone sees.
   */
  IF NOT v_automatic_advance AND v_old_weekly IS DISTINCT FROM v_new_weekly THEN
    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'week_deadline_changed',
      format('The weekly deadline was changed from %s to %s.', v_old_weekly, v_new_weekly),
      'league_settings',
      NEW.id,
      ARRAY[]::UUID[],
      TRUE
    );
  ELSIF v_paused_changed THEN
    PERFORM public.notify_league_members(
      NEW.league_id,
      NEW.season_id,
      auth.uid(),
      'week_deadline_changed',
      CASE
        WHEN NEW.week_deadline_paused THEN
          'The weekly deadline was paused.'
        ELSE
          'The weekly deadline was resumed.'
      END,
      'league_settings',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_league_deadline_change() FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------- draft date/time

-- Re-issues the draft-time trigger from 20261202 so the message names the new
-- instant (or the cleared one) and the owner receives it too.
CREATE OR REPLACE FUNCTION public.notify_draft_time_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_draft TEXT;
  v_new_draft TEXT;
  v_message TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.draft_at IS NOT DISTINCT FROM OLD.draft_at THEN
      RETURN NEW;
    END IF;

    v_old_draft := COALESCE(
      to_char(OLD.draft_at AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI') || ' UTC',
      'not set'
    );
  ELSE
    v_old_draft := 'not set';
  END IF;

  -- An insert with no date is just a league setting up its row; there is
  -- nothing to announce.
  IF NEW.draft_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;

    v_message := format(
      'The draft date and time were cleared (was %s).',
      v_old_draft
    );
  ELSE
    v_new_draft := to_char(
      NEW.draft_at AT TIME ZONE 'UTC',
      'Mon DD, YYYY HH24:MI'
    ) || ' UTC';

    IF TG_OP = 'INSERT' THEN
      v_message := format('The draft date and time were set to %s.', v_new_draft);
    ELSIF OLD.draft_at IS NULL THEN
      v_message := format('The draft date and time were set to %s.', v_new_draft);
    ELSE
      v_message := format('The draft date and time were changed from %s to %s.', v_old_draft, v_new_draft);
    END IF;
  END IF;

  PERFORM public.notify_league_members(
    NEW.league_id,
    NEW.season_id,
    auth.uid(),
    CASE WHEN NEW.draft_at IS NULL THEN 'draft_unscheduled' ELSE 'draft_scheduled' END,
    v_message,
    'league_settings',
    NEW.id,
    ARRAY[]::UUID[],
    TRUE
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_draft_time_change() FROM PUBLIC, anon, authenticated;

-- Force PostgREST to pick up the replaced functions immediately.
NOTIFY pgrst, 'reload schema';
