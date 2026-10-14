-- Records a bye as a real game, so a lone team advances instead of disappearing.
--
-- A double forfeit settles its game with neither a winner nor a loser, so every game
-- that would have been fed by it has an empty side. Those games were being left
-- uncreated, which reads correctly at first -- a game nobody plays is normally a bye --
-- but it stranded the teams on their other sides. In this league two forfeited games
-- left two losers bracket games with an empty side each; neither was created, so the two
-- teams facing them were never given an opponent and the round could not complete,
-- because the only games it was waiting on were the ones it had skipped.
--
-- Relaxing the second participant to nullable lets a bye be stored instead of inferred.
-- The advance now creates a game whenever at least one side resolved: the team that is
-- there is written as the winner of a completed game with no opponent, so the ordinary
-- winner and loser feeders resolve against it and the round finishes. A game with both
-- sides empty is still skipped, since neither team exists to advance.
--
-- Regular-season games keep both participants required, and the new check rejects a
-- regular-season game with a missing side, so nothing that was valid before is now
-- allowed. The eight and sixteen team brackets have no byes and are untouched.

-- Lets a playoff game be recorded with only one participant.
ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS matches_player_2_team_id_not_null;
ALTER TABLE public.matches ALTER COLUMN player_2_team_id DROP NOT NULL;

-- A playoff game needs at least one participant; a regular-season game needs both.
ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS matches_playoff_participants;
ALTER TABLE public.matches ADD CONSTRAINT matches_playoff_participants CHECK ((NOT is_playoff AND player_1_team_id IS NOT NULL AND player_2_team_id IS NOT NULL) OR (is_playoff AND player_1_team_id IS NOT NULL));

-- Settles every bye the advance has created.
--
-- A game created with one participant has no result to wait for, so it would leave the
-- round permanently unfinished. Crediting the win to the only team in the game is what
-- lets the round close and the next round be generated.
CREATE OR REPLACE FUNCTION public.playoff_settle_pending_byes(
  p_league_id UUID,
  p_season_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settled INTEGER := 0;
BEGIN
  /*
   * Every playoff game in this season with one participant, no opponent and no result.
   * A game with both sides empty was never created, so it cannot appear here.
   */
  UPDATE public.matches m
  SET winner_team_id = m.player_1_team_id,
      status = 'completed',
      updated_at = NOW()
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.player_1_team_id IS NOT NULL
    AND m.player_2_team_id IS NULL
    AND m.winner_team_id IS NULL;

  GET DIAGNOSTICS v_settled = ROW_COUNT;

  RETURN v_settled;
END;
$$;

-- Creates every round that is ready and no longer skips a game whose opponent is a bye.
--
-- The insert guard used to require both sides, which dropped a game whose opponent had
-- come from a double forfeit and took the surviving team out of the bracket with it.
-- Requiring only one side creates that game so it can be settled as a bye; a game with
-- neither side is still skipped, because there is nobody to advance.
--
-- Round one is unchanged. Both of its sides are seeds, so a missing one means the
-- bracket is misconfigured rather than a team advancing by bye, and it keeps the
-- stricter guard.
--
-- Each block still adds the rows it inserted to v_count, and the function returns that
-- total, which is the number the caller reports.
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
  v_rows INTEGER;
  v_count INTEGER := 0;
  v_base INTEGER := p_base_weeks;
  w TEXT;
  l TEXT;
BEGIN
  IF p_format <> 'double_elimination' THEN
    RAISE EXCEPTION 'The twelve-team bracket is defined for double elimination; this league is set to %.', p_format;
  END IF;

  -- Winners bracket, rounds one to four.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 1, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 1, v_seeds[11], v_seeds[12], 'upper', 1::INTEGER),
  (v_base + 1, v_seeds[9], v_seeds[10], 'upper', 2::INTEGER),
  (v_base + 1, v_seeds[7], v_seeds[8], 'upper', 3::INTEGER),
  (v_base + 1, v_seeds[5], v_seeds[6], 'upper', 4::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 2, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 2, v_seeds[1], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 1), 'upper', 1::INTEGER),
  (v_base + 2, v_seeds[2], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 2), 'upper', 2::INTEGER),
  (v_base + 2, v_seeds[3], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 3), 'upper', 3::INTEGER),
  (v_base + 2, v_seeds[4], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 4), 'upper', 4::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 3, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 3, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'upper', 1::INTEGER),
  (v_base + 3, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'upper', 2::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 4, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'upper', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  -- Losers bracket. Round one shares a week with winners round three because its
  -- inputs (the round one and round two losers) have all landed by then.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 3, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'lower', 1::INTEGER),
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 3), 'lower', 2::INTEGER),
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 3), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'lower', 3::INTEGER),
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 4), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 1), 'lower', 4::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 4, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 2), 'lower', 1::INTEGER),
  (v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 4), 'lower', 2::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 5, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 5, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 1), 'lower', 1::INTEGER),
  (v_base + 5, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'lower', 2::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 6, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 6, public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 2), 'lower', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 7, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 7, public.playoff_game_loser(p_league_id, p_season_id, v_base + 4, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 6, 'lower', 1), 'lower', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 8, 'gf') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 8, public.playoff_game_winner(p_league_id, p_season_id, v_base + 7, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'upper', 1), 'gf', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END IF;

  -- Reset only when the lower-bracket champion lost the grand final, which is
  -- exactly when the grand final's loser is not the winners-bracket champion.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 9, 'gf') THEN
    IF EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.id = public.playoff_game(p_league_id, p_season_id, v_base + 8, 'gf', 1)
        AND m.winner_team_id IS DISTINCT FROM public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'upper', 1)
    ) THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, p_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 9, public.playoff_game_winner(p_league_id, p_season_id, v_base + 8, 'gf', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 8, 'gf', 1), 'gf', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL OR t.p2 IS NOT NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_count := v_count + v_rows;
    END IF;
  END IF;

  RETURN v_count;
END;
$$;

-- Settles byes immediately after the twelve-team advance so the bracket can progress.
--
-- Only the twelve-team path is changed. The eight and sixteen team brackets contain no
-- byes and behave exactly as before.

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
    v_count := public.playoff_advance_12(p_league_id, v_season_id, v_base_weeks, v_seeds, v_playoff_format);

    /*
     * Settle any bye the advance just created, so this round can complete and the next
     * one be generated. Left unsettled the bracket waits on a game nobody can play.
     * PERFORM calls the function for its side effects; a bare call is not a statement
     * PL/pgSQL accepts.
     */
    PERFORM public.playoff_settle_pending_byes(p_league_id, v_season_id);

    RETURN v_count;
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

    IF public.playoff_round_exists(p_league_id, v_season_id, v_week, 'upper') THEN
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
        (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
      VALUES
        (p_league_id, v_season_id, v_week, TRUE, v_a, v_b, 'scheduled', 'upper', v_j);
      v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
  END LOOP;

  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION public.playoff_settle_pending_byes(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_settle_pending_byes(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.generate_playoff_round(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_playoff_round(UUID) TO authenticated;
