-- Owner notice when a member leaves, and vacancy-aware week settlement.
--
-- A member who leaves keeps their team row because the draft, roster, schedule
-- and results reference it. This migration:
--   * notifies the league owner when an active member leaves,
--   * settles a deadline matchup containing a vacated team as a forfeit win for
--     the remaining team rather than as a double loss.
--
-- Vacancy is derived from league_members.is_active, the same rule the invite
-- flow uses to hand a vacated team to a replacement.

-- Re-issues the self-leave RPC with an owner notification. The membership write
-- is unchanged: only the caller's own row is deactivated, and the notification
-- is addressed to the league owner rather than to the departing member.
CREATE OR REPLACE FUNCTION public.leave_league(
  p_league_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_owner_id UUID;
  v_season_id UUID;
  v_display_name TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to leave a league.';
  END IF;

  UPDATE public.league_members
  SET is_active = FALSE
  WHERE league_id = p_league_id
    AND user_id = v_user_id
    AND is_active = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT l.owner_id INTO v_owner_id
  FROM public.leagues l
  WHERE l.id = p_league_id;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  SELECT p.display_name INTO v_display_name
  FROM public.profiles p
  WHERE p.id = v_user_id;

  /*
   * The owner is skipped when they are the one leaving: notifying an account
   * that just gave up its access would only leave an unread row behind. A
   * league with no season has nowhere to attach the dashboard notification.
   */
  IF v_owner_id IS NOT NULL
     AND v_owner_id <> v_user_id
     AND v_season_id IS NOT NULL
  THEN
    INSERT INTO public.notifications (
      league_id,
      season_id,
      recipient_user_id,
      actor_user_id,
      type,
      message,
      related_entity_type,
      related_entity_id
    ) VALUES (
      p_league_id,
      v_season_id,
      v_owner_id,
      v_user_id,
      'member_left',
      format('%s left the league.', COALESCE(v_display_name, 'A member')),
      'league_member',
      v_user_id
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_league(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_league(UUID) TO authenticated;

-- Re-issues the week-deadline progression with vacancy-aware settlement.
--
-- A regular-season matchup that includes a team whose owner is no longer an
-- active member cannot be played. When the deadline closes its week, the
-- remaining team gets the win instead of both sides being charged a double
-- loss. Settlement is still a single `forfeit` row: the standings already read
-- a forfeit with a winner as a win for that team and a loss for the other.
--
-- Everything else about the progression (journaling, undo, bracket opening,
-- pause and schedule behavior) is unchanged from 20261022.
CREATE OR REPLACE FUNCTION public.advance_league_week_deadline(
  p_league_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_skip_missed_deadlines BOOLEAN DEFAULT FALSE,
  p_force BOOLEAN DEFAULT FALSE,
  p_source TEXT DEFAULT 'deadline'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings public.league_settings%ROWTYPE;
  v_season_id UUID;
  v_season_status TEXT;
  v_owner_id UUID;
  v_actor_id UUID;
  v_anchor DATE;
  v_time TEXT;
  v_timezone TEXT;
  v_offset INTEGER;
  v_deadline TIMESTAMPTZ;
  v_next_anchor DATE;
  v_week INTEGER;
  v_total_weeks INTEGER;
  v_settled INTEGER := 0;
  v_settled_log JSONB := '[]'::jsonb;
  v_playoff_matches INTEGER := 0;
  v_match RECORD;
  v_winner_team_id UUID;
  -- league_settings snapshot taken before anything is written.
  v_prev_week INTEGER;
  v_prev_anchor DATE;
  v_prev_settled_matches INTEGER;
  v_prev_last_advanced TIMESTAMPTZ;
  v_prev_completed TIMESTAMPTZ;
  v_prev_playoff_state JSONB;
  -- Values this progression is about to write.
  v_next_week INTEGER;
  v_next_settled INTEGER := 0;
  v_next_completed TIMESTAMPTZ;
  v_playoffs_before UUID[];
  v_playoffs_after UUID[];
  v_created_playoffs UUID[] := '{}';
  v_close_season BOOLEAN := FALSE;
  v_journal BOOLEAN := FALSE;
  v_status TEXT;
  v_started_at TIMESTAMPTZ := NOW();
BEGIN
  -- Bracket generation is the heaviest step here; the engine precedent lifts
  -- the role-level statement/lock caps the same way.
  PERFORM set_config('statement_timeout', '60000', true);
  PERFORM set_config('lock_timeout', '45000', true);

  -- Row lock so a manual progress and the sweep cannot both move the same week
  -- (and write two undo entries for it). Lock order is settings then matches,
  -- which is the same order the settlement below uses.
  SELECT ls.* INTO v_settings
  FROM public.league_settings ls
  JOIN public.seasons s ON s.id = ls.season_id
  WHERE ls.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1
  FOR UPDATE OF ls;

  IF NOT FOUND THEN
    RETURN 'no_settings';
  END IF;

  v_season_id := v_settings.season_id;
  SELECT s.status INTO v_season_status FROM public.seasons s WHERE s.id = v_season_id;
  SELECT l.owner_id INTO v_owner_id FROM public.leagues l WHERE l.id = p_league_id;
  v_actor_id := COALESCE(p_actor_user_id, v_owner_id);

  -- "Close each week automatically" is the master switch: with it off (or
  -- paused) nothing progresses automatically, including the bracket. A forced
  -- progression is the owner pressing the button, so it ignores both.
  IF NOT p_force THEN
    IF NOT v_settings.week_deadline_enabled THEN
      RETURN 'not_enabled';
    END IF;

    IF v_settings.week_deadline_paused THEN
      RETURN 'paused';
    END IF;
  END IF;

  -- Regular season already finished: keep retrying to open the bracket, which
  -- needs a completed draft and a settled field. This continues the progression
  -- that closed the regular season, so it is not journaled again.
  IF v_settings.regular_season_completed_at IS NOT NULL THEN
    SELECT COUNT(*) INTO v_playoff_matches
    FROM public.matches m
    WHERE m.season_id = v_season_id AND m.is_playoff;

    IF v_playoff_matches > 0 OR v_season_status <> 'draft_complete' THEN
      RETURN 'regular_season_complete';
    END IF;

    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_id::text)::text, true);
      PERFORM public.generate_playoff_round(p_league_id);
      RETURN 'playoffs_started';
    EXCEPTION WHEN OTHERS THEN
      -- A draft that is not complete yet (or a field that is not settled) is
      -- retried on a later tick; the owner can also advance the bracket manually.
      RETURN 'playoffs_pending';
    END;
  END IF;

  IF v_settings.week_deadline_anchor_date IS NULL AND NOT p_force THEN
    RETURN 'not_configured';
  END IF;

  v_total_weeks := COALESCE(v_settings.regular_season_weeks, 0);
  IF v_total_weeks < 1 THEN
    RETURN 'no_schedule';
  END IF;

  v_week := GREATEST(COALESCE(v_settings.current_week, 0), 1);

  v_prev_week := COALESCE(v_settings.current_week, 0);
  v_prev_anchor := v_settings.week_deadline_anchor_date;
  v_prev_settled_matches := v_settings.week_deadline_settled_matches;
  v_prev_last_advanced := v_settings.week_deadline_last_advanced_at;
  v_prev_completed := v_settings.regular_season_completed_at;
  v_prev_playoff_state := v_settings.playoff_state_json;

  v_anchor := v_settings.week_deadline_anchor_date;
  v_time := v_settings.week_deadline_time;
  v_timezone := v_settings.week_deadline_timezone;

  -- Whole weeks elapsed since the anchor, measured on the league's own calendar
  -- so the comparison matches what the owner sees.
  v_offset := GREATEST(0, (((NOW() AT TIME ZONE v_timezone)::DATE - v_anchor) / 7));
  v_deadline := public.week_deadline_instant(v_anchor, v_time, v_timezone, v_offset);

  v_next_week := v_week;
  v_next_settled := v_settled;
  v_next_completed := v_settings.regular_season_completed_at;

  IF v_week <= v_total_weeks THEN
    IF NOT p_force AND NOW() < v_deadline THEN
      RETURN 'not_due';
    END IF;

    -- Resuming from a pause steps once and then resumes on the next future
    -- deadline, so the weeks the league deliberately skipped are not settled.
    IF p_skip_missed_deadlines THEN
      WHILE public.week_deadline_instant(v_anchor, v_time, v_timezone, v_offset + 1) <= NOW() LOOP
        v_offset := v_offset + 1;
      END LOOP;
    END IF;

    v_next_anchor := CASE
      WHEN p_force THEN v_anchor
      ELSE v_anchor + ((v_offset + 1) * 7)
    END;

    FOR v_match IN
      SELECT
        m.id,
        m.player_1_team_id,
        m.player_2_team_id,
        m.status,
        m.winner_team_id,
        m.updated_at,
        EXISTS (
          SELECT 1
          FROM public.teams t
          JOIN public.league_members lm
            ON lm.league_id = t.league_id
           AND lm.user_id = t.owner_user_id
           AND lm.is_active = TRUE
          WHERE t.id = m.player_1_team_id
        ) AS player_1_active,
        EXISTS (
          SELECT 1
          FROM public.teams t
          JOIN public.league_members lm
            ON lm.league_id = t.league_id
           AND lm.user_id = t.owner_user_id
           AND lm.is_active = TRUE
          WHERE t.id = m.player_2_team_id
        ) AS player_2_active
      FROM public.matches m
      WHERE m.season_id = v_season_id
        AND m.week_number = v_week
        AND NOT m.is_playoff
        AND m.status NOT IN ('completed','forfeit','cancelled')
      FOR UPDATE
    LOOP
      /*
       * A side whose owner left has no one to play the match. Award the win to
       * the remaining side; a matchup with both owners still present (or both
       * gone) keeps the existing double-loss settlement.
       */
      v_winner_team_id := NULL;

      IF v_match.player_2_team_id IS NOT NULL
         AND v_match.player_1_active <> v_match.player_2_active
      THEN
        v_winner_team_id := CASE
          WHEN v_match.player_1_active THEN v_match.player_1_team_id
          ELSE v_match.player_2_team_id
        END;
      END IF;

      UPDATE public.matches
      SET status = 'forfeit', winner_team_id = v_winner_team_id, updated_at = NOW()
      WHERE id = v_match.id;

      v_settled := v_settled + 1;

      -- Keep the pre-update row so undo can reopen the match exactly as it was.
      v_settled_log := v_settled_log || jsonb_build_object(
        'id', v_match.id,
        'status', v_match.status,
        'winner_team_id', v_match.winner_team_id,
        'updated_at', v_match.updated_at
      );

      IF v_winner_team_id IS NOT NULL THEN
        PERFORM public.notify_match_actor(
          v_settings.league_id, v_season_id, v_winner_team_id, v_actor_id,
          'match_forfeit',
          'The week deadline passed and your opponent has left the league, so this match was settled as a forfeit win.',
          v_match.id
        );
      ELSE
        /*
         * Skip a vacated side: its owner has no access, so the row would only
         * sit unread. A normal unreported matchup still tells both players.
         */
        IF v_match.player_1_active THEN
          PERFORM public.notify_match_actor(
            v_settings.league_id, v_season_id, v_match.player_1_team_id, v_actor_id,
            'match_forfeit',
            'The week deadline passed with no result reported, so this match was settled as a double loss.',
            v_match.id
          );
        END IF;

        IF v_match.player_2_active THEN
          PERFORM public.notify_match_actor(
            v_settings.league_id, v_season_id, v_match.player_2_team_id, v_actor_id,
            'match_forfeit',
            'The week deadline passed with no result reported, so this match was settled as a double loss.',
            v_match.id
          );
        END IF;
      END IF;
    END LOOP;

    v_next_settled := v_settled;

    IF v_week < v_total_weeks THEN
      v_next_week := v_week + 1;
    ELSE
      -- Final regular week closed: freeze the regular season.
      v_next_completed := NOW();
      v_close_season := TRUE;
    END IF;

    UPDATE public.league_settings
    SET current_week = v_next_week,
        regular_season_completed_at = v_next_completed,
        week_deadline_anchor_date = v_next_anchor,
        week_deadline_last_advanced_at = NOW(),
        week_deadline_settled_matches = v_next_settled,
        updated_at = NOW()
    WHERE season_id = v_season_id;

    v_journal := TRUE;
  ELSE
    -- Every regular week is already decided (a deadline configured after the
    -- fact seeded the pointer past the last week): close the season out.
    UPDATE public.league_settings
    SET regular_season_completed_at = COALESCE(regular_season_completed_at, NOW()),
        updated_at = NOW()
    WHERE season_id = v_season_id;

    v_close_season := TRUE;
  END IF;

  IF v_close_season THEN
    -- Diff the playoff matches around bracket generation so undo knows which
    -- ones this progression is responsible for.
    SELECT COALESCE(array_agg(m.id), '{}') INTO v_playoffs_before
    FROM public.matches m
    WHERE m.season_id = v_season_id AND m.is_playoff;

    BEGIN
      -- Scoped to this transaction, so the sweep loop can step into a different
      -- owner's identity on the next iteration without the previous one
      -- shadowing it.
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_id::text)::text, true);
      PERFORM public.generate_playoff_round(p_league_id);
      v_status := 'playoffs_started';
    EXCEPTION WHEN OTHERS THEN
      -- A draft that is not complete yet (or a field that is not settled) is
      -- retried on a later tick; the owner can also advance the bracket manually.
      v_status := 'playoffs_pending';
    END;

    SELECT COALESCE(array_agg(m.id), '{}') INTO v_playoffs_after
    FROM public.matches m
    WHERE m.season_id = v_season_id AND m.is_playoff;

    v_created_playoffs := ARRAY(
      SELECT unnest(v_playoffs_after)
      EXCEPT
      SELECT unnest(v_playoffs_before)
    );
  END IF;

  -- Journal the move so the owner can undo it.
  IF v_journal THEN
    INSERT INTO public.week_progress_log (
      league_id, season_id, actor_user_id, source, from_week, to_week,
      prev_current_week, prev_anchor_date, prev_last_advanced_at, prev_settled_matches,
      prev_regular_season_completed_at, prev_playoff_state,
      new_current_week, new_anchor_date, new_last_advanced_at, new_settled_matches,
      new_regular_season_completed_at, settled_count, settled_matches,
      created_playoff_matches, started_at
    ) VALUES (
      v_settings.league_id, v_season_id, v_actor_id, COALESCE(p_source, 'deadline'),
      v_week, v_next_week,
      v_prev_week, v_prev_anchor, v_prev_last_advanced, v_prev_settled_matches,
      v_prev_completed, v_prev_playoff_state,
      v_next_week, v_next_anchor, NOW(), v_next_settled,
      v_next_completed, v_settled, v_settled_log,
      v_created_playoffs, v_started_at
    );
  END IF;

  RETURN COALESCE(v_status, 'advanced');
END;
$$;

-- Not granted to any role: only the owner RPCs below and the sweep call this,
-- and both run as the table owner via SECURITY DEFINER. Keeping it unexposed
-- stops any signed-in user from advancing an arbitrary league by hand.
REVOKE ALL ON FUNCTION public.advance_league_week_deadline(UUID, UUID, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
