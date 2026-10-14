-- Makes the bracket wait for results before building the rounds that depend on them.
--
-- `playoff_advance_12` guarded every round on `NOT playoff_round_exists(...)` and
-- nothing else. Existence says a round has been created; it says nothing about whether
-- the games feeding it have been played. Pressing Advance twice in a row therefore ran
-- the whole function top to bottom: week nine's games were created and left unplayed,
-- and the block for week ten read their winners as NULL and tried to insert a game
-- whose first side was empty.
--
-- Two things were wrong with how that surfaced.
--
-- The insert guard was `WHERE p1 IS NOT NULL OR p2 IS NOT NULL`, which permits a game
-- whose surviving team arrived on the second feeder. But `matches_playoff_participants`
-- requires player_1_team_id on every playoff row, so the insert was rejected outright:
-- advancing raised `null value in column "player_1_team_id"`, which surfaced as a failed
-- RPC rather than as a bracket problem.
--
-- Relaxing that guard instead would have been worse. A round created before its feeders
-- resolved produces sides that are empty because nobody has played yet, not because a
-- team was eliminated, and `playoff_settle_pending_byes` would hand those teams a bye
-- win they did not earn and carry them into the next round.
--
-- So the rounds now wait. `playoff_round_settled` asks whether every game in a round has
-- reached a terminal status, which deliberately does not require a winner: a double
-- forfeit is settled even though it produces neither a winner nor a loser, and that is
-- the case where the empty side really is an elimination rather than a pending result.
-- Each round below is created only once the rounds feeding it have settled, which is the
-- behaviour the schedule page describes -- advancing when the week's games are in
-- produces the next set of matchups.
--
-- `playoff_insert_game` normalises the two remaining single-sided cases on the way in.
-- When only one feeder resolved, that team is written to player_1 and player_2 is left
-- null, which is the shape `playoff_settle_pending_byes` looks for and the shape the
-- table's check constraint allows. A game where neither side resolved is not written at
-- all, because there is nobody to advance.

-- True when a round exists and every game in it has reached a terminal status.
--
-- Unlike playoff_round_done this does not require a winner, so a double forfeit counts
-- as settled. That distinction is the whole point: a game still awaiting a result must
-- hold a round back, while a game that ended with nobody winning must not.
CREATE OR REPLACE FUNCTION public.playoff_round_settled(
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
  SELECT public.playoff_round_exists(p_league_id, p_season_id, p_week, p_phase)
         AND bool_and(m.status IN ('completed', 'forfeit', 'cancelled'))
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.week_number = p_week
    AND m.bracket_phase = p_phase;
$$;

-- Writes one bracket game, putting whichever side exists into player_1.
--
-- The column order is load-bearing rather than cosmetic. The table's check constraint
-- requires player_1_team_id on every playoff row, and playoff_settle_pending_byes looks
-- for a row whose player_1 is set and player_2 is null in order to credit the bye, so a
-- lone team arriving on the second feeder has to be normalised on the way in.
--
-- Games created by the same press of Advance Playoffs share a bracket round number.
--
-- The bracket's weeks continue on from the regular season's, so a five week league runs
-- its rounds over weeks six to seventeen, and one press can create games in several of
-- them: pressing Advance after the opening round writes the next winners round and the
-- first losers round together. A number taken from the week therefore splits one press
-- across two labels, and a number taken from the round alone is not comparable between
-- the winners and losers brackets, which run their rounds in parallel.
--
-- So the number is the press, not the week and not the round. It is recorded per game on
-- the way in, which is the only point at which "these games were all created together" is
-- known. Games predating this column fall back to counting from the first playoff week.
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS playoff_round_no INTEGER;

COMMENT ON COLUMN public.matches.playoff_round_no IS
  'Which press of Advance Playoffs created this game. One press can create games in several weeks and in two phases at once, so this is what a readable bracket round number has to come from.';

-- @param p_round_no - The bracket round number shared by every game this press created.
-- @returns TRUE when a row was written, FALSE when neither side resolved.
CREATE OR REPLACE FUNCTION public.playoff_insert_game(
  p_league_id UUID,
  p_season_id UUID,
  p_week INTEGER,
  p_p1 UUID,
  p_p2 UUID,
  p_phase TEXT,
  p_slot INTEGER,
  p_round_no INTEGER DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first UUID;
  v_second UUID;
BEGIN
  IF p_p1 IS NULL AND p_p2 IS NULL THEN
    RETURN FALSE;
  END IF;

  v_first := COALESCE(p_p1, p_p2);
  v_second := CASE WHEN p_p1 IS NULL THEN NULL ELSE p_p2 END;

  INSERT INTO public.matches
    (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot, playoff_round_no)
  VALUES
    (p_league_id, p_season_id, p_week, TRUE, v_first, v_second, 'scheduled', p_phase, p_slot, p_round_no);

  RETURN TRUE;
END;
$$;

-- The bracket round number for a game's label.
--
-- Games written before the column existed, or by a path that does not set it, count from
-- the first playoff week, which is what the page showed before presses were numbered.
--
-- @returns The bracket round number, or null when the match is not a playoff game.
CREATE OR REPLACE FUNCTION public.playoff_round_number(
  p_league_id UUID,
  p_season_id UUID,
  p_week INTEGER,
  p_round_no INTEGER
) RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    p_round_no,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM public.matches m
        WHERE m.league_id = p_league_id
          AND m.season_id = p_season_id
          AND m.is_playoff
      )
      THEN p_week - (
        SELECT MIN(m2.week_number)
        FROM public.matches m2
        WHERE m2.league_id = p_league_id
          AND m2.season_id = p_season_id
          AND m2.is_playoff
      ) + 1
      ELSE NULL
    END
  );
