-- Standings for a named season rather than for whichever season is newest.
--
-- season_standings resolves the league's latest season internally, which is right for a
-- page that is about the season in progress and wrong for one that is looking back. The
-- rules are identical -- regular season only, results and forfeits charged the same way --
-- so this is the same query with the season supplied instead of guessed.
--
-- @returns One row per team in that season, ranked.
CREATE OR REPLACE FUNCTION public.season_standings_for(
  p_league_id UUID,
  p_season_id UUID
)
RETURNS TABLE (team_id UUID, team_name TEXT, wins BIGINT, losses BIGINT, ko_diff BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
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

  IF NOT EXISTS (
    SELECT 1 FROM public.seasons s
    WHERE s.id = p_season_id AND s.league_id = p_league_id
  ) THEN
    RAISE EXCEPTION 'That season does not belong to this league.';
  END IF;

  SELECT COALESCE(ls.match_format, 'best_of_3'), COALESCE(ls.league_format, '6v6')
  INTO v_match_format, v_league_format
  FROM public.league_settings ls
  WHERE ls.season_id = p_season_id;

  v_games_to_win := CASE WHEN v_match_format = 'single' THEN 1 ELSE 2 END;
  v_team_size := CASE WHEN v_league_format = '4v4' THEN 4 ELSE 6 END;
  v_double_forfeit_diff := (v_games_to_win * v_team_size) * -1;

  RETURN QUERY
  SELECT
    t.id AS team_id,
    t.team_name AS team_name,
    (SELECT COUNT(*)::BIGINT FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = p_season_id
        AND NOT m.is_playoff
        AND m.status IN ('completed','forfeit') AND m.winner_team_id = t.id) AS wins,
    (SELECT COUNT(*)::BIGINT FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = p_season_id
        AND NOT m.is_playoff
        AND m.status IN ('completed','forfeit')
        AND (m.winner_team_id IS NULL OR m.winner_team_id <> t.id)
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS losses,
    (SELECT COALESCE(SUM(CASE WHEN mr.winner_team_id = t.id THEN mr.pokemon_left_alive ELSE -mr.pokemon_left_alive END), 0)::BIGINT
      FROM public.match_results mr
      JOIN public.matches m ON m.id = mr.match_id
      WHERE m.league_id = p_league_id AND m.season_id = p_season_id
        AND NOT m.is_playoff
        AND mr.pokemon_left_alive IS NOT NULL
        AND t.id IN (m.player_1_team_id, m.player_2_team_id))
    + (SELECT COUNT(*)::BIGINT * v_double_forfeit_diff
      FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = p_season_id
        AND NOT m.is_playoff
        AND m.status IN ('completed','forfeit') AND m.winner_team_id IS NULL
        AND t.id IN (m.player_1_team_id, m.player_2_team_id))
    + (SELECT COUNT(*)::BIGINT * v_double_forfeit_diff
      FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = p_season_id
        AND NOT m.is_playoff
        AND m.status = 'forfeit' AND m.winner_team_id IS NOT NULL
        AND m.winner_team_id <> t.id
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS ko_diff
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = p_season_id
  ORDER BY wins DESC, losses ASC, ko_diff DESC, t.team_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.season_standings_for(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.season_standings_for(UUID, UUID) TO authenticated;