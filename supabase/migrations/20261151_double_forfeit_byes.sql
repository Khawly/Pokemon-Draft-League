-- Lets a double forfeit pass the bracket instead of stalling it.
--
-- The deadline settles an unreported match as a double loss by writing
--
--   status = 'forfeit', winner_team_id = NULL
--
-- so a double forfeit has neither a winner nor a loser. Every helper required a winner
-- before calling a game finished, so the round never registered as done, the next
-- round was never created, and the tournament stopped dead with nothing to explain it.
-- A league already had one such match sitting stalled.
--
-- Two changes:
--
-- 1. playoff_round_done accepts a double forfeit as finished. Its status is forfeit,
--    so it is only the missing winner that made it look unfinished.
--
-- 2. advance_12 inserts each round from a filtered VALUES list instead of a plain one.
--    A game whose feeder was a double forfeit resolves to a null side and is not
--    created; the surviving side advances, exactly as a first-round bye does. Without
--    this the insert would fail on a null team id and the whole round would error.
--
-- playoff_game_winner and playoff_game_loser are unchanged: returning NULL when there
-- is no winner is already the right answer for a double forfeit, and this rule is what
-- gives that NULL somewhere to go.
--
-- The effect is one fewer team in that branch, cascading on its own: the team that
-- would have met the vacated winner reaches the grand final, and the team that would
-- have met the vacated loser takes the next lower round.

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
  SELECT public.playoff_round_exists(p_league_id, p_season_id, p_week, p_phase)
         AND bool_and(
      m.status IN ('completed', 'forfeit', 'cancelled')
      AND (
        m.winner_team_id IS NOT NULL
        OR m.status = 'forfeit'
      )
    )
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.week_number = p_week
    AND m.bracket_phase = p_phase;
$$;

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
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 1, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
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
    RETURN 4;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 2, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 2, v_seeds[1], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 1), 'upper', 1::INTEGER),
  (v_base + 2, v_seeds[2], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 2), 'upper', 2::INTEGER),
  (v_base + 2, v_seeds[3], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 3), 'upper', 3::INTEGER),
  (v_base + 2, v_seeds[4], public.playoff_game_winner(p_league_id, p_season_id, v_base + 1, 'upper', 4), 'upper', 4::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 4;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 3, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 3, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'upper', 1::INTEGER),
  (v_base + 3, public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'upper', 2::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 2;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 4, 'upper') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'upper', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 1;
  END IF;

  -- Losers bracket. Round one shares a week with winners round three because its
  -- inputs (the round one and round two losers) have all landed by then.
  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 3, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 4), 'lower', 1::INTEGER),
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 3), 'lower', 2::INTEGER),
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 3), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 2), 'lower', 3::INTEGER),
  (v_base + 3, public.playoff_game_loser(p_league_id, p_season_id, v_base + 1, 'upper', 4), public.playoff_game_loser(p_league_id, p_season_id, v_base + 2, 'upper', 1), 'lower', 4::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 4;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 4, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 2), 'lower', 1::INTEGER),
  (v_base + 4, public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 3), public.playoff_game_winner(p_league_id, p_season_id, v_base + 3, 'lower', 4), 'lower', 2::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 2;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 5, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 5, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 1), 'lower', 1::INTEGER),
  (v_base + 5, public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'lower', 2), public.playoff_game_loser(p_league_id, p_season_id, v_base + 3, 'upper', 2), 'lower', 2::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 2;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 6, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 6, public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 5, 'lower', 2), 'lower', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 1;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 7, 'lower') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 7, public.playoff_game_loser(p_league_id, p_season_id, v_base + 4, 'upper', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 6, 'lower', 1), 'lower', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 1;
  END IF;

  IF NOT public.playoff_round_exists(p_league_id, p_season_id, v_base + 8, 'gf') THEN
INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase, bracket_slot)
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 8, public.playoff_game_winner(p_league_id, p_season_id, v_base + 7, 'lower', 1), public.playoff_game_winner(p_league_id, p_season_id, v_base + 4, 'upper', 1), 'gf', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
    RETURN 1;
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
SELECT p_league_id, v_season_id, t.week, TRUE, t.p1, t.p2, 'scheduled', t.phase, t.slot
FROM (VALUES
  (v_base + 9, public.playoff_game_winner(p_league_id, p_season_id, v_base + 8, 'gf', 1), public.playoff_game_loser(p_league_id, p_season_id, v_base + 8, 'gf', 1), 'gf', 1::INTEGER)
) AS t(week, p1, p2, phase, slot)
-- A side that resolved to nothing had a double forfeit as its feeder.
-- The game is not created and the surviving side advances, which is how a
-- bye behaves; without this the insert fails on a null team id.
WHERE t.p1 IS NOT NULL AND t.p2 IS NOT NULL;
      RETURN 1;
    END IF;
  END IF;

  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION public.playoff_round_done(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_round_done(UUID, UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_advance_12(UUID, UUID, INTEGER, UUID[], TEXT) TO authenticated;