$$;

-- Builds the twelve-team double-elimination bracket one ready round at a time.
--
-- Round one pairs seeds eleven to twelve, nine to ten, seven to eight and five to six:
-- the field is reversed so the strongest remaining seeds meet each other and the top four
-- take a free week, which is the twelve-team case of "descend to the nearest power of
-- two and give the difference a bye". The top four re-enter in round two against those
-- four winners.
--
-- Each block is skipped unless the rounds feeding it have settled. Skipping is not a
-- failure: the next call picks the round up once its results land, and the function
-- reports how many games it wrote so the caller can tell whether anything happened.
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
BEGIN
  IF p_format <> 'double_elimination' THEN
    RAISE EXCEPTION 'The twelve-team bracket is defined for double elimination; this league is set to %.', p_format;
  END IF;

  -- Winners bracket, rounds one to four. Round one draws only on seeds, so it has no
  -- feeder to wait for.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 1, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 1, v_seeds[11], v_seeds[12], 'upper', 1) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 1, v_seeds[9], v_seeds[10], 'upper', 2) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 1, v_seeds[7], v_seeds[8], 'upper', 3) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 1, v_seeds[5], v_seeds[6], 'upper', 4) THEN 1 ELSE 0 END);
  END IF;

  -- Round two is where the four seeds who had a bye week come back in.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 2, 'upper')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 1, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 2, v_seeds[1], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 1), 'upper', 1) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 2, v_seeds[2], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 2), 'upper', 2) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 2, v_seeds[3], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 3), 'upper', 3) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 2, v_seeds[4], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 4), 'upper', 4) THEN 1 ELSE 0 END);
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 3, 'upper')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 2, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 3, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'upper', 1) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 3, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'upper', 2) THEN 1 ELSE 0 END);
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 4, 'upper')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 3, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'upper', 1) THEN 1 ELSE 0 END);
  END IF;

  -- Losers bracket. Round one shares a week with winners round three because both of its
  -- inputs, the round one and round two losers, have landed by then.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 3, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 1, 'upper')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 2, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'lower', 1) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 3), 'lower', 2) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 3), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'lower', 3) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 4), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 1), 'lower', 4) THEN 1 ELSE 0 END);
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 4, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 3, 'lower') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 2), 'lower', 1) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 4), 'lower', 2) THEN 1 ELSE 0 END);
  END IF;

  -- The losers bracket resumes by dropping the two losers of winners round three in
  -- against the survivors, which is what keeps a team from being eliminated on its first
  -- loss.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 5, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 4, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 3, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 5, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 1), 'lower', 1) THEN 1 ELSE 0 END);
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 5, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'lower', 2) THEN 1 ELSE 0 END);
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 6, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 5, 'lower') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 6, public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 2), 'lower', 1) THEN 1 ELSE 0 END);
  END IF;

  -- The lower champion meets the loser of winners round four here. A team arriving from
  -- the winners bracket can still be beaten here, which is exactly the case that triggers
  -- the reset below.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 7, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 6, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 4, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 7, public.playoff_game_loser(p_league_id, p_season_id, v_base + 4, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 6, 'lower', 1), 'lower', 1) THEN 1 ELSE 0 END);
  END IF;

  -- Grand final: losers bracket champion against winners bracket champion.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 8, 'gf')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 7, 'lower')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 4, 'upper') THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 8, public.playoff_game_winner(p_league_id, p_season_id, v_base + 7, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'upper', 1), 'gf', 1) THEN 1 ELSE 0 END);
  END IF;

  -- Reset, only when the winners bracket champion lost the grand final. Its loser is
  -- not the winners bracket champion precisely when that champion went down, and a
  -- losers bracket champion winning the first final is not enough on its own.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 9, 'gf')
     AND public.playoff_round_settled(p_league_id, p_season_id, v_base + 8, 'gf')
     AND EXISTS (
       SELECT 1
       FROM public.matches m
       WHERE m.id = public.playoff_game(p_league_id, p_season_id, v_base + 8, 'gf', 1)
         AND m.winner_team_id IS DISTINCT FROM public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'upper', 1)
     ) THEN
    v_count := v_count + (CASE WHEN public.playoff_insert_game(p_league_id, p_season_id, v_base + 9, public.playoff_game_winner(p_league_id, p_season_id, v_base + 8, 'gf', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 8, 'gf', 1), 'gf', 1) THEN 1 ELSE 0 END);
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.playoff_round_settled(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_insert_game(UUID, UUID, INTEGER, UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_round_settled(UUID, UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_insert_game(UUID, UUID, INTEGER, UUID, UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) TO authenticated;