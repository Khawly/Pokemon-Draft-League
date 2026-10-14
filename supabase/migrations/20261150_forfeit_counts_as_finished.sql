-- Treats a forfeit as a finished game when advancing the bracket.
--
-- The bracket helpers decided whether a game was over by asking for
--
--   status = 'completed' AND winner_team_id IS NOT NULL
--
-- A forfeit settles a game and records a winner just as a normal result does; only
-- the status differs. A round whose games were all forfeited therefore looked
-- permanently unfinished: the round never registered as done, so the next round was
-- never created, and the bracket stalled after round one with no error anywhere.
--
-- Same for the winner and loser lookups, which returned NULL for a forfeited game,
-- so even a completed round would have produced a next round with empty slots.
--
-- 'cancelled' counts as finished for the same reason: the game will never be played,
-- so the bracket has to move past it rather than wait forever.

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
      AND m.winner_team_id IS NOT NULL
    )
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.week_number = p_week
    AND m.bracket_phase = p_phase;
$$;

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
    AND m.status IN ('completed', 'forfeit', 'cancelled')
    AND m.winner_team_id IS NOT NULL;
$$;

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
    AND m.status IN ('completed', 'forfeit', 'cancelled')
    AND m.winner_team_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.playoff_round_done(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_game_winner(UUID, UUID, INTEGER, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_game_loser(UUID, UUID, INTEGER, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_round_done(UUID, UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_game_winner(UUID, UUID, INTEGER, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_game_loser(UUID, UUID, INTEGER, TEXT, INTEGER) TO authenticated;
