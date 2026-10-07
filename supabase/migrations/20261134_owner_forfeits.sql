-- Owner forfeits for any open match, and the forfeit KO penalty in standings.
-- Adds owner_forfeit_match (forfeit player 1, forfeit player 2, or forfeit both)
-- and replaces season_standings so a forfeiting team takes the same maximum
-- negative KO differential as a double forfeit, while the winner of a single
-- forfeit gets no KO credit for it. The penalty applies to participant forfeits
-- too, since they close a match the same way.

-- RPC: owner_forfeit_match (league owner)
-- Closes an open match as a forfeit on behalf of one or both players. 'player_1'
-- and 'player_2' forfeit that side and the other side wins; 'both' closes the
-- match with no winner as a double forfeit. Callable by the league owner only
-- (SECURITY DEFINER, authenticated only). Notifies both team owners.
CREATE OR REPLACE FUNCTION public.owner_forfeit_match(p_match_id UUID, p_side TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_winner_team_id UUID;
  v_forfeiter_team_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to forfeit a match.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.is_league_owner(v_match.league_id) THEN
    RAISE EXCEPTION 'Only the league owner can forfeit a match on a player''s behalf.';
  END IF;

  IF p_side NOT IN ('player_1', 'player_2', 'both') THEN
    RAISE EXCEPTION 'Choose which player forfeits, or both.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  IF p_side = 'both' THEN
    UPDATE public.matches
    SET status = 'forfeit', winner_team_id = NULL, updated_at = NOW()
    WHERE id = p_match_id;

    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_match.player_1_team_id, v_user_id,
      'match_forfeit', 'The league owner forfeited your match for both players.', v_match.id
    );
    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_match.player_2_team_id, v_user_id,
      'match_forfeit', 'The league owner forfeited your match for both players.', v_match.id
    );
  ELSE
    IF p_side = 'player_1' THEN
      v_forfeiter_team_id := v_match.player_1_team_id;
      v_winner_team_id := v_match.player_2_team_id;
    ELSE
      v_forfeiter_team_id := v_match.player_2_team_id;
      v_winner_team_id := v_match.player_1_team_id;
    END IF;

    UPDATE public.matches
    SET status = 'forfeit', winner_team_id = v_winner_team_id, updated_at = NOW()
    WHERE id = p_match_id;

    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_forfeiter_team_id, v_user_id,
      'match_forfeit', 'The league owner forfeited your match for you.', v_match.id
    );
    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_winner_team_id, v_user_id,
      'match_forfeit', 'Your opponent forfeited the match.', v_match.id
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.owner_forfeit_match(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_forfeit_match(UUID, TEXT) TO authenticated;

-- Ranks every team of the league's latest season by wins, losses, and KO Diff.
-- A closed match with no winner is a double forfeit and charges both teams the
-- maximum negative differential for the season's format (-12 for 6v6 best of 3).
-- A forfeit with a winner charges the losing (forfeiting) team the same amount;
-- the winner gets no KO credit for it. Reported games drive the normal per-game
-- differential.
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
        AND t.id IN (m.player_1_team_id, m.player_2_team_id))
    + (SELECT COUNT(*)::BIGINT * v_double_forfeit_diff
      FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.status = 'forfeit' AND m.winner_team_id IS NOT NULL
        AND m.winner_team_id <> t.id
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS ko_diff
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id
  ORDER BY wins DESC, losses ASC, ko_diff DESC, t.team_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.season_standings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.season_standings(UUID) TO authenticated;
