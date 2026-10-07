-- Randomizes regular season schedule generation.
--
-- Previously `generate_schedule` fed the circle method a deterministic team list
-- ordered by draft position, so every regeneration produced the same pairings and
-- week one always read "draft first vs draft last, second vs second to last".
-- This migration replaces the generator so pairings are drawn at random, the
-- home/away side of every matchup is a coin flip, and any weeks beyond a full
-- round-robin re-draw their pairings instead of replaying the same set.
--
-- Playoff seeding is intentionally untouched: it still follows final standings,
-- which must stay deterministic and merit-based.

-- Randomly permutes an array of team ids (Fisher-Yates, walking backwards and
-- swapping each slot with a uniformly drawn earlier one). VOLATILE rather than
-- IMMUTABLE because every call consumes random() and must return a fresh draw.
-- Passing p_items through unchanged when it holds fewer than two entries keeps
-- the single-team and empty cases trivial.
CREATE OR REPLACE FUNCTION public.shuffle_uuid_array(p_items UUID[])
RETURNS UUID[]
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_items UUID[];
  v_i INTEGER;
  v_j INTEGER;
  v_swap UUID;
BEGIN
  IF p_items IS NULL OR array_length(p_items, 1) < 2 THEN
    RETURN p_items;
  END IF;

  v_items := p_items;

  FOR v_i IN REVERSE array_length(v_items, 1)..1 LOOP
    v_j := 1 + FLOOR(random() * v_i)::int;
    v_swap := v_items[v_i];
    v_items[v_i] := v_items[v_j];
    v_items[v_j] := v_swap;
  END LOOP;

  RETURN v_items;
END;
$$;

REVOKE ALL ON FUNCTION public.shuffle_uuid_array(UUID[]) FROM PUBLIC;

