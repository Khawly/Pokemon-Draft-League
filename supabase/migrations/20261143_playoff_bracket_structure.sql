-- Builds the playoff bracket: the league's twelve-team tournament tree for a field of
-- 12, and a mirrored bracket for a field of 8 or 16.
--
-- Supersedes both the generic power-of-two traversal in generate_playoff_round and
-- the seed ordering added in 20261142. Read that migration's header for why twelve
-- teams could not be expressed as a seed order at all; this one states those pairings
-- explicitly and leaves the simple cases on the generic traversal.
--
-- For 8 and 16 the field is a power of two, so there are no byes and the generic
-- consecutive-pair traversal is correct. Round one mirrors the seed list: the top
-- seed meets the bottom seed, the second meets the second from bottom, and so on.
--
--   8   1v8   2v7   3v6   4v5
--   16  1v16  2v15  3v14  4v13  5v12  6v11  7v10  8v9
--
-- Note this differs from balanced bracket geometry, where 1 and 16 must sit in
-- opposite halves so they can only meet in the final. The mirror above pairs them in
-- round one instead, which is the requested format; the consequence is that the
-- eventual champion's route is unevenly weighted.
--
-- Twelve teams get the sheet's tree, where the four best seeds sit out round one:
--
--   round 1  G1 11v12  G2 9v10  G3 7v8  G4 5v6
--   round 2  G5 1vW(G1)  G6 2vW(G2)  G7 3vW(G3)  G8 4vW(G4)
--   round 3  G15 W(G5)vW(G6)  G16 W(G7)vW(G8)
--   round 4  G19 W(G15)vW(G16)                      -> winners bracket champion
--
--   lower 1  G9 L(G1)vL(G8)  G10 L(G2)vL(G7)
--            G11 L(G3)vL(G6)  G12 L(G4)vL(G5)
--   lower 2  G13 W(G9)vW(G10)  G14 W(G11)vW(G12)
--   lower 3  G20 W(G13)vL(G15)  G21 W(G14)vL(G16)
--   lower 4  G22 W(G20)vW(G21)
--   lower 5  G23 L(G19)vW(G22)
--   lower 6  G24 W(G23)vW(G19)                     -> grand final
--   reset    G25 W(G24)vL(G24), only if the lower champion lost the grand final
--
-- Round one of the lower bracket pairs each first-round loser against a second-round
-- loser rather than only against other first-round losers, which is what lets all
-- eight resolve in a single round. That is why G9 takes L(G8) while G12 takes L(G5).
--
-- Games are addressed by week number within a bracket phase rather than by a game id,
-- because there is no column to hold a bracket position. The helpers below turn that
-- into "the nth game of this phase in this week", which is stable because a round's
-- games are always created together in one INSERT.

-- Mirrored seed order for a power-of-two field: 1, N, 2, N-1, 3, N-2, ...
CREATE OR REPLACE FUNCTION public.playoff_seed_order(p_slots INTEGER)
    RETURNS INTEGER[]
    LANGUAGE plpgsql
    IMMUTABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_order INTEGER[] := ARRAY[]::INTEGER[];
      v_lo INTEGER := 1;
      v_hi INTEGER;
    BEGIN
      IF p_slots < 2 THEN
        RETURN ARRAY[1]::INTEGER[];
      END IF;

      v_hi := p_slots;

      WHILE v_lo <= v_hi LOOP
        v_order := v_order || ARRAY[v_lo]::INTEGER[];

        IF v_hi <> v_lo THEN
          v_order := v_order || ARRAY[v_hi]::INTEGER[];
        END IF;

        v_lo := v_lo + 1;
        v_hi := v_hi - 1;
      END LOOP;

      RETURN v_order;
    END;
$$;

