-- League-wide event notifications for the dashboard panel.
--
-- Adds notifications for:
--   * league-settings deadline changes (trade deadline and weekly deadline),
--   * free agent pickups and releases,
--   * a trade reaching the completed state.
--
-- The dashboard panel reads notifications per recipient, so these are fanned out
-- to every active member by a SECURITY DEFINER helper. Clients cannot insert
-- notifications directly; the helper and the trigger functions below are the only
-- new write paths.

-- ------------------------------------------------------------------- helper

-- Inserts one notification for every active member of the league, except the
-- actor and any explicitly excluded members.
--
-- SECURITY DEFINER because `notifications` has no client INSERT policy; the
-- trigger functions that call this are the trusted writers. Excluding the actor
-- keeps a member from being told about an action they just took, and the exclude
-- list lets trade completion skip the two parties, who already receive the
-- existing trade-specific notification.
CREATE OR REPLACE FUNCTION public.notify_league_members(
  p_league_id UUID,
  p_season_id UUID,
  p_actor_user_id UUID,
  p_type TEXT,
  p_message TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_exclude_user_ids UUID[] DEFAULT ARRAY[]::UUID[]
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
    IF p_actor_user_id IS NOT NULL AND v_member = p_actor_user_id THEN
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

REVOKE ALL ON FUNCTION public.notify_league_members(UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID[]) FROM PUBLIC;

-- --------------------------------------------------------- trade completion

-- Announces a completed trade to the rest of the league.
--
-- The two parties are excluded because complete_trade already sends each of them
-- a trade-specific notification; this trigger adds the league-wide line without
-- giving them a duplicate. The actor is excluded by the helper itself.
CREATE OR REPLACE FUNCTION public.notify_trade_completed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposer_name TEXT;
  v_recipient_name TEXT;
BEGIN
  SELECT p.display_name INTO v_proposer_name
  FROM public.profiles p
  WHERE p.id = NEW.proposer_user_id;

  SELECT p.display_name INTO v_recipient_name
  FROM public.profiles p
  WHERE p.id = NEW.recipient_user_id;

  PERFORM public.notify_league_members(
    NEW.league_id,
    NEW.season_id,
    auth.uid(),
    'trade_completed',
    format(
      '%s and %s completed a trade.',
      COALESCE(v_proposer_name, 'A member'),
      COALESCE(v_recipient_name, 'a member')
    ),
    'trade',
    NEW.id,
    ARRAY[NEW.proposer_user_id, NEW.recipient_user_id]
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trades_notify_completed ON public.trades;
CREATE TRIGGER trades_notify_completed
AFTER UPDATE OF status ON public.trades
FOR EACH ROW
WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
EXECUTE FUNCTION public.notify_trade_completed();

-- ------------------------------------------------------------ free agency

-- Announces a free agent pickup or a release to the league.
--
-- Reads the species name from the roster row. Both transaction writers insert
-- their ledger row before removing the roster row (a release) or after adding it
-- (a pickup), so the species is available in both cases. The pool is the fallback
-- for an unusual write that has no roster row, and the slug is the final fallback
-- so a notification is never blank.
CREATE OR REPLACE FUNCTION public.notify_free_agency_move()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_species TEXT;
  v_team_label TEXT;
  v_message TEXT;
BEGIN
  SELECT r.species_name INTO v_species
  FROM public.team_roster r
  WHERE r.team_id = NEW.team_id
    AND r.pokemon_id = NEW.pokemon_id
  LIMIT 1;

  IF v_species IS NULL THEN
    SELECT dpp.species_name INTO v_species
    FROM public.draft_pool_pokemon dpp
    JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
    WHERE dp.league_id = NEW.league_id
      AND dp.season_id = NEW.season_id
      AND dpp.pokemon_id = NEW.pokemon_id
    ORDER BY dp.is_active DESC, dpp.updated_at DESC
    LIMIT 1;
  END IF;

  v_species := COALESCE(v_species, initcap(replace(NEW.pokemon_id, '-', ' ')));

  SELECT COALESCE(p.display_name, t.team_name) INTO v_team_label
  FROM public.teams t
  LEFT JOIN public.profiles p ON p.id = t.owner_user_id
  WHERE t.id = NEW.team_id;

  IF NEW.action = 'added' THEN
    v_message := format(
      '%s was added to %s from free agency.',
      v_species,
      COALESCE(v_team_label, 'a team')
    );
  ELSE
    v_message := format(
      '%s was dropped from %s to free agency.',
      v_species,
      COALESCE(v_team_label, 'a team')
    );
  END IF;

  PERFORM public.notify_league_members(
    NEW.league_id,
    NEW.season_id,
    NEW.user_id,
    CASE
      WHEN NEW.action = 'added' THEN 'free_agent_added'
      ELSE 'free_agent_dropped'
    END,
    v_message,
    'transaction',
    NEW.id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_notify_free_agency ON public.transactions;
CREATE TRIGGER transactions_notify_free_agency
AFTER INSERT ON public.transactions
FOR EACH ROW
WHEN (
  NEW.source IN ('free_agent_pickup', 'release')
  AND NEW.action IN ('added', 'dropped')
)
EXECUTE FUNCTION public.notify_free_agency_move();

-- -------------------------------------------------------------- deadlines

-- Announces an owner's deadline changes.
--
-- Weekly deadlines advance automatically when a deadline passes, and that sweep
-- also rewrites `week_deadline_anchor_date`. Those automatic writes set
-- `week_deadline_last_advanced_at`, so the schedule branch ignores an update that
-- carries that marker. Pause/resume gets its own message because it changes no
-- schedule field.
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
      WHEN NEW.week_deadline_enabled THEN
        'The weekly deadline was updated.'
      ELSE
        'The weekly deadline was turned off.'
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

DROP TRIGGER IF EXISTS league_settings_notify_deadline_change ON public.league_settings;
CREATE TRIGGER league_settings_notify_deadline_change
AFTER UPDATE ON public.league_settings
FOR EACH ROW
EXECUTE FUNCTION public.notify_league_deadline_change();

-- Force PostgREST to pick up the new functions immediately.
NOTIFY pgrst, 'reload schema';
