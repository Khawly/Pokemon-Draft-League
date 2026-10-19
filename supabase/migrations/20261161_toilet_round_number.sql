-- Gives toilet bowl games the same bracket round number as the playoff games created
-- alongside them.
--
-- The round number is what the matchup picker groups by, because one press of Advance
-- Playoffs writes games into several weeks at once: the next winners round lands in one
-- week and the next losers round in another, from the same press. Ordering by week splits
-- that round in two and puts the losers leg -- which is a later week -- above the winners
-- leg, so the round a member just advanced appeared scattered down the list.
--
-- Toilet games were written without a number, so they could not group with their round
-- either. They now take the number of the press that created them.

-- Backfill: a toilet game belongs to the press whose winners round shares its week, which
-- is how every existing toilet game was created.
UPDATE public.matches m
SET playoff_round_no = press.press
FROM (
  SELECT DISTINCT ON (league_id, season_id, week_number)
    league_id,
    season_id,
    week_number,
    playoff_round_no AS press
  FROM public.matches
  WHERE is_playoff
    AND bracket_phase = 'upper'
    AND playoff_round_no IS NOT NULL
  ORDER BY league_id, season_id, week_number, playoff_round_no
) press
WHERE m.is_playoff
  AND m.bracket_phase = 'toilet'
  AND m.playoff_round_no IS NULL
  AND m.league_id = press.league_id
  AND m.season_id = press.season_id
  AND m.week_number = press.week_number;

-- @param p_round_no - The bracket round number shared by every game this press created.
CREATE OR REPLACE FUNCTION public.toilet_advance(
  p_league_id UUID,
  p_season_id UUID,
  p_base_weeks INTEGER,
  p_playoff_teams INTEGER,
  p_round_no INTEGER DEFAULT NULL
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

    IF v_a IS NOT NULL OR v_b IS NOT NULL THEN
      IF public.playoff_insert_game(
        p_league_id, p_season_id, v_row.week, v_a, v_b, 'toilet', v_row.slot, p_round_no
      ) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Advances the playoff bracket and the toilet bowl together, both stamped with one round.
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
  v_press INTEGER;
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

  /*
   * The round number this press will write. Computed before anything is written, so the
   * toilet advance can stamp the same number on the games it adds; playoff_advance works
   * the same number out for itself from the same starting point.
   */
  SELECT COALESCE(MAX(m.playoff_round_no), 0) + 1 INTO v_press
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = v_season_id
    AND m.is_playoff;

  v_count := public.playoff_advance(
    p_league_id, v_season_id, v_base_weeks, v_seeds, v_playoff_teams, v_playoff_format
  );

  PERFORM public.playoff_settle_pending_byes(p_league_id, v_season_id);

  PERFORM public.toilet_advance(
    p_league_id, v_season_id, v_base_weeks, v_playoff_teams, v_press
  );

  PERFORM public.playoff_settle_pending_byes(p_league_id, v_season_id);

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.toilet_advance(UUID, UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toilet_advance(UUID, UUID, INTEGER, INTEGER, INTEGER) TO authenticated;