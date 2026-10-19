-- Adds the Toilet Bowl: a single-elimination consolation bracket for the teams that miss
-- the playoff field.
--
-- It is a real bracket in the same table as the playoffs rather than a separate concept:
-- same match rows, same bye handling, same advance button. Only the phase tells it apart,
-- so a game is addressed by (phase, week, slot) exactly as the playoff games are and the
-- two brackets can run in the same weeks without colliding.
--
-- The bracket reuses playoff_bracket_structure for its shape. A single-elimination
-- structure is the same tree whatever it is for, and writing a second one would mean two
-- places to keep the reverse-seeding and bye rules in step. What differs is which phase
-- the games are written under and which seeds feed them, and both are handled here.

ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_bracket_phase_check;

ALTER TABLE public.matches
  ADD CONSTRAINT matches_bracket_phase_check
  CHECK (bracket_phase IS NULL OR bracket_phase IN ('upper', 'lower', 'gf', 'toilet'));

-- The teams that missed the playoff field, best record first.
--
-- Read from the frozen playoff seeds rather than from the current standings, so the
-- consolation field cannot change under a bracket that is already being played. The
-- standings still decide the order, which is what seeds the bracket.
--
-- @returns The non-playoff teams in seed order, or an empty array when nobody missed out.
CREATE OR REPLACE FUNCTION public.toilet_seeds(
  p_league_id UUID,
  p_season_id UUID,
  p_playoff_teams INTEGER
) RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state JSONB;
  v_seeds UUID[] := ARRAY[]::UUID[];
  v_i INTEGER;
  v_toilet UUID[];
BEGIN
  SELECT COALESCE(playoff_state_json, '{}'::JSONB) INTO v_state
  FROM public.league_settings
  WHERE season_id = p_season_id;

  IF jsonb_typeof(v_state -> 'seeds') = 'array' THEN
    FOR v_i IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seeds := v_seeds || ARRAY[(v_state -> 'seeds' ->> v_i)::UUID]::UUID[];
    END LOOP;
  END IF;

  -- Nothing is frozen yet, so the playoff field is not decided and there is no field to
  -- leave anybody out of.
  IF array_length(v_seeds, 1) IS NULL THEN
    RETURN ARRAY[]::UUID[];
  END IF;

  SELECT ARRAY(
    SELECT st.team_id
    FROM public.season_standings(p_league_id) st
    WHERE NOT (st.team_id = ANY (v_seeds))
    ORDER BY st.wins DESC, st.losses ASC, st.ko_diff DESC, st.team_name ASC
  ) INTO v_toilet;

  RETURN COALESCE(v_toilet, ARRAY[]::UUID[]);
END;
$$;

-- True when a toilet game has finished, or was never created and never will be.
--
-- Mirrors playoff_game_resolved: a game absent from the table is not necessarily pending,
-- because a bye or an eliminated pair can leave it permanently uncreated.
CREATE OR REPLACE FUNCTION public.toilet_game_resolved(
  p_league_id UUID,
  p_season_id UUID,
  p_seeds UUID[],
  p_field_size INTEGER,
  p_base_weeks INTEGER,
  p_label TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_status TEXT;
  v_a_ready BOOLEAN;
  v_b_ready BOOLEAN;
BEGIN
  SELECT * INTO v_row
  FROM public.playoff_bracket_structure(p_field_size, p_base_weeks, 'single_elimination')
  WHERE phase = 'upper' AND game_label = p_label;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT m.status INTO v_status
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.bracket_phase = 'toilet'
    AND m.week_number = v_row.week
    AND m.bracket_slot = v_row.slot;

  IF v_status IS NOT NULL THEN
    RETURN v_status IN ('completed', 'forfeit', 'cancelled');
  END IF;

  SELECT f.ready INTO v_a_ready
  FROM public.toilet_feeder_team(
    p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks,
    v_row.feeder_a_kind, v_row.feeder_a_ref
  ) f;

  SELECT f.ready INTO v_b_ready
  FROM public.toilet_feeder_team(
    p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks,
    v_row.feeder_b_kind, v_row.feeder_b_ref
  ) f;

  RETURN COALESCE(v_a_ready, FALSE) AND COALESCE(v_b_ready, FALSE);
END;
$$;

-- Resolves one side of a toilet game to the team standing in it.
--
-- A side is ready when the game feeding it has finished, or will never exist. A game that
-- finished without a winner -- both sides forfeited -- leaves no team to advance, so the
-- slot resolves to nothing rather than to a team that has already been eliminated.
--
-- @returns The team in the side, and whether the side can be resolved yet.
CREATE OR REPLACE FUNCTION public.toilet_feeder_team(
  p_league_id UUID,
  p_season_id UUID,
  p_seeds UUID[],
  p_field_size INTEGER,
  p_base_weeks INTEGER,
  p_kind TEXT,
  p_ref TEXT
) RETURNS TABLE (team UUID, ready BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winner UUID;
  v_p1 UUID;
  v_p2 UUID;
  v_status TEXT;
BEGIN
  IF p_kind = 'seed' THEN
    RETURN QUERY SELECT p_seeds[p_ref::INTEGER], TRUE;
    RETURN;
  END IF;

  IF p_kind = 'empty' THEN
    RETURN QUERY SELECT NULL::UUID, TRUE;
    RETURN;
  END IF;

  IF NOT public.toilet_game_resolved(
    p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks, p_ref
  ) THEN
    RETURN QUERY SELECT NULL::UUID, FALSE;
    RETURN;
  END IF;

  SELECT m.winner_team_id, m.player_1_team_id, m.player_2_team_id, m.status
  INTO v_winner, v_p1, v_p2, v_status
  FROM public.playoff_bracket_structure(p_field_size, p_base_weeks, 'single_elimination') src
  JOIN public.matches m
    ON m.league_id = p_league_id
   AND m.season_id = p_season_id
   AND m.is_playoff
   AND m.bracket_phase = 'toilet'
   AND m.week_number = src.week
   AND m.bracket_slot = src.slot
  WHERE src.phase = 'upper' AND src.game_label = p_ref
  LIMIT 1;

  IF v_status IS NULL THEN
    RETURN QUERY SELECT NULL::UUID, TRUE;
    RETURN;
  END IF;

  IF v_winner IS NULL THEN
    -- Settled with nobody winning: both sides took the loss and neither advances.
    RETURN QUERY SELECT NULL::UUID, TRUE;
    RETURN;
  END IF;

  -- A winner came from one side, so the other side is the loser of that game.
  RETURN QUERY SELECT (CASE WHEN v_winner = v_p1 THEN v_p2 ELSE v_p1 END), TRUE;
END;
$$;

-- Creates every toilet-bowl game whose feeders have finished.
--
-- Runs alongside the playoff advance and is called from it, so one press of the button
-- moves both brackets. Returns zero when the setting is off, when the playoff field is not
-- decided yet, or when there is nobody left out.
--
-- @returns How many toilet games were created.
CREATE OR REPLACE FUNCTION public.toilet_advance(
  p_league_id UUID,
  p_season_id UUID,
  p_base_weeks INTEGER,
  p_playoff_teams INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_seeds UUID[];
  v_field INTEGER;
  v_row RECORD;
  v_a UUID;
  v_b UUID;
  v_a_ready BOOLEAN;
  v_b_ready BOOLEAN;
  v_count INTEGER := 0;
BEGIN
  SELECT COALESCE(enable_toilet_bowl, FALSE) INTO v_enabled
  FROM public.league_settings
  WHERE season_id = p_season_id;

  IF NOT FOUND OR NOT v_enabled THEN
    RETURN 0;
  END IF;

  v_seeds := public.toilet_seeds(p_league_id, p_season_id, p_playoff_teams);
  v_field := COALESCE(array_length(v_seeds, 1), 0);

  -- Nobody to play, or a single team who would simply be given the bracket.
  IF v_field < 2 THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT src.*
    FROM public.playoff_bracket_structure(v_field, p_base_weeks, 'single_elimination') AS src
    WHERE src.phase = 'upper'
    ORDER BY src.round_no, src.slot
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.matches m
      WHERE m.league_id = p_league_id
        AND m.season_id = p_season_id
        AND m.is_playoff
        AND m.bracket_phase = 'toilet'
        AND m.week_number = v_row.week
        AND m.bracket_slot = v_row.slot
    ) THEN
      CONTINUE;
    END IF;

    SELECT f.team, f.ready INTO v_a, v_a_ready
    FROM public.toilet_feeder_team(
      p_league_id, p_season_id, v_seeds, v_field, p_base_weeks,
      v_row.feeder_a_kind, v_row.feeder_a_ref
    ) f;

    SELECT f.team, f.ready INTO v_b, v_b_ready
    FROM public.toilet_feeder_team(
      p_league_id, p_season_id, v_seeds, v_field, p_base_weeks,
      v_row.feeder_b_kind, v_row.feeder_b_ref
    ) f;

    IF NOT (v_a_ready AND v_b_ready) THEN
      CONTINUE;
    END IF;

    -- Both sides empty means nobody advances, so there is no game to record.
    IF v_a IS NOT NULL OR v_b IS NOT NULL THEN
      IF public.playoff_insert_game(
        p_league_id, p_season_id, v_row.week, v_a, v_b, 'toilet', v_row.slot, NULL
      ) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.toilet_seeds(UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toilet_game_resolved(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toilet_feeder_team(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toilet_advance(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toilet_seeds(UUID, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toilet_game_resolved(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toilet_feeder_team(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toilet_advance(UUID, UUID, INTEGER, INTEGER) TO authenticated;
-- Advances the playoff bracket and the toilet bowl together.
--
-- Same function as before, with the consolation bracket advanced alongside it and its
-- byes settled in the same pass. One press of Advance Playoffs has to move both: a member
-- reading the Playoffs tab sees two brackets that share a button, and a bracket that only
-- moved when some other control was pressed would look broken.
--
-- The playoff advance runs first. Its seeds are what the toilet field is computed from, so
-- the consolation bracket cannot be built before the playoff field exists.
CREATE OR REPLACE FUNCTION public.generate_playoff_round(p_league_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_season_status TEXT;
  v_playoff_teams INTEGER;
  v_playoff_format TEXT;
  v_base_weeks INTEGER;
  v_team_count INTEGER;
  v_state JSONB;
  v_seeds UUID[];
  v_j INTEGER;
  v_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to manage the playoff bracket.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can manage the playoff bracket.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_season_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  IF v_season_status <> 'draft_complete' THEN
    RAISE EXCEPTION 'The playoff bracket unlocks once the draft is complete.';
  END IF;

  SELECT COALESCE(playoff_team_count, 0),
         COALESCE(playoff_format, 'single_elimination'),
         COALESCE(regular_season_weeks, 0)
  INTO v_playoff_teams, v_playoff_format, v_base_weeks
  FROM public.league_settings
  WHERE season_id = v_season_id;

  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams
  WHERE league_id = p_league_id AND season_id = v_season_id;

  IF v_playoff_teams < 2 THEN
    RAISE EXCEPTION 'A playoff bracket needs at least 2 teams; this league is configured for %.', v_playoff_teams;
  END IF;

  IF v_playoff_teams > v_team_count THEN
    RAISE EXCEPTION 'A playoff bracket cannot be larger than the league; this league has % teams and is configured for %.', v_team_count, v_playoff_teams;
  END IF;

  v_state := COALESCE(
    (SELECT playoff_state_json FROM public.league_settings WHERE season_id = v_season_id),
    '{}'::jsonb
  );

  v_seeds := ARRAY[]::UUID[];

  IF jsonb_typeof(v_state -> 'seeds') = 'array'
     AND jsonb_array_length(v_state -> 'seeds') >= v_playoff_teams THEN
    FOR v_j IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seeds := v_seeds || ARRAY[(v_state -> 'seeds' ->> v_j)::UUID]::UUID[];
    END LOOP;
  END IF;

  IF array_length(v_seeds, 1) IS NULL THEN
    SELECT ARRAY_AGG(st.team_id ORDER BY st.wins DESC, st.losses ASC, st.ko_diff DESC, st.team_name ASC)
    INTO v_seeds
    FROM public.season_standings(p_league_id) st;

    IF v_seeds IS NULL OR array_length(v_seeds, 1) < v_playoff_teams THEN
      RAISE EXCEPTION 'The bracket needs at least % teams with a record.', v_playoff_teams;
    END IF;

    v_seeds := v_seeds[1:v_playoff_teams];
    v_state := jsonb_set(v_state, '{seeds}', to_jsonb(v_seeds));
    UPDATE public.league_settings
    SET playoff_state_json = v_state, updated_at = NOW()
    WHERE season_id = v_season_id;
  END IF;

  v_count := public.playoff_advance(
    p_league_id, v_season_id, v_base_weeks, v_seeds, v_playoff_teams, v_playoff_format
  );

  -- A bye has no result to wait for, so it is settled here rather than left for a member
  -- to submit. Left unsettled the round it belongs to could never complete.
  PERFORM public.playoff_settle_pending_byes(p_league_id, v_season_id);

  -- Returns zero when the consolation bracket is switched off or nobody missed the
  -- playoffs, so this costs nothing for a league that does not use it.
  PERFORM public.toilet_advance(
    p_league_id, v_season_id, v_base_weeks, v_playoff_teams
  );

  PERFORM public.playoff_settle_pending_byes(p_league_id, v_season_id);

  RETURN v_count;
END;
$$;

-- Lists every toilet-bowl game, for the bracket sheet.
--
-- Same shape as playoff_bracket_template so the client can merge the two lists and draw
-- them with one component. Returns nothing when the setting is off or nobody missed the
-- playoffs, which is what lets the client call it unconditionally.
CREATE OR REPLACE FUNCTION public.toilet_bracket_template(p_league_id UUID)
RETURNS TABLE (
  game_label TEXT,
  phase TEXT,
  round_no INTEGER,
  week INTEGER,
  slot INTEGER,
  feeder_a TEXT,
  feeder_b TEXT,
  team_a UUID,
  team_b UUID,
  is_grand_final BOOLEAN,
  is_reset BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id UUID;
  v_seeds UUID[];
  v_field INTEGER;
  v_base INTEGER;
  v_playoff_teams INTEGER;
  v_enabled BOOLEAN;
  v_row RECORD;
  v_kind TEXT;
  v_ref TEXT;
BEGIN
  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(ls.enable_toilet_bowl, FALSE),
         COALESCE(ls.playoff_team_count, 0),
         COALESCE(ls.regular_season_weeks, 0)
  INTO v_enabled, v_playoff_teams, v_base
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  IF NOT COALESCE(v_enabled, FALSE) THEN
    RETURN;
  END IF;

  v_seeds := public.toilet_seeds(p_league_id, v_season_id, v_playoff_teams);
  v_field := COALESCE(array_length(v_seeds, 1), 0);

  IF v_field < 2 THEN
    RETURN;
  END IF;

  FOR v_row IN
    SELECT src.*
    FROM public.playoff_bracket_structure(v_field, v_base, 'single_elimination') AS src
    WHERE src.phase = 'upper'
    ORDER BY src.round_no, src.slot
  LOOP
    game_label := v_row.game_label;
    phase := 'toilet';
    round_no := v_row.round_no;
    week := v_row.week;
    slot := v_row.slot;
    is_grand_final := FALSE;
    is_reset := FALSE;

    v_kind := v_row.feeder_a_kind;
    v_ref := v_row.feeder_a_ref;

    IF v_kind = 'seed' THEN
      feeder_a := 'seed ' || v_ref;
    ELSIF v_kind = 'winner' THEN
      feeder_a := 'W(' || v_ref || ')';
    ELSE
      feeder_a := 'Bye';
    END IF;

    v_kind := v_row.feeder_b_kind;
    v_ref := v_row.feeder_b_ref;

    IF v_kind = 'seed' THEN
      feeder_b := 'seed ' || v_ref;
    ELSIF v_kind = 'winner' THEN
      feeder_b := 'W(' || v_ref || ')';
    ELSE
      feeder_b := 'Bye';
    END IF;

    team_a := CASE
      WHEN v_row.feeder_a_kind = 'seed'
       AND array_length(v_seeds, 1) >= v_row.feeder_a_ref::INTEGER
        THEN v_seeds[v_row.feeder_a_ref::INTEGER]
    END;

    team_b := CASE
      WHEN v_row.feeder_b_kind = 'seed'
       AND array_length(v_seeds, 1) >= v_row.feeder_b_ref::INTEGER
        THEN v_seeds[v_row.feeder_b_ref::INTEGER]
    END;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.toilet_bracket_template(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toilet_bracket_template(UUID) TO authenticated;

-- Turns the consolation bracket on or off. Separate from schedule generation because the
-- bracket is built after the regular season, so the choice has to be changeable long
-- after the schedule was written.
CREATE OR REPLACE FUNCTION public.set_toilet_bowl(
  p_league_id UUID,
  p_enabled BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to change this setting.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can change this setting.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  INSERT INTO public.league_settings (league_id, season_id, enable_toilet_bowl, updated_at)
  VALUES (p_league_id, v_season_id, COALESCE(p_enabled, FALSE), NOW())
  ON CONFLICT (league_id, season_id)
  DO UPDATE SET enable_toilet_bowl = EXCLUDED.enable_toilet_bowl, updated_at = NOW();

  RETURN COALESCE(p_enabled, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.set_toilet_bowl(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_toilet_bowl(UUID, BOOLEAN) TO authenticated;
