-- Lets admins edit matchup cards when the league owner turns the setting on.
-- Adds league_settings.admins_edit_matchups and can_edit_matchups(match), which
-- allows the league owner always and admins only while the setting is on for the
-- match's season. submit_game_result, owner_forfeit_match and owner_revert_forfeit
-- now use it instead of the owner-only check. Their behaviour is otherwise unchanged.

-- Column: whether admins may act on matchup cards for the season.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS admins_edit_matchups BOOLEAN NOT NULL DEFAULT FALSE;

-- Helper: may the signed-in user act on this match's card? True for the league
-- owner; true for an active admin only when the season's setting is on. Returns
-- FALSE for an unknown match or a signed-out caller.
CREATE OR REPLACE FUNCTION public.can_edit_matchups(p_match_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT m.league_id, m.season_id INTO v_match
  FROM public.matches m
  WHERE m.id = p_match_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF public.is_league_owner(v_match.league_id) THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.league_members lm
    JOIN public.league_settings ls ON ls.season_id = v_match.season_id
    WHERE lm.league_id = v_match.league_id
      AND lm.user_id = v_user_id
      AND lm.role = 'admin'
      AND lm.is_active = TRUE
      AND ls.admins_edit_matchups = TRUE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.can_edit_matchups(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_edit_matchups(UUID) TO authenticated;

-- RPC: submit_game_result (participants, or anyone who can edit the matchup card)
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
    OR public.can_edit_matchups(p_match_id)
  ) THEN
    RAISE EXCEPTION 'Only the participants, the league owner, or admins allowed to edit matchups can report a result.';
  END IF;

  -- NULL when the reporter is not playing in the match.
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
    -- Filed by someone not playing in the match: tell both sides.
    v_message := 'A league manager filed a result for your match (game ' || p_game_number || ').';
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

-- RPC: owner_forfeit_match (league owner, or admins allowed to edit matchups)
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

  IF NOT public.can_edit_matchups(p_match_id) THEN
    RAISE EXCEPTION 'Only the league owner, or admins allowed to edit matchups, can forfeit a match on a player''s behalf.';
  END IF;

  IF p_side NOT IN ('player_1', 'player_2', 'both') THEN
    RAISE EXCEPTION 'Choose which player forfeits, or both.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  IF p_side = 'both' THEN
    UPDATE public.matches
    SET status = 'forfeit',
        winner_team_id = NULL,
        forfeited_by_user_id = v_user_id,
        updated_at = NOW()
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
    SET status = 'forfeit',
        winner_team_id = v_winner_team_id,
        forfeited_by_user_id = v_user_id,
        updated_at = NOW()
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

-- RPC: owner_revert_forfeit (league owner, or admins allowed to edit matchups)
CREATE OR REPLACE FUNCTION public.owner_revert_forfeit(p_match_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to revert a forfeit.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.can_edit_matchups(p_match_id) THEN
    RAISE EXCEPTION 'Only the league owner, or admins allowed to edit matchups, can revert a forfeit.';
  END IF;

  IF v_match.status <> 'forfeit' THEN
    RAISE EXCEPTION 'This match is not forfeited.';
  END IF;

  UPDATE public.matches
  SET winner_team_id = NULL,
      forfeited_by_user_id = NULL,
      updated_at = NOW()
  WHERE id = p_match_id;

  -- Restores completed / in_progress / scheduled / unscheduled from the reported games.
  v_status := public.recompute_match_status(p_match_id);

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.owner_revert_forfeit(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_revert_forfeit(UUID) TO authenticated;
