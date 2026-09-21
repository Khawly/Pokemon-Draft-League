-- Fix ambiguous season_id references in the draft-turn resolver
--
-- get_draft_turn declares RETURNS TABLE (season_id, ...), which creates a
-- PL/pgSQL OUT parameter named season_id. Any bare `season_id` used as a
-- query value in the function body already becomes an ambiguous-column error
-- as soon as the function actually runs (queries like `WHERE t.season_id =
-- season_id`), now that a live draft exercises these paths for the first
-- time. The fix routes the season id through a local v_season_id variable
-- and assigns the OUT parameter only at the end.

-- Recreates get_draft_turn with the season id carried in a local variable so
-- no bare OUT-parameter name collides with a table column. Behavior is
-- unchanged: it resolves the on-turn team/slot for the active draft, raising
-- for missing/malformed state.
--
-- @param p_league_id - The id of the league whose turn is being resolved.
-- @returns The on-turn season/round/pick/team metadata.
CREATE OR REPLACE FUNCTION public.get_draft_turn(
  p_league_id UUID
)
RETURNS TABLE (
  season_id UUID,
  round_number INTEGER,
  pick_in_round INTEGER,
  overall_pick INTEGER,
  team_id UUID,
  on_turn_user_id UUID,
  teams_count INTEGER,
  total_rounds INTEGER,
  is_snake_reversal BOOLEAN,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_season_id UUID;
  v_format TEXT;
  v_teams_count INTEGER;
  v_picks_count INTEGER;
  v_overall INTEGER;
  v_round INTEGER;
  v_slot INTEGER;
  v_team_id UUID;
  v_owner UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No season exists for this league.';
  END IF;

  IF v_status <> 'draft_active' THEN
    RAISE EXCEPTION 'The draft is not active.';
  END IF;

  SELECT ls.draft_format, ls.total_rounds INTO v_format, total_rounds
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  total_rounds := COALESCE(total_rounds, 1);

  SELECT COUNT(*)::INTEGER INTO v_teams_count
  FROM public.teams t
  WHERE t.season_id = v_season_id;

  IF v_teams_count <= 0 THEN
    RAISE EXCEPTION 'The draft order has no teams.';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_picks_count
  FROM public.draft_picks d
  WHERE d.season_id = v_season_id;

  v_overall := v_picks_count + 1;

  IF v_overall > v_teams_count * total_rounds THEN
    RAISE EXCEPTION 'The draft is already complete.';
  END IF;

  v_round := ((v_overall - 1) / v_teams_count) + 1;
  v_slot := ((v_overall - 1) % v_teams_count) + 1;

  round_number := v_round;
  pick_in_round := v_slot;
  overall_pick := v_overall;
  teams_count := v_teams_count;
  is_snake_reversal := (v_format = 'snake' AND v_round % 2 = 0);
  status := v_status;

  IF is_snake_reversal THEN
    v_slot := v_teams_count - v_slot + 1;
  END IF;

  SELECT t.id, t.owner_user_id INTO v_team_id, v_owner
  FROM public.teams t
  WHERE t.season_id = v_season_id AND t.draft_position = v_slot;

  IF v_team_id IS NULL THEN
    RAISE EXCEPTION 'The draft order is not fully set up.';
  END IF;

  team_id := v_team_id;
  on_turn_user_id := v_owner;
  season_id := v_season_id;

  RETURN NEXT;
END;
$$;