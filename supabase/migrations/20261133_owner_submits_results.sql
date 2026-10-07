-- Lets the league owner submit match results for any match in their league,
-- not only the matches they play. Replaces submit_game_result from
-- 20261018_schedule_page.sql; every other check and the grants are unchanged.
-- When the owner files a result for a match between two other teams, both
-- team owners are notified, since neither side is the reporter.

-- RPC: submit_game_result (participants or the league owner)
-- Submits one result per game for a match. Callable by either participant or the
-- league owner (SECURITY DEFINER, authenticated only). Enforces single submission
-- per game, the replay-link uniqueness rule, valid game numbers for the match
-- format, and closes the match once a team reaches the required win count.
CREATE OR REPLACE FUNCTION public.submit_game_result(
  p_match_id UUID,
  p_game_number INTEGER,
  p_winner_team_id UUID,
  p_replay_url TEXT,
  p_pokemon_left_alive INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_format TEXT;
  v_max_games INTEGER;
  v_status TEXT;
  v_winner_team_id UUID;
  v_my_team_id UUID;
  v_opponent_team_id UUID;
  v_message TEXT;
  v_type TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to report a result.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT (
    public.is_match_participant(p_match_id)
    OR public.is_league_owner(v_match.league_id)
  ) THEN
    RAISE EXCEPTION 'Only the participants or the league owner can report a result.';
  END IF;

  -- NULL when the reporter is the league owner filing for a match they do not play.
  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  IF p_winner_team_id NOT IN (v_match.player_1_team_id, v_match.player_2_team_id) THEN
    RAISE EXCEPTION 'The winner must be one of the two participants.';
  END IF;

  IF p_game_number IS NULL OR p_game_number < 1 THEN
    RAISE EXCEPTION 'Invalid game number.';
  END IF;

  IF p_pokemon_left_alive IS NOT NULL AND (p_pokemon_left_alive < 0 OR p_pokemon_left_alive > 6) THEN
    RAISE EXCEPTION 'Surviving Pokemon must be between 0 and 6.';
  END IF;

  SELECT COALESCE(CASE WHEN v_match.is_playoff THEN ls.playoff_match_format ELSE ls.match_format END, 'best_of_3')
  INTO v_format
  FROM public.league_settings ls
  WHERE ls.season_id = v_match.season_id;

  v_max_games := CASE WHEN v_format = 'single' THEN 1 ELSE 3 END;

  IF p_game_number > v_max_games THEN
    RAISE EXCEPTION 'That game is outside this match format.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.match_results
    WHERE match_id = p_match_id AND game_number = p_game_number
  ) THEN
    RAISE EXCEPTION 'A result for this game has already been submitted.';
  END IF;

  IF p_replay_url IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.match_results mr
    WHERE mr.replay_url = p_replay_url AND mr.match_id <> p_match_id
  ) THEN
    RAISE EXCEPTION 'Link already submitted';
  END IF;

  INSERT INTO public.match_results (match_id, reporter_user_id, winner_team_id, replay_url, game_number, pokemon_left_alive, is_manual)
  VALUES (p_match_id, v_user_id, p_winner_team_id, NULLIF(p_replay_url, ''), p_game_number, p_pokemon_left_alive, FALSE);

  v_status := public.recompute_match_status(p_match_id);
  SELECT winner_team_id INTO v_winner_team_id FROM public.matches WHERE id = p_match_id;

  v_type := CASE WHEN v_status = 'completed' THEN 'match_completed' ELSE 'match_result' END;

  IF v_my_team_id IS NULL THEN
    -- The owner filed this for a match between two other teams: tell both sides.
    v_message := 'The league owner filed a result for your match (game ' || p_game_number || ').';
    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_match.player_1_team_id, v_user_id,
      v_type, v_message, v_match.id
    );
    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_match.player_2_team_id, v_user_id,
      v_type, v_message, v_match.id
    );
  ELSE
    v_opponent_team_id := CASE
      WHEN v_match.player_1_team_id = v_my_team_id THEN v_match.player_2_team_id
      ELSE v_match.player_1_team_id
    END;
    v_message := 'A result was filed for your match (game ' || p_game_number || ').';
    PERFORM public.notify_match_actor(
      v_match.league_id, v_match.season_id, v_opponent_team_id, v_user_id,
      v_type, v_message, v_match.id
    );
  END IF;

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_game_result(UUID, INTEGER, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_game_result(UUID, INTEGER, UUID, TEXT, INTEGER) TO authenticated;
