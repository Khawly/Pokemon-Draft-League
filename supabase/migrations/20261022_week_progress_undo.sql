-- Manual week progression, and undo for any week progression
--
-- Adds the owner's "Progress week" control: the league can be moved on by hand
-- instead of waiting for the weekly deadline, and "Undo progress week" reverses
-- the most recent progression. The deadline sweep from 20261021 keeps working
-- unchanged, and both paths are undoable because they share one journal.
--
-- progress_league_week settles the current week immediately (unreported matches
-- become double losses, the week pointer advances, the final week still opens the
-- bracket) while leaving the saved schedule alone, so the next real weekly
-- deadline closes the following week. It works even when automatic closing is off
-- or paused, because the owner pressing the button is the intent.
--
-- Every week that moves - by button or by deadline - is written to
-- week_progress_log, which captures the league_settings snapshot taken before the
-- move plus the matches the progression settled (with the status they had) and
-- any playoff matches it created. undo_league_week_progress replays that journal
-- backwards: matches are reopened, the settle notifications are deleted, a
-- bracket the progression opened is dropped, and the week pointer, schedule, and
-- regular-season flag are restored. It refuses when the league has moved since
-- that progression, so it can never rewind over a change it does not know about.
--
-- Replaces the 3-argument advance_league_week_deadline from 20261021 with a
-- 5-argument version that takes the force and source flags and writes the
-- journal. The owner RPCs in 20261021 keep working unchanged because the new
-- arguments are defaulted.
--
-- Security: progress_league_week and undo_league_week_progress verify league
-- ownership. week_progress_state is a member-level read. The core function is
-- still ungranted, so only these owner RPCs and the sweep can advance a week.

-- -------- undo journal --------

-- Undo journal for week progressions, whether they came from the deadline sweep
-- or from the owner's Progress week button. Each row holds the league_settings
-- snapshot taken before the week moved plus the matches the progression settled,
-- which is everything undo_league_week_progress needs to put the week back.
CREATE TABLE IF NOT EXISTS public.week_progress_log (
  -- Surrogate key.
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- League and season the progression applied to.
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  -- Owner credited as the actor (the sweep falls back to the league owner).
  actor_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- What triggered the progression.
  source TEXT NOT NULL CHECK (source IN ('manual','deadline')),
  -- Week the progression closed, and the week the league moved to.
  from_week INTEGER NOT NULL,
  to_week INTEGER NOT NULL,
  -- league_settings snapshot taken immediately before the progression ran.
  prev_current_week INTEGER NOT NULL,
  prev_anchor_date DATE,
  prev_last_advanced_at TIMESTAMPTZ,
  prev_settled_matches INTEGER NOT NULL,
  prev_regular_season_completed_at TIMESTAMPTZ,
  prev_playoff_state JSONB,
  -- Values the progression left behind. Undo re-checks them first so it refuses
  -- to rewind over a change made after the fact.
  new_current_week INTEGER NOT NULL,
  new_anchor_date DATE,
  new_last_advanced_at TIMESTAMPTZ NOT NULL,
  new_settled_matches INTEGER NOT NULL,
  new_regular_season_completed_at TIMESTAMPTZ,
  -- Matches the progression settled, as [{id, status, winner_team_id, updated_at}].
  settled_count INTEGER NOT NULL DEFAULT 0,
  settled_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Playoff matches the progression created, so undo can drop a bracket it opened.
  created_playoff_matches UUID[] NOT NULL DEFAULT '{}',
  -- When the progression began (the cutoff for undoing its notifications) and
  -- when the week pointer actually moved.
  started_at TIMESTAMPTZ NOT NULL,
  advanced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set once an owner reverts the progression; the row stays as the audit trail.
  undone_at TIMESTAMPTZ,
  undone_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- Serves the "latest progression for this league and season" lookup that undo
-- and the settings screen both run.
CREATE INDEX IF NOT EXISTS week_progress_log_league_season_idx
  ON public.week_progress_log (league_id, season_id, id DESC);

ALTER TABLE public.week_progress_log ENABLE ROW LEVEL SECURITY;

-- Owners read their own league's progression journal; members see the effect in
-- the standings instead. Writes only ever happen inside the SECURITY DEFINER
-- owner RPCs.
DROP POLICY IF EXISTS "Owners can read their league's week progress log" ON public.week_progress_log;

CREATE POLICY "Owners can read their league's week progress log"
ON public.week_progress_log
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.leagues l
  WHERE l.id = week_progress_log.league_id
    AND l.owner_id = auth.uid()
));