-- Owner-only RPC that saves the season's schedule configuration, replaces any
-- prior schedule for the season (results cascade with their matches), and
-- generates the regular-season weeks with a round-robin circle method.
--
-- Randomization, in order of effect:
--   * the team list is shuffled, so the arrangement that drives the first/last
--     mirror pairing is a draw rather than draft order;
--   * the list is re-shuffled at the start of each pass over the round-robin
--     cycle, so weeks beyond a full round-robin re-draw pairings instead of
--     replaying the identical set of matchups;
--   * a candidate week that would repeat any of the previous week's matchups is
--     re-drawn (up to twelve attempts) so teams never face each other in
--     consecutive weeks;
--   * the home/away side of each matchup is flipped at random.
--
-- Guarantees preserved: every real team plays at most once per week, every pair
-- of teams meets exactly once per round-robin cycle, and with an odd number of
-- teams one team receives a bye each week.
--
-- p_league_id           league whose schedule is replaced.
-- p_weeks               number of regular-season weeks to create.
-- p_match_format        'single' or 'best_of_3'.
-- p_playoff_team_count  size of the playoff field (0 disables the playoffs).
-- p_playoff_match_format 'single' or 'best_of_3'.
-- p_playoff_format      'single_elimination' or 'double_elimination'.
--
-- SECURITY DEFINER because the callers are authenticated league owners while the
-- writes (matches, league_settings) have no client policies.
CREATE OR REPLACE FUNCTION public.generate_schedule(
  p_league_id UUID,
  p_weeks INTEGER,
  p_match_format TEXT,
  p_playoff_team_count INTEGER,
  p_playoff_match_format TEXT,
  p_playoff_format TEXT
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
  v_n INTEGER;
  v_cycle INTEGER;
  v_list UUID[];
  v_new UUID[];
  v_pair_a UUID[];
  v_pair_b UUID[];
  v_last_keys TEXT[];
  v_keys TEXT[];
  v_attempt INTEGER;
  v_created INTEGER := 0;
  v_repeat BOOLEAN;
  v_a UUID;
  v_b UUID;
  v_w INTEGER;
  v_i INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to generate a schedule.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can generate the schedule.';
  END IF;

  IF p_weeks IS NULL OR p_weeks < 1 THEN
    RAISE EXCEPTION 'Regular season weeks must be at least 1.';
  END IF;

  IF p_match_format NOT IN ('single','best_of_3') THEN
    RAISE EXCEPTION 'Invalid regular season match format.';
  END IF;

  IF p_playoff_team_count IS NULL OR p_playoff_team_count < 0 OR p_playoff_team_count > 16 THEN
    RAISE EXCEPTION 'Invalid playoff team count.';
  END IF;

  IF p_playoff_match_format NOT IN ('single','best_of_3') THEN
    RAISE EXCEPTION 'Invalid playoff match format.';
  END IF;

  IF p_playoff_format NOT IN ('single_elimination','double_elimination') THEN
    RAISE EXCEPTION 'Invalid playoff format.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id AND s.status <> 'archived'
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no active season.';
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
  UPDATE public.league_settings SET playoff_state_json = '{}'::jsonb, updated_at = NOW() WHERE season_id = v_season_id;

  SELECT ARRAY_AGG(t.id) INTO v_teams
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  IF v_teams IS NULL OR array_length(v_teams, 1) < 2 THEN
    RAISE EXCEPTION 'At least two teams are required to generate a schedule.';
  END IF;

  v_list := v_teams;
  v_n := array_length(v_list, 1);

  -- With an odd number of teams, append a bye sentinel so the circle method
  -- pairs every real team exactly once and one team rests each week. Because the
  -- list is shuffled, the bye walks around the league rather than always falling
  -- to the same team.
  IF v_n % 2 = 1 THEN
    v_list := v_list || ARRAY[NULL::uuid];
    v_n := v_n + 1;
  END IF;

  -- A full round-robin over v_n slots takes v_n - 1 weeks and then the rotation
  -- returns to where it started, so anything beyond that is a repeat pass.
  v_cycle := v_n - 1;
  v_last_keys := ARRAY[]::text[];

  FOR v_w IN 1..p_weeks LOOP
    -- Re-draw the arrangement at the start of every cycle so repeat passes
    -- produce different pairings rather than replaying the same week set.
    IF (v_w - 1) % v_cycle = 0 THEN
      v_list := public.shuffle_uuid_array(v_list);
    END IF;

    -- Draw a week whose matchups do not repeat the previous week's. Within a
    -- cycle the circle method never repeats a pair, so this only bites when the
    -- rotation wraps, and twelve re-draws make a repeat vanishingly unlikely.
    v_attempt := 0;
    LOOP
      v_pair_a := ARRAY[]::uuid[];
      v_pair_b := ARRAY[]::uuid[];
      v_keys := ARRAY[]::text[];

      FOR v_i IN 1..(v_n / 2) LOOP
        v_a := v_list[v_i];
        v_b := v_list[v_n + 1 - v_i];
        IF v_a IS NULL OR v_b IS NULL OR v_a = v_b THEN
          CONTINUE;
        END IF;
        v_pair_a := array_append(v_pair_a, v_a);
        v_pair_b := array_append(v_pair_b, v_b);
        v_keys := v_keys || ARRAY[
          LEAST(v_a::text, v_b::text) || '~' || GREATEST(v_a::text, v_b::text)
        ];
      END LOOP;

      SELECT EXISTS (
        SELECT 1 FROM unnest(v_keys) k WHERE k = ANY (v_last_keys)
      ) INTO v_repeat;

      v_attempt := v_attempt + 1;
      EXIT WHEN NOT v_repeat OR v_attempt >= 12;

      v_list := public.shuffle_uuid_array(v_list);
    END LOOP;

    FOR v_i IN 1..array_length(v_pair_a, 1) LOOP
      v_a := v_pair_a[v_i];
      v_b := v_pair_b[v_i];

      -- Coin flip the home/away side so no team is permanently the guest.
      IF random() >= 0.5 THEN
        v_a := v_pair_b[v_i];
        v_b := v_pair_a[v_i];
      END IF;

      INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES (p_league_id, v_season_id, v_w, FALSE, v_a, v_b, 'scheduled', NULL);
      v_created := v_created + 1;
    END LOOP;

    v_last_keys := v_keys;

    -- Rotate the arrangement for the next week, holding position 1 fixed so the
    -- mirror pairing visits a fresh opponent every week within a cycle.
    v_new := ARRAY[v_list[1], v_list[v_n]]::uuid[];
    IF v_n > 2 THEN
      FOR v_i IN 2..(v_n - 1) LOOP
        v_new := v_new || ARRAY[v_list[v_i]]::uuid[];
      END LOOP;
    END IF;
    v_list := v_new;
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT) TO authenticated;