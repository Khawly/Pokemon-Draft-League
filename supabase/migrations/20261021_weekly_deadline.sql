-- Weekly league deadline, league format, and automatic week progression
--
-- Adds an owner-configurable recurring weekly deadline to league_settings: the
-- owner picks the first deadline's calendar date, a local wall-clock time, and
-- an IANA time zone, and the deadline then repeats every 7 days in that zone.
-- Recurrence is calendar arithmetic on DATE (anchor + 7 * n days) converted
-- once with AT TIME ZONE, so the deadline keeps the same local time across
-- daylight-saving transitions instead of drifting an hour twice a year.
--
-- When a deadline passes, the season is settled and moved on: every
-- regular-season match of the closing week that nobody reported becomes a
-- double forfeit (both teams take the loss and the maximum negative KO
-- differential), the week pointer advances, and once the final regular week
-- closes the playoff bracket is opened.
--
-- Adds league_format (6v6 / 4v4) because the maximum negative differential
-- depends on team size: -(games needed to win) * Pokemon per team, i.e. -12 for
-- a 6v6 best-of-3 and -8 for a 4v4 best-of-3. A double forfeit charges both
-- teams -(match_format games) * (format size), so the differential is symmetric
-- by construction.
--
-- Security: the sweep is SECURITY DEFINER and granted to anon strictly so the
-- app-server heartbeat and a client-side nudge can reach it, mirroring
-- advance_overdue_drafts. It only ever advances a week that is already past its
-- deadline, so it cannot be used to rush a league. The owner RPCs
-- (set_league_format / set_week_deadline / set_week_deadline_paused) verify
-- league ownership. Per league the sweep steps into the league owner's identity
-- (request.jwt.claims) so the engine's auth.uid() membership and bracket-seed
-- checks pass; leagues that error are skipped and retried by the next tick.

-- -------- league_settings: league format + weekly deadline --------