-- -------- core: advance one league past its deadline (journaling) --------

-- Replaces the 3-argument version from 20261021 with a 5-argument one that adds
-- the force/source flags and writes the undo journal. Settlement is unchanged:
-- every regular-season match of the closing week that is not already closed
-- becomes a double forfeit (status 'forfeit', no winner), which standings render
-- as a loss for both teams plus the maximum negative differential.
--
-- @param p_league_id - League whose week should be evaluated.
-- @param p_actor_user_id - User credited as the actor on resulting
--   notifications; falls back to the league owner for unattended sweeps.
-- @param p_skip_missed_deadlines - When true (owner resumes from pause), the
--   schedule jumps to the first deadline still in the future after a single
--   step, so a paused gap never retroactively closes every skipped week.
-- @param p_force - When true (owner's Progress week button) the week advances
--   whether or not the deadline is due, ignoring the enabled/paused switches,
--   and the saved schedule is left untouched so the next deadline still closes
--   the following week on its own time.
-- @param p_source - 'manual' or 'deadline', recorded on the undo journal.
-- @returns One of: no_settings, not_enabled, paused, not_configured,
--   no_schedule, not_due, advanced, playoffs_started, playoffs_pending,
--   regular_season_complete.
DROP FUNCTION IF EXISTS public.advance_league_week_deadline(UUID, UUID, BOOLEAN);

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
      SELECT m.id, m.player_1_team_id, m.player_2_team_id, m.status, m.winner_team_id, m.updated_at
      FROM public.matches m
      WHERE m.season_id = v_season_id
        AND m.week_number = v_week
        AND NOT m.is_playoff
        AND m.status NOT IN ('completed','forfeit','cancelled')
      FOR UPDATE
    LOOP
      UPDATE public.matches
      SET status = 'forfeit', winner_team_id = NULL, updated_at = NOW()
      WHERE id = v_match.id;

      v_settled := v_settled + 1;

      -- Keep the pre-update row so undo can reopen the match exactly as it was.
      v_settled_log := v_settled_log || jsonb_build_object(
        'id', v_match.id,
        'status', v_match.status,
        'winner_team_id', v_match.winner_team_id,
        'updated_at', v_match.updated_at
      );

      PERFORM public.notify_match_actor(
        v_settings.league_id, v_season_id, v_match.player_1_team_id, v_actor_id,
        'match_forfeit',
        'The week deadline passed with no result reported, so this match was settled as a double loss.',
        v_match.id
      );
      PERFORM public.notify_match_actor(
        v_settings.league_id, v_season_id, v_match.player_2_team_id, v_actor_id,
        'match_forfeit',
        'The week deadline passed with no result reported, so this match was settled as a double loss.',
        v_match.id
      );
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

-- -------- RPC: progress_league_week (owner) --------

-- Owner-only RPC behind the "Progress week" button. Closes the current week and
-- moves the league on immediately instead of waiting for the deadline: matches
-- nobody reported become double losses exactly as they would at the deadline, the
-- week pointer advances, and closing the final week still opens the bracket. The
-- saved schedule is left alone, so the next weekly deadline then closes the
-- following week. The move is journaled, so it can be undone.
--
-- @returns One of the advance_league_week_deadline statuses.
CREATE OR REPLACE FUNCTION public.progress_league_week(p_league_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to progress the week.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can progress the week.';
  END IF;

  RETURN public.advance_league_week_deadline(p_league_id, v_user_id, FALSE, TRUE, 'manual');
END;
$$;

REVOKE ALL ON FUNCTION public.progress_league_week(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.progress_league_week(UUID) TO authenticated;

-- -------- RPC: undo_league_week_progress (owner) --------

-- Owner-only RPC behind the "Undo progress week" button. Reverts the most recent
-- progression of this league's current season, whether it came from the Progress
-- week button or from the deadline sweep:
--
--   - every match the progression settled goes back to the status it had,
--   - the notifications that progression sent are deleted,
--   - a playoff bracket the progression opened is dropped again,
--   - the week pointer, schedule, and regular-season flag are restored from the
--     snapshot the progression captured.
--
-- It refuses to run when the league has moved since that progression (a newer
-- progression, or an edited schedule), because rewinding on top of a change it
-- does not know about would lose data.
--
-- @returns JSONB with a status of nothing_to_undo, stale, or undone; on undone
--   it also reports what was reverted and whether the still-running deadline will
--   settle the week again (it will if the deadline has already passed).
CREATE OR REPLACE FUNCTION public.undo_league_week_progress(p_league_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_log public.week_progress_log%ROWTYPE;
  v_settings public.league_settings%ROWTYPE;
  v_entry JSONB;
  v_match_id UUID;
  v_prev_status TEXT;
  v_prev_winner UUID;
  v_prev_updated TIMESTAMPTZ;
  v_reopened_ids UUID[] := '{}';
  v_reopened INTEGER := 0;
  v_deleted_playoffs INTEGER := 0;
  v_deleted_notifications INTEGER := 0;
  v_offset INTEGER;
  v_deadline TIMESTAMPTZ;
  v_will_resettle BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to undo a week progression.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can undo a week progression.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  SELECT * INTO v_log
  FROM public.week_progress_log
  WHERE league_id = p_league_id
    AND season_id = v_season_id
    AND undone_at IS NULL
  ORDER BY id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'nothing_to_undo');
  END IF;

  SELECT ls.* INTO v_settings
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  -- Only rewind when the league still looks exactly like that progression left
  -- it; anything else means newer work would be overwritten.
  IF v_settings.current_week IS DISTINCT FROM v_log.new_current_week
    OR v_settings.week_deadline_anchor_date IS DISTINCT FROM v_log.new_anchor_date
    OR v_settings.week_deadline_last_advanced_at IS DISTINCT FROM v_log.new_last_advanced_at
    OR v_settings.week_deadline_settled_matches IS DISTINCT FROM v_log.new_settled_matches
    OR v_settings.regular_season_completed_at IS DISTINCT FROM v_log.new_regular_season_completed_at
  THEN
    RETURN jsonb_build_object(
      'status', 'stale',
      'message', 'The league has moved on since that week was progressed, so it can no longer be undone.'
    );
  END IF;

  -- Reopen the matches the progression settled. The status/winner guard keeps
  -- undo from touching a match that has since been closed by something else.
  FOR v_entry IN SELECT * FROM jsonb_array_elements(COALESCE(v_log.settled_matches, '[]'::jsonb)) LOOP
    v_match_id := (v_entry->>'id')::UUID;
    v_prev_status := v_entry->>'status';
    v_prev_winner := NULLIF(BTRIM(COALESCE(v_entry->>'winner_team_id', '')), '')::UUID;
    v_prev_updated := (v_entry->>'updated_at')::TIMESTAMPTZ;

    UPDATE public.matches
    SET status = v_prev_status,
        winner_team_id = v_prev_winner,
        updated_at = COALESCE(v_prev_updated, NOW())
    WHERE id = v_match_id
      AND season_id = v_season_id
      AND status = 'forfeit'
      AND winner_team_id IS NULL;

    IF FOUND THEN
      v_reopened := v_reopened + 1;
      v_reopened_ids := v_reopened_ids || v_match_id;
    END IF;
  END LOOP;

  -- Drop the bracket the progression created, so undoing the final week also
  -- reopens the playoffs.
  IF COALESCE(array_length(v_log.created_playoff_matches, 1), 0) > 0 THEN
    DELETE FROM public.matches
    WHERE season_id = v_season_id
      AND id = ANY(v_log.created_playoff_matches);

    GET DIAGNOSTICS v_deleted_playoffs = ROW_COUNT;
  END IF;

  UPDATE public.league_settings
  SET current_week = v_log.prev_current_week,
      week_deadline_anchor_date = v_log.prev_anchor_date,
      week_deadline_last_advanced_at = v_log.prev_last_advanced_at,
      week_deadline_settled_matches = v_log.prev_settled_matches,
      regular_season_completed_at = v_log.prev_regular_season_completed_at,
      playoff_state_json = COALESCE(v_log.prev_playoff_state, '{}'::jsonb),
      updated_at = NOW()
  WHERE season_id = v_season_id;

  -- Remove the settle notifications the progression sent, leaving anything sent
  -- before it untouched.
  IF COALESCE(array_length(v_reopened_ids, 1), 0) > 0 THEN
    DELETE FROM public.notifications
    WHERE league_id = p_league_id
      AND related_entity_id = ANY(v_reopened_ids)
      AND type = 'match_forfeit'
      AND created_at >= v_log.started_at;

    GET DIAGNOSTICS v_deleted_notifications = ROW_COUNT;
  END IF;

  UPDATE public.week_progress_log
  SET undone_at = NOW(),
      undone_by = v_user_id
  WHERE id = v_log.id;

  -- A deadline that has already passed will settle the restored week again on
  -- the next heartbeat; the owner needs to pause it to keep the week open.
  IF COALESCE(v_settings.week_deadline_enabled, FALSE)
    AND NOT v_settings.week_deadline_paused
    AND v_log.prev_anchor_date IS NOT NULL
    AND COALESCE(v_settings.regular_season_weeks, 0) >= GREATEST(v_log.prev_current_week, 1)
  THEN
    v_offset := GREATEST(0, (((NOW() AT TIME ZONE v_settings.week_deadline_timezone)::DATE - v_log.prev_anchor_date) / 7));
    v_deadline := public.week_deadline_instant(
      v_log.prev_anchor_date,
      v_settings.week_deadline_time,
      v_settings.week_deadline_timezone,
      v_offset
    );
    v_will_resettle := v_deadline IS NOT NULL AND NOW() >= v_deadline;
  END IF;

  RETURN jsonb_build_object(
    'status', 'undone',
    'from_week', v_log.to_week,
    'to_week', v_log.from_week,
    'matches_reopened', v_reopened,
    'playoff_matches_deleted', v_deleted_playoffs,
    'notifications_deleted', v_deleted_notifications,
    'will_resettle', v_will_resettle
  );
END;
$$;

REVOKE ALL ON FUNCTION public.undo_league_week_progress(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.undo_league_week_progress(UUID) TO authenticated;

-- -------- RPC: week_progress_state --------

-- Read-only snapshot the settings screen uses to describe the week controls: where
-- the league is, how many matches of the current week are still unreported,
-- whether a week can be progressed or an existing progression undone, and what
-- the latest journalled progression did.
--
-- @returns JSONB with the progression state, or a no_settings status.
CREATE OR REPLACE FUNCTION public.week_progress_state(p_league_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_settings public.league_settings%ROWTYPE;
  v_latest public.week_progress_log%ROWTYPE;
  v_season_id UUID;
  v_week INTEGER;
  v_total_weeks INTEGER;
  v_unreported INTEGER := 0;
  v_playoff_matches INTEGER := 0;
  v_offset INTEGER;
  v_deadline TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to view week progress.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT ls.* INTO v_settings
  FROM public.league_settings ls
  JOIN public.seasons s ON s.id = ls.season_id
  WHERE ls.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_settings');
  END IF;

  v_season_id := v_settings.season_id;
  v_total_weeks := COALESCE(v_settings.regular_season_weeks, 0);
  v_week := GREATEST(COALESCE(v_settings.current_week, 0), 1);

  IF v_settings.week_deadline_anchor_date IS NOT NULL THEN
    v_offset := GREATEST(0, (((NOW() AT TIME ZONE v_settings.week_deadline_timezone)::DATE - v_settings.week_deadline_anchor_date) / 7));
    v_deadline := public.week_deadline_instant(
      v_settings.week_deadline_anchor_date,
      v_settings.week_deadline_time,
      v_settings.week_deadline_timezone,
      v_offset
    );
  END IF;

  SELECT COUNT(*) INTO v_unreported
  FROM public.matches m
  WHERE m.season_id = v_season_id
    AND m.week_number = v_week
    AND NOT m.is_playoff
    AND m.status NOT IN ('completed','forfeit','cancelled');

  SELECT COUNT(*) INTO v_playoff_matches
  FROM public.matches m
  WHERE m.season_id = v_season_id AND m.is_playoff;

  SELECT * INTO v_latest
  FROM public.week_progress_log
  WHERE league_id = p_league_id
    AND season_id = v_season_id
    AND undone_at IS NULL
  ORDER BY id DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'ok',
    'current_week', v_week,
    'total_weeks', v_total_weeks,
    'unreported_matches', v_unreported,
    'regular_season_completed', v_settings.regular_season_completed_at IS NOT NULL,
    'playoffs_started', v_playoff_matches > 0,
    'deadline_enabled', v_settings.week_deadline_enabled,
    'deadline_paused', v_settings.week_deadline_paused,
    'next_deadline', v_deadline,
    -- Nothing to progress once the regular season is frozen or the schedule has
    -- no weeks left.
    'can_progress', v_settings.regular_season_completed_at IS NULL AND v_total_weeks >= v_week,
    'can_undo', v_latest.id IS NOT NULL,
    'latest_progress', CASE
      WHEN v_latest.id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'id', v_latest.id,
        'source', v_latest.source,
        'from_week', v_latest.from_week,
        'to_week', v_latest.to_week,
        'settled_count', v_latest.settled_count,
        'advanced_at', v_latest.advanced_at,
        'playoff_matches', COALESCE(array_length(v_latest.created_playoff_matches, 1), 0)
      )
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.week_progress_state(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.week_progress_state(UUID) TO authenticated;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
