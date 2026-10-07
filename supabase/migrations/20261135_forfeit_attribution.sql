-- Records who forfeited a match, so forfeit cards can name the person who filed it.
-- Adds matches.forfeited_by_user_id and sets it in forfeit_match (participants)
-- and owner_forfeit_match (league owner). Everything else in both functions is
-- unchanged. Forfeits recorded before this migration, and those the weekly
-- deadline settles automatically, keep a NULL here and show no attribution.

-- Column: the profile that filed a forfeit, when a person filed it.
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS forfeited_by_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- RPC: forfeit_match (participants)
-- A participant forfeits the match to their opponent, which closes the match with
-- the opponent as winner, records who filed it, and notifies the opponent.
CREATE OR REPLACE FUNCTION public.forfeit_match(p_match_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_my_team_id UUID;
  v_winner_team_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to forfeit.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.is_match_participant(p_match_id) THEN
    RAISE EXCEPTION 'Only the participants can forfeit a match.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  v_winner_team_id := CASE
    WHEN v_match.player_1_team_id = v_my_team_id THEN v_match.player_2_team_id
    ELSE v_match.player_1_team_id
  END;

  UPDATE public.matches
  SET status = 'forfeit',
      winner_team_id = v_winner_team_id,
      forfeited_by_user_id = v_user_id,
      updated_at = NOW()
  WHERE id = p_match_id;

  PERFORM public.notify_match_actor(
    v_match.league_id, v_match.season_id, v_winner_team_id, v_user_id,
    'match_forfeit', 'Your opponent forfeited the match.', v_match.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.forfeit_match(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forfeit_match(UUID) TO authenticated;

-- RPC: owner_forfeit_match (league owner)
-- Closes an open match as a forfeit on behalf of one or both players, records the
-- owner as the filer, and notifies both team owners. 'player_1' / 'player_2'
-- forfeit that side and the other wins; 'both' is a double forfeit with no winner.
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