-- League format (team size per side) and the full weekly deadline state.
-- current_week is the explicit progression pointer the deadline sweep advances;
-- 0 means "not started" and is initialized to the first week that still has an
-- undecided match the first time an owner configures a deadline.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS league_format TEXT NOT NULL DEFAULT '6v6' CHECK (league_format IN ('6v6','4v4')),
  ADD COLUMN IF NOT EXISTS week_deadline_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS week_deadline_anchor_date DATE,
  ADD COLUMN IF NOT EXISTS week_deadline_time TEXT NOT NULL DEFAULT '20:00' CHECK (week_deadline_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  ADD COLUMN IF NOT EXISTS week_deadline_timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS week_deadline_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS week_deadline_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS week_deadline_last_advanced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS week_deadline_settled_matches INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_week INTEGER NOT NULL DEFAULT 0 CHECK (current_week >= 0),
  ADD COLUMN IF NOT EXISTS regular_season_completed_at TIMESTAMPTZ;

-- Audit trail for advance_overdue_week_deadlines invocations, mirroring
-- draft_sweep_heartbeats so we can tell whether the app-server heartbeat is
-- actually reaching the database.
CREATE TABLE IF NOT EXISTS public.week_deadline_heartbeats (
  -- Surrogate key.
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- When the sweep ran.
  invoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- How many leagues advanced a week (or opened playoffs) on that sweep.
  leagues_advanced INTEGER NOT NULL DEFAULT 0
);

-- -------- helper: resolving a deadline to an absolute instant --------

-- Resolves one weekly deadline to an absolute UTC instant. The anchor date is
-- advanced by whole weeks before the local time is applied, so the deadline is
-- stable across DST changes.
--
-- @returns The deadline instant, or NULL when p_time is blank.
CREATE OR REPLACE FUNCTION public.week_deadline_instant(
  p_anchor_date DATE,
  p_time TEXT,
  p_timezone TEXT,
  p_weeks_offset INTEGER DEFAULT 0
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_time TIME;
BEGIN
  IF p_anchor_date IS NULL THEN
    RETURN NULL;
  END IF;

  v_time := NULLIF(BTRIM(p_time), '')::TIME;
  IF v_time IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN (
    (p_anchor_date + (COALESCE(p_weeks_offset, 0) * 7))::TIMESTAMP + v_time
  ) AT TIME ZONE COALESCE(NULLIF(BTRIM(p_timezone), ''), 'UTC');
END;
$$;

REVOKE ALL ON FUNCTION public.week_deadline_instant(DATE, TEXT, TEXT, INTEGER) FROM PUBLIC;

-- -------- standings: double forfeits --------

-- Ranks every team of the league's latest season by wins, losses, and KO Diff.
-- A closed match with no winner is a double forfeit: it counts as a loss for
-- both teams and charges each the maximum negative differential for the
-- season's league format (-12 for a 6v6 best-of-3, -8 for a 4v4 best-of-3,
-- -6 for a 6v6 single game). Reported games still drive the normal per-game
-- differential, so a decided match is unaffected.
CREATE OR REPLACE FUNCTION public.season_standings(p_league_id UUID)
RETURNS TABLE (team_id UUID, team_name TEXT, wins BIGINT, losses BIGINT, ko_diff BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_match_format TEXT := 'best_of_3';
  v_league_format TEXT := '6v6';
  v_games_to_win INTEGER := 2;
  v_team_size INTEGER := 6;
  v_double_forfeit_diff BIGINT := -12;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to view standings.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  SELECT COALESCE(ls.match_format, 'best_of_3'), COALESCE(ls.league_format, '6v6')
  INTO v_match_format, v_league_format
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  v_games_to_win := CASE WHEN v_match_format = 'single' THEN 1 ELSE 2 END;
  v_team_size := CASE WHEN v_league_format = '4v4' THEN 4 ELSE 6 END;
  v_double_forfeit_diff := (v_games_to_win * v_team_size) * -1;

  RETURN QUERY
  SELECT
    t.id AS team_id,
    t.team_name AS team_name,
    (SELECT COUNT(*)::BIGINT FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.status IN ('completed','forfeit') AND m.winner_team_id = t.id) AS wins,
    (SELECT COUNT(*)::BIGINT FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.status IN ('completed','forfeit')
        AND (m.winner_team_id IS NULL OR m.winner_team_id <> t.id)
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS losses,
    (SELECT COALESCE(SUM(CASE WHEN mr.winner_team_id = t.id THEN mr.pokemon_left_alive ELSE -mr.pokemon_left_alive END), 0)::BIGINT
      FROM public.match_results mr
      JOIN public.matches m ON m.id = mr.match_id
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND mr.pokemon_left_alive IS NOT NULL
        AND t.id IN (m.player_1_team_id, m.player_2_team_id))
    + (SELECT COUNT(*)::BIGINT * v_double_forfeit_diff
      FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.status IN ('completed','forfeit') AND m.winner_team_id IS NULL
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS ko_diff
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id
  ORDER BY wins DESC, losses ASC, ko_diff DESC, t.team_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.season_standings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.season_standings(UUID) TO authenticated;

-- -------- core: advance one league past its deadline --------

-- Settles and advances a single league when its weekly deadline is due. Shared
-- by the owner RPCs and the heartbeat sweep; not callable directly.
--
-- Settlement rule: every regular-season match of the closing week that is not
-- already closed becomes a double forfeit (status 'forfeit', no winner), which
-- standings render as a loss for both teams plus the maximum negative
-- differential. Decided matches are left untouched.
--
-- @param p_league_id - League whose deadline should be evaluated.
-- @param p_actor_user_id - User credited as the actor on resulting
--   notifications; falls back to the league owner for unattended sweeps.
-- @param p_skip_missed_deadlines - When true (owner resumes from pause), the
--   schedule jumps to the first deadline still in the future after a single
--   step, so a paused gap never retroactively closes every skipped week.
-- @returns One of: no_settings, not_enabled, paused, not_configured,
--   no_schedule, not_due, advanced, playoffs_started, regular_season_complete.
CREATE OR REPLACE FUNCTION public.advance_league_week_deadline(
  p_league_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_skip_missed_deadlines BOOLEAN DEFAULT FALSE
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
  v_playoff_matches INTEGER := 0;
  v_match RECORD;
BEGIN
  -- Bracket generation is the heaviest step here; the engine precedent lifts
  -- the role-level statement/lock caps the same way.
  PERFORM set_config('statement_timeout', '60000', true);
  PERFORM set_config('lock_timeout', '45000', true);

  SELECT ls.* INTO v_settings
  FROM public.league_settings ls
  JOIN public.seasons s ON s.id = ls.season_id
  WHERE ls.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 'no_settings';
  END IF;

  v_season_id := v_settings.season_id;
  SELECT s.status INTO v_season_status FROM public.seasons s WHERE s.id = v_season_id;
  SELECT l.owner_id INTO v_owner_id FROM public.leagues l WHERE l.id = p_league_id;
  v_actor_id := COALESCE(p_actor_user_id, v_owner_id);

  -- "Close each week automatically" is the master switch: with it off (or
  -- paused) nothing progresses automatically, including the bracket.
  IF NOT v_settings.week_deadline_enabled THEN
    RETURN 'not_enabled';
  END IF;

  IF v_settings.week_deadline_paused THEN
    RETURN 'paused';
  END IF;

  -- Regular season already finished: keep retrying to open the bracket, which
  -- needs a completed draft and a settled field.
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

  IF v_settings.week_deadline_anchor_date IS NULL THEN
    RETURN 'not_configured';
  END IF;

  v_total_weeks := COALESCE(v_settings.regular_season_weeks, 0);
  IF v_total_weeks < 1 THEN
    RETURN 'no_schedule';
  END IF;

  v_week := GREATEST(COALESCE(v_settings.current_week, 0), 1);

  v_anchor := v_settings.week_deadline_anchor_date;
  v_time := v_settings.week_deadline_time;
  v_timezone := v_settings.week_deadline_timezone;

  -- Whole weeks elapsed since the anchor, measured on the league's own calendar
  -- so the comparison matches what the owner sees.
  v_offset := GREATEST(0, (((NOW() AT TIME ZONE v_timezone)::DATE - v_anchor) / 7));
  v_deadline := public.week_deadline_instant(v_anchor, v_time, v_timezone, v_offset);

  IF v_week <= v_total_weeks THEN
    IF NOW() < v_deadline THEN
      RETURN 'not_due';
    END IF;

    -- Resuming from a pause steps once and then resumes on the next future
    -- deadline, so the weeks the league deliberately skipped are not settled.
    IF p_skip_missed_deadlines THEN
      WHILE public.week_deadline_instant(v_anchor, v_time, v_timezone, v_offset + 1) <= NOW() LOOP
        v_offset := v_offset + 1;
      END LOOP;
    END IF;

    v_next_anchor := v_anchor + ((v_offset + 1) * 7);

    FOR v_match IN
      SELECT m.id, m.player_1_team_id, m.player_2_team_id
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

    IF v_week < v_total_weeks THEN
      UPDATE public.league_settings
      SET current_week = v_week + 1,
          week_deadline_anchor_date = v_next_anchor,
          week_deadline_last_advanced_at = NOW(),
          week_deadline_settled_matches = v_settled,
          updated_at = NOW()
      WHERE season_id = v_season_id;

      RETURN 'advanced';
    END IF;

    -- Final regular week closed: freeze the regular season.
    UPDATE public.league_settings
    SET current_week = v_week,
        regular_season_completed_at = NOW(),
        week_deadline_anchor_date = v_next_anchor,
        week_deadline_last_advanced_at = NOW(),
        week_deadline_settled_matches = v_settled,
        updated_at = NOW()
    WHERE season_id = v_season_id;
  ELSE
    -- Every regular week is already decided (a deadline configured after the
    -- fact seeded the pointer past the last week): close the season out.
    UPDATE public.league_settings
    SET regular_season_completed_at = COALESCE(regular_season_completed_at, NOW()),
        updated_at = NOW()
    WHERE season_id = v_season_id;
  END IF;

  BEGIN
    -- Scoped to this transaction, so the sweep loop can step into a different
    -- owner's identity on the next iteration without the previous one
    -- shadowing it.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_id::text)::text, true);
    PERFORM public.generate_playoff_round(p_league_id);
    RETURN 'playoffs_started';
  EXCEPTION WHEN OTHERS THEN
    -- A draft that is not complete yet (or a field that is not settled) is
    -- retried on a later tick; the owner can also advance the bracket manually.
    RETURN 'playoffs_pending';
  END;
END;
$$;

-- Not granted to any role: only the owner RPCs below and the sweep call this,
-- and both run as the table owner via SECURITY DEFINER. Keeping it unexposed
-- stops any signed-in user from advancing an arbitrary league by hand.
REVOKE ALL ON FUNCTION public.advance_league_week_deadline(UUID, UUID, BOOLEAN) FROM PUBLIC;

-- -------- RPC: set_league_format (owner) --------

-- Owner-only RPC that sets the league's team size per side. The size decides the
-- maximum negative KO differential a double forfeit charges (-12 for a 6v6
-- best-of-3, -8 for a 4v4 best-of-3).
CREATE OR REPLACE FUNCTION public.set_league_format(
  p_league_id UUID,
  p_league_format TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to change the league format.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can change the league format.';
  END IF;

  IF p_league_format IS NULL OR p_league_format NOT IN ('6v6','4v4') THEN
    RAISE EXCEPTION 'Invalid league format.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  INSERT INTO public.league_settings (league_id, season_id, league_format, updated_at)
  VALUES (p_league_id, v_season_id, p_league_format, NOW())
  ON CONFLICT (league_id, season_id)
  DO UPDATE SET league_format = EXCLUDED.league_format, updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.set_league_format(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_league_format(UUID, TEXT) TO authenticated;

-- -------- RPC: set_week_deadline (owner) --------

-- Owner-only RPC that configures the recurring weekly deadline. The first
-- deadline's calendar date, local time, and IANA time zone are stored; every
-- later deadline is that date plus whole weeks, so the local time never drifts
-- across daylight-saving changes. Disabling clears the pause. The first time a
-- deadline is configured the week pointer is seeded to the first week that
-- still has an undecided match, so a league already mid-season does not get
-- week 1 settled.
CREATE OR REPLACE FUNCTION public.set_week_deadline(
  p_league_id UUID,
  p_enabled BOOLEAN,
  p_first_deadline_date DATE,
  p_time TEXT,
  p_timezone TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_settings public.league_settings%ROWTYPE;
  v_start_week INTEGER;
  v_total_weeks INTEGER;
  v_time TIME;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to set the weekly deadline.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can set the weekly deadline.';
  END IF;

  IF COALESCE(p_enabled, FALSE) THEN
    IF p_first_deadline_date IS NULL THEN
      RAISE EXCEPTION 'Pick the date of the first weekly deadline.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
      RAISE EXCEPTION 'Unknown time zone: %', COALESCE(p_timezone, 'null');
    END IF;

    BEGIN
      v_time := BTRIM(COALESCE(p_time, ''))::TIME;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid deadline time. Use 24-hour HH:MM.';
    END;

    IF v_time IS NULL THEN
      RAISE EXCEPTION 'Invalid deadline time. Use 24-hour HH:MM.';
    END IF;
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  -- The row normally exists from league creation; create a bare one so the
  -- update below always has a target.
  INSERT INTO public.league_settings (league_id, season_id, updated_at)
  VALUES (p_league_id, v_season_id, NOW())
  ON CONFLICT (league_id, season_id) DO NOTHING;

  SELECT ls.* INTO v_settings
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  v_total_weeks := COALESCE(v_settings.regular_season_weeks, 0);

  IF COALESCE(v_settings.current_week, 0) = 0 THEN
    -- Seed the pointer to the first week that still needs to be played, so a
    -- league already mid-season is not sent back to week 1. When every regular
    -- week is decided the pointer lands past the last week, which closes the
    -- regular season on the next deadline.
    SELECT COALESCE(MIN(m.week_number), v_total_weeks + 1) INTO v_start_week
    FROM public.matches m
    WHERE m.season_id = v_season_id
      AND NOT m.is_playoff
      AND m.status NOT IN ('completed','forfeit','cancelled');
  ELSE
    v_start_week := v_settings.current_week;
  END IF;

  UPDATE public.league_settings
  SET week_deadline_enabled = COALESCE(p_enabled, FALSE),
      -- Disabling keeps the last configured schedule so it can be re-enabled
      -- without re-entering it.
      week_deadline_anchor_date = CASE
        WHEN COALESCE(p_enabled, FALSE) THEN p_first_deadline_date
        ELSE week_deadline_anchor_date
      END,
      week_deadline_time = CASE
        WHEN COALESCE(p_enabled, FALSE) THEN COALESCE(NULLIF(BTRIM(p_time), ''), '20:00')
        ELSE week_deadline_time
      END,
      week_deadline_timezone = CASE
        WHEN COALESCE(p_enabled, FALSE) THEN COALESCE(NULLIF(BTRIM(p_timezone), ''), 'UTC')
        ELSE week_deadline_timezone
      END,
      week_deadline_paused = FALSE,
      week_deadline_paused_at = NULL,
      current_week = CASE
        WHEN COALESCE(v_settings.current_week, 0) = 0 THEN GREATEST(v_start_week, 0)
        ELSE v_settings.current_week
      END,
      updated_at = NOW()
  WHERE season_id = v_season_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_week_deadline(UUID, BOOLEAN, DATE, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_week_deadline(UUID, BOOLEAN, DATE, TEXT, TEXT) TO authenticated;

-- -------- RPC: set_week_deadline_paused (owner) --------

-- Owner-only RPC that pauses or resumes the weekly deadline. Pausing stops the
-- countdown without changing the schedule. Resuming immediately evaluates the
-- deadline: if it already passed, the league progresses one week (settling that
-- week's unreported matches) and the next deadline is the first one still in
-- the future, so a paused gap is never settled retroactively.
CREATE OR REPLACE FUNCTION public.set_week_deadline_paused(
  p_league_id UUID,
  p_paused BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can pause the weekly deadline.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  IF COALESCE(p_paused, FALSE) THEN
    UPDATE public.league_settings
    SET week_deadline_paused = TRUE,
        week_deadline_paused_at = NOW(),
        updated_at = NOW()
    WHERE season_id = v_season_id;
    RETURN;
  END IF;

  UPDATE public.league_settings
  SET week_deadline_paused = FALSE,
      week_deadline_paused_at = NULL,
      updated_at = NOW()
  WHERE season_id = v_season_id;

  PERFORM public.advance_league_week_deadline(p_league_id, v_user_id, TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.set_week_deadline_paused(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_week_deadline_paused(UUID, BOOLEAN) TO authenticated;

-- -------- heartbeat sweep --------

-- Advances every league whose weekly deadline is due. Called on the app-server
-- heartbeat (and nudged by the Schedule page) so a deadline passes even when no
-- browser is open; mirrors advance_overdue_drafts.
--
-- @returns The number of leagues that advanced a week or opened playoffs.
CREATE OR REPLACE FUNCTION public.advance_overdue_week_deadlines()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league_row RECORD;
  v_status TEXT;
  v_advanced INTEGER := 0;
BEGIN
  FOR v_league_row IN
    SELECT ls.league_id, l.owner_id
    FROM public.league_settings ls
    JOIN public.seasons s ON s.id = ls.season_id
    JOIN public.leagues l ON l.id = ls.league_id
    WHERE ls.week_deadline_enabled
      AND NOT ls.week_deadline_paused
      AND s.status <> 'archived'
    GROUP BY ls.league_id, l.owner_id
  LOOP
    BEGIN
      -- The bracket seed and membership checks read auth.uid(); step into the
      -- league owner's role for this league. The claim is transaction-scoped so
      -- each iteration replaces the previous league's identity instead of
      -- being shadowed by it.
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_league_row.owner_id::text)::text, true);

      v_status := public.advance_league_week_deadline(v_league_row.league_id, v_league_row.owner_id, FALSE);

      IF v_status IN ('advanced','playoffs_started','playoffs_pending') THEN
        v_advanced := v_advanced + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Unresolvable league (owner no longer an active member, mid-state
      -- change): skip it, the next heartbeat will retry.
      NULL;
    END;
  END LOOP;

  INSERT INTO public.week_deadline_heartbeats (leagues_advanced)
  VALUES (v_advanced);

  RETURN v_advanced;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_overdue_week_deadlines() FROM PUBLIC;
-- anon covers the app-server heartbeat; authenticated covers the Schedule
-- page's nudge, which PostgREST runs as the signed-in user's role.
GRANT EXECUTE ON FUNCTION public.advance_overdue_week_deadlines() TO anon, authenticated;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