-- The nth game of a round, ordered by creation so the position is stable.
CREATE OR REPLACE FUNCTION public.playoff_game(
  p_league_id UUID,
  p_season_id UUID,
  p_week INTEGER,
  p_phase TEXT,
  p_ordinal INTEGER
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT m.id INTO v_id
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.week_number = p_week
    AND m.bracket_phase = p_phase
  ORDER BY m.created_at ASC, m.id ASC
  OFFSET (p_ordinal - 1)
  LIMIT 1;

  RETURN v_id;
END;
$$;

-- The winner of the nth game of a round, or NULL while it is unfinished.
CREATE OR REPLACE FUNCTION public.playoff_game_winner(
  p_league_id UUID,
  p_season_id UUID,
  p_week INTEGER,
  p_phase TEXT,
  p_ordinal INTEGER
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.winner_team_id
  FROM public.matches m
  WHERE m.id = public.playoff_game(p_league_id, p_season_id, p_week, p_phase, p_ordinal)
    AND m.status = 'completed'
    AND m.winner_team_id IS NOT NULL;
$$;

-- The loser of the nth game of a round, derived as the side that did not win.
CREATE OR REPLACE FUNCTION public.playoff_game_loser(
  p_league_id UUID,
  p_season_id UUID,
  p_week INTEGER,
  p_phase TEXT,
  p_ordinal INTEGER
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN m.winner_team_id = m.player_1_team_id THEN m.player_2_team_id
           ELSE m.player_1_team_id
         END
  FROM public.matches m
  WHERE m.id = public.playoff_game(p_league_id, p_season_id, p_week, p_phase, p_ordinal)
    AND m.status = 'completed'
    AND m.winner_team_id IS NOT NULL;
$$;

-- True when every game already created for this round has finished with a winner.
-- An empty round counts as not done, so the first call creates it rather than
-- skipping past it.
CREATE OR REPLACE FUNCTION public.playoff_round_done(
  p_league_id UUID,
  p_season_id UUID,
  p_week INTEGER,
  p_phase TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*) > 0
         AND bool_and(m.status = 'completed' AND m.winner_team_id IS NOT NULL)
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.week_number = p_week
    AND m.bracket_phase = p_phase;
$$;
-- Advances the bracket one step. Each call creates the earliest step whose inputs
-- have all finished, then returns how many games it made. Calling it again after
-- those results land advances the bracket further; it is safe to call when there is
-- nothing ready, which simply returns 0.
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
  v_state JSONB;
  v_seeds UUID[];
  v_order INTEGER[];
  v_survivors UUID[];
  v_next UUID[];
  v_count INTEGER := 0;
  v_rounds INTEGER;
  v_r INTEGER;
  v_j INTEGER;
  v_week INTEGER;
  v_a UUID;
  v_b UUID;
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

  IF v_playoff_teams NOT IN (8, 12, 16) THEN
    RAISE EXCEPTION 'Playoff brackets are defined for 8, 12 or 16 teams; this league is configured for % teams.', v_playoff_teams;
  END IF;

  v_state := COALESCE(
    (SELECT playoff_state_json FROM public.league_settings WHERE season_id = v_season_id),
    '{}'::jsonb
  );

  -- Seeds freeze on first run so later results cannot reshuffle the tree.
  v_seeds := ARRAY[]::uuid[];
  IF jsonb_typeof(v_state -> 'seeds') = 'array'
     AND jsonb_array_length(v_state -> 'seeds') >= v_playoff_teams THEN
    FOR v_j IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seeds := v_seeds || ARRAY[(v_state -> 'seeds' ->> v_j)::uuid]::uuid[];
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

  IF v_playoff_teams = 12 THEN
    RETURN public.playoff_advance_12(p_league_id, v_season_id, v_base_weeks, v_seeds, v_playoff_format);
  END IF;

  -- Eight or sixteen teams: no byes, so the mirrored seed order feeds the ordinary
  -- consecutive-pair traversal.
  v_order := public.playoff_seed_order(v_playoff_teams);
  v_rounds := 0;
  WHILE v_rounds < v_playoff_teams LOOP
    v_rounds := v_rounds + 1;
    IF v_rounds >= v_playoff_teams THEN EXIT; END IF;
  END LOOP;
  v_rounds := 0;
  WHILE (1 << v_rounds) < v_playoff_teams LOOP
    v_rounds := v_rounds + 1;
  END LOOP;

  v_survivors := ARRAY[]::uuid[];
  FOR v_j IN 1..v_playoff_teams LOOP
    v_survivors := array_append(v_survivors, v_seeds[v_order[v_j]]);
  END LOOP;

  FOR v_r IN 1..v_rounds LOOP
    v_week := v_base_weeks + v_r;

    IF public.playoff_round_done(p_league_id, v_season_id, v_week, 'upper') THEN
      v_next := ARRAY[]::uuid[];
      FOR v_j IN 1..(array_length(v_survivors, 1) / 2) LOOP
        v_next := array_append(v_next,
          public.playoff_game_winner(p_league_id, v_season_id, v_week, 'upper', v_j));
      END LOOP;

      IF EXISTS (SELECT 1 FROM unnest(v_next) u WHERE u IS NULL) THEN
        RETURN 0;
      END IF;

      v_survivors := v_next;
      CONTINUE;
    END IF;

    FOR v_j IN 1..(array_length(v_survivors, 1) / 2) LOOP
      v_a := v_survivors[2 * v_j - 1];
      v_b := v_survivors[2 * v_j];

      IF v_a IS NULL OR v_b IS NULL THEN
        CONTINUE;
      END IF;

      INSERT INTO public.matches
        (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES
        (p_league_id, v_season_id, v_week, TRUE, v_a, v_b, 'scheduled', 'upper');
      v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
  END LOOP;

  RETURN 0;
END;
$$;

-- The twelve-team tree, one step per call. Step identity comes from the week number
-- and bracket phase rather than a stored counter, so a partially built bracket is
-- picked up correctly after a failed or repeated call.
CREATE OR REPLACE FUNCTION public.playoff_advance_12(
  p_league_id UUID,
  p_season_id UUID,
  p_base_weeks INTEGER,
  v_seeds UUID[],
  p_format TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_base INTEGER := p_base_weeks;
  w TEXT;
  l TEXT;
BEGIN
  IF p_format <> 'double_elimination' THEN
    RAISE EXCEPTION 'The twelve-team bracket is defined for double elimination; this league is set to %.', p_format;
  END IF;

  -- Winners bracket, rounds one to four.
  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 1, 'upper') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 1, TRUE, v_seeds[11], v_seeds[12], 'scheduled', 'upper'),
           (p_league_id, p_season_id, v_base + 1, TRUE, v_seeds[9],  v_seeds[10], 'scheduled', 'upper'),
           (p_league_id, p_season_id, v_base + 1, TRUE, v_seeds[7],  v_seeds[8],  'scheduled', 'upper'),
           (p_league_id, p_season_id, v_base + 1, TRUE, v_seeds[5],  v_seeds[6],  'scheduled', 'upper');
    RETURN 4;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 2, 'upper') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 2, TRUE, v_seeds[1], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 1), 'scheduled', 'upper'),
           (p_league_id, p_season_id, v_base + 2, TRUE, v_seeds[2], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 2), 'scheduled', 'upper'),
           (p_league_id, p_season_id, v_base + 2, TRUE, v_seeds[3], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 3), 'scheduled', 'upper'),
           (p_league_id, p_season_id, v_base + 2, TRUE, v_seeds[4], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 4), 'scheduled', 'upper');
    RETURN 4;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 3, 'upper') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 3, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'scheduled', 'upper'),
           (p_league_id, p_season_id, v_base + 3, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'scheduled', 'upper');
    RETURN 2;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 4, 'upper') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 4, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'scheduled', 'upper');
    RETURN 1;
  END IF;

  -- Losers bracket. Round one shares a week with winners round three because its
  -- inputs (the round one and round two losers) have all landed by then.
  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 3, 'lower') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 3, TRUE, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'scheduled', 'lower'),
           (p_league_id, p_season_id, v_base + 3, TRUE, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 3), 'scheduled', 'lower'),
           (p_league_id, p_season_id, v_base + 3, TRUE, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 3), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'scheduled', 'lower'),
           (p_league_id, p_season_id, v_base + 3, TRUE, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 4), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 1), 'scheduled', 'lower');
    RETURN 4;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 4, 'lower') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 4, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 2), 'scheduled', 'lower'),
           (p_league_id, p_season_id, v_base + 4, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 4), 'scheduled', 'lower');
    RETURN 2;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 5, 'lower') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 5, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 1), 'scheduled', 'lower'),
           (p_league_id, p_season_id, v_base + 5, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'scheduled', 'lower');
    RETURN 2;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 6, 'lower') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 6, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 2), 'scheduled', 'lower');
    RETURN 1;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 7, 'lower') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 7, TRUE, public.playoff_game_loser(p_league_id, p_season_id, v_base + 4, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 6, 'lower', 1), 'scheduled', 'lower');
    RETURN 1;
  END IF;

  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 8, 'gf') THEN
    INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
    VALUES (p_league_id, p_season_id, v_base + 8, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 7, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'upper', 1), 'scheduled', 'gf');
    RETURN 1;
  END IF;

  -- Reset only when the lower-bracket champion lost the grand final, which is
  -- exactly when the grand final's loser is not the winners-bracket champion.
  IF NOT public.playoff_round_done(p_league_id, p_season_id, v_base + 9, 'gf') THEN
    IF EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.id = public.playoff_game(p_league_id, p_season_id, v_base + 8, 'gf', 1)
        AND m.winner_team_id IS DISTINCT FROM public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'upper', 1)
    ) THEN
      INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES (p_league_id, p_season_id, v_base + 9, TRUE, public.playoff_game_winner(p_league_id, p_season_id, v_base + 8, 'gf', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 8, 'gf', 1), 'scheduled', 'gf');
      RETURN 1;
    END IF;
  END IF;

  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_game(UUID, UUID, INTEGER, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_game_winner(UUID, UUID, INTEGER, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_game_loser(UUID, UUID, INTEGER, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_round_done(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_playoff_round(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_seed_order(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_game(UUID, UUID, INTEGER, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_game_winner(UUID, UUID, INTEGER, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_game_loser(UUID, UUID, INTEGER, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_round_done(UUID, UUID, INTEGER, TEXT) TO authenticated;
