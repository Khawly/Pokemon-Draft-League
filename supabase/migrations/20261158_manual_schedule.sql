-- Lets the owner lay out the regular season by hand instead of drawing it at random.
--
-- The random generator walks a circle method and coin-flips home side, which is right
-- when nobody has a preference and useless when the owner is matching a schedule the
-- league already agreed on outside the app. This adds the write path for a schedule the
-- owner supplied, and validates it rather than trusting it: a schedule that puts a team
-- in two matches in one week is not a schedule, and finding that out halfway through the
-- season is worse than being refused the save.
--
-- It replaces the season's matches exactly as generate_schedule does, including results,
-- so the two paths cannot leave the season in different shapes.

-- Whether the non-playoff teams play their own consolation bracket. Read by the bracket
-- generator, so it lives with the other playoff settings rather than in page state.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS enable_toilet_bowl BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.league_settings.enable_toilet_bowl IS
  'When true, the teams that miss the playoff field play a single-elimination consolation bracket seeded by their regular-season standings.';

-- Saves an owner-supplied regular-season schedule.
--
-- The matchup list is an array of `{ week, player_1_team_id, player_2_team_id }`. A team
-- may be left out of a week entirely: that is a bye, and it is the only way an odd-sized
-- league can be scheduled at all.
--
-- @param p_matchups - The pairings to write, one object per game.
-- @returns How many matches were written.
CREATE OR REPLACE FUNCTION public.save_manual_schedule(
  p_league_id UUID,
  p_weeks INTEGER,
  p_match_format TEXT,
  p_playoff_team_count INTEGER,
  p_playoff_match_format TEXT,
  p_playoff_format TEXT,
  p_matchups JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_teams UUID[];
  v_team_count INTEGER;
  v_row RECORD;
  v_dup RECORD;
  v_created INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to save a schedule.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can save the schedule.';
  END IF;

  IF p_weeks IS NULL OR p_weeks < 1 THEN
    RAISE EXCEPTION 'Regular season weeks must be at least 1.';
  END IF;

  IF p_match_format NOT IN ('single', 'best_of_3') THEN
    RAISE EXCEPTION 'Invalid regular season match format.';
  END IF;

  IF p_playoff_team_count IS NULL OR p_playoff_team_count < 0 THEN
    RAISE EXCEPTION 'Invalid playoff team count.';
  END IF;

  IF p_playoff_match_format NOT IN ('single', 'best_of_3') THEN
    RAISE EXCEPTION 'Invalid playoff match format.';
  END IF;

  IF p_playoff_format NOT IN ('single_elimination', 'double_elimination') THEN
    RAISE EXCEPTION 'Invalid playoff format.';
  END IF;

  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'The matchup list must be an array.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id AND s.status <> 'archived'
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no active season.';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams
  WHERE league_id = p_league_id AND season_id = v_season_id;

  IF p_playoff_team_count > v_team_count THEN
    RAISE EXCEPTION 'Playoff teams cannot exceed the league size of %.', v_team_count;
  END IF;

  SELECT ARRAY_AGG(t.id) INTO v_teams
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  IF v_teams IS NULL OR array_length(v_teams, 1) < 2 THEN
    RAISE EXCEPTION 'At least two teams are required to save a schedule.';
  END IF;

  /*
   * Every row is checked before anything is deleted. Refusing a bad schedule has to leave
   * the season exactly as it was, or a typo would cost the owner the schedule they already
   * had.
   */
  FOR v_row IN
    SELECT *
    FROM jsonb_to_recordset(p_matchups)
      AS x(week INTEGER, player_1_team_id UUID, player_2_team_id UUID)
  LOOP
    IF v_row.week IS NULL OR v_row.week < 1 OR v_row.week > p_weeks THEN
      RAISE EXCEPTION 'A matchup is in week %, which is outside the regular season of % week(s).',
        v_row.week, p_weeks;
    END IF;

    IF v_row.player_1_team_id IS NULL OR v_row.player_2_team_id IS NULL THEN
      RAISE EXCEPTION 'Every matchup needs both teams. Week % has one missing.', v_row.week;
    END IF;

    IF v_row.player_1_team_id = v_row.player_2_team_id THEN
      RAISE EXCEPTION 'A team cannot play itself. Week % pairs a team with itself.', v_row.week;
    END IF;

    IF NOT (v_row.player_1_team_id = ANY (v_teams))
       OR NOT (v_row.player_2_team_id = ANY (v_teams)) THEN
      RAISE EXCEPTION 'A matchup in week % names a team that is not in this season.', v_row.week;
    END IF;
  END LOOP;

  -- A team may play once a week and rest otherwise, but never twice in the same week.
  SELECT week, team, appearances INTO v_dup
  FROM (
    SELECT week, team, COUNT(*) AS appearances
    FROM (
      SELECT x.week, x.player_1_team_id AS team
      FROM jsonb_to_recordset(p_matchups)
        AS x(week INTEGER, player_1_team_id UUID, player_2_team_id UUID)
      UNION ALL
      SELECT x.week, x.player_2_team_id
      FROM jsonb_to_recordset(p_matchups)
        AS x(week INTEGER, player_1_team_id UUID, player_2_team_id UUID)
    ) appearances
    GROUP BY week, team
  ) counted
  WHERE appearances > 1
  LIMIT 1;

  IF v_dup.team IS NOT NULL THEN
    RAISE EXCEPTION 'A team is scheduled % times in week %.', v_dup.appearances, v_dup.week;
  END IF;

  INSERT INTO public.league_settings (league_id, season_id, regular_season_weeks, match_format, playoff_team_count, playoff_match_format, playoff_format, updated_at)
  VALUES (p_league_id, v_season_id, p_weeks, p_match_format, p_playoff_team_count, p_playoff_match_format, p_playoff_format, NOW())
  ON CONFLICT (league_id, season_id)
  DO UPDATE SET
    regular_season_weeks = EXCLUDED.regular_season_weeks,
    match_format = EXCLUDED.match_format,
    playoff_team_count = EXCLUDED.playoff_team_count,
    playoff_match_format = EXCLUDED.playoff_match_format,
    playoff_format = EXCLUDED.playoff_format,
    updated_at = NOW();

  -- Replace any prior schedule for this season (results cascade with matches).
  DELETE FROM public.matches WHERE league_id = p_league_id AND season_id = v_season_id;
  UPDATE public.league_settings
  SET playoff_state_json = '{}'::jsonb, updated_at = NOW()
  WHERE season_id = v_season_id;

  FOR v_row IN
    SELECT *
    FROM jsonb_to_recordset(p_matchups)
      AS x(week INTEGER, player_1_team_id UUID, player_2_team_id UUID)
    ORDER BY week
  LOOP
    INSERT INTO public.matches
      (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES
      (p_league_id, v_season_id, v_row.week, FALSE, v_row.player_1_team_id, v_row.player_2_team_id, 'scheduled', NULL);

    v_created := v_created + 1;
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.save_manual_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_manual_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, JSONB) TO authenticated;