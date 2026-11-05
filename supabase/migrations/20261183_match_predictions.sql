-- Match winner predictions and the PP column in the season standings
--
-- Any active league member may predict which side wins a matchup. A correct pick
-- is worth one "PP" point, attributed in the standings to the predicting member's
-- own team. Predictions lock when the agreed match time arrives or when the first
-- game result is submitted, whichever comes first. The RPC below is the only
-- write path, so a stale browser cannot bypass either rule, and the standings
-- derive the points from the stored picks rather than keeping a separate tally
-- that could drift from the match results.
--
-- Playoff predictions count too: PP is a season-long side statistic, and every
-- matchup on the schedule is predictable. The competitive W/L/KO columns keep
-- their existing regular-season-only rule.

-- One member's winner pick for one match. The league and season are copied from
-- the match so the standings and page loaders can scope without joining, and are
-- written only by the RPC below, which reads them from the match itself.
CREATE TABLE IF NOT EXISTS public.match_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  predicted_team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, user_id)
);

-- Speeds the schedule page's "this member's picks for the season" read.
CREATE INDEX IF NOT EXISTS match_predictions_season_user_idx
  ON public.match_predictions (season_id, user_id);

-- Speeds the standings' count of correct picks per team owner.
CREATE INDEX IF NOT EXISTS match_predictions_match_idx
  ON public.match_predictions (match_id);

ALTER TABLE public.match_predictions ENABLE ROW LEVEL SECURITY;

-- Members can read predictions made in their league. There are deliberately no
-- INSERT/UPDATE/DELETE policies: every write goes through set_match_prediction,
-- which owns the lock rules.
DROP POLICY IF EXISTS "League members can view match predictions" ON public.match_predictions;
CREATE POLICY "League members can view match predictions"
ON public.match_predictions
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

-- Predictions are read by the schedule page as the signed-in member. Writes are
-- RPC-only, so no INSERT/UPDATE/DELETE grant is needed here.
GRANT SELECT ON public.match_predictions TO authenticated;

-- Records or changes the caller's pick for a match.
--
-- Refuses the write when the match is no longer open: after the agreed time, once
-- any game has been submitted, or once the match has left the scheduled states.
-- The match row is locked while the checks run so a concurrent result submission
-- and prediction cannot both pass their checks and land out of order.
--
-- @param p_match_id - The match being predicted.
-- @param p_predicted_team_id - One of the match's two teams.
-- @returns The team id stored as the caller's pick.
CREATE OR REPLACE FUNCTION public.set_match_prediction(
  p_match_id UUID,
  p_predicted_team_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to predict a match.';
  END IF;

  SELECT
    m.id,
    m.league_id,
    m.season_id,
    m.status,
    m.scheduled_at,
    m.player_1_team_id,
    m.player_2_team_id
  INTO v_match
  FROM public.matches m
  WHERE m.id = p_match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.is_active_league_member(v_match.league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  IF v_match.player_2_team_id IS NULL THEN
    RAISE EXCEPTION 'This match has no opponent to predict against.';
  END IF;

  IF p_predicted_team_id IS NULL
     OR p_predicted_team_id NOT IN (
       v_match.player_1_team_id,
       v_match.player_2_team_id
     )
  THEN
    RAISE EXCEPTION 'Pick one of the two teams in this match.';
  END IF;

  -- 'unscheduled' is still open: without an agreed time only a submitted result
  -- can close the prediction.
  IF v_match.status NOT IN ('scheduled', 'unscheduled') THEN
    RAISE EXCEPTION 'Predictions are closed for this match.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.match_results mr WHERE mr.match_id = p_match_id
  ) THEN
    RAISE EXCEPTION 'Predictions are closed because a game has been submitted.';
  END IF;

  IF v_match.scheduled_at IS NOT NULL AND NOW() >= v_match.scheduled_at THEN
    RAISE EXCEPTION 'Predictions are closed because the scheduled time has passed.';
  END IF;

  INSERT INTO public.match_predictions (
    league_id,
    season_id,
    match_id,
    user_id,
    predicted_team_id
  )
  VALUES (
    v_match.league_id,
    v_match.season_id,
    p_match_id,
    v_user_id,
    p_predicted_team_id
  )
  ON CONFLICT (match_id, user_id)
  DO UPDATE SET
    predicted_team_id = EXCLUDED.predicted_team_id,
    updated_at = NOW();

  RETURN p_predicted_team_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_match_prediction(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_match_prediction(UUID, UUID) TO authenticated;

-- The newest-season standings gain the PP column. The return type changes, so
-- the function has to be dropped rather than replaced.
DROP FUNCTION IF EXISTS public.season_standings(UUID);

CREATE FUNCTION public.season_standings(p_league_id UUID)
RETURNS TABLE (
  team_id UUID,
  team_name TEXT,
  wins BIGINT,
  losses BIGINT,
  ko_diff BIGINT,
  prediction_points BIGINT
)
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
        AND NOT m.is_playoff
        AND m.status IN ('completed','forfeit') AND m.winner_team_id = t.id) AS wins,
    (SELECT COUNT(*)::BIGINT FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND NOT m.is_playoff
        AND m.status IN ('completed','forfeit')
        AND (m.winner_team_id IS NULL OR m.winner_team_id <> t.id)
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS losses,
    (SELECT COALESCE(SUM(CASE WHEN mr.winner_team_id = t.id THEN mr.pokemon_left_alive ELSE -mr.pokemon_left_alive END), 0)::BIGINT
      FROM public.match_results mr
      JOIN public.matches m ON m.id = mr.match_id
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND NOT m.is_playoff
        AND mr.pokemon_left_alive IS NOT NULL
        AND t.id IN (m.player_1_team_id, m.player_2_team_id))
    + (SELECT COUNT(*)::BIGINT * v_double_forfeit_diff
      FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND NOT m.is_playoff
        AND m.status IN ('completed','forfeit') AND m.winner_team_id IS NULL
        AND t.id IN (m.player_1_team_id, m.player_2_team_id))
    + (SELECT COUNT(*)::BIGINT * v_double_forfeit_diff
      FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND NOT m.is_playoff
        AND m.status = 'forfeit' AND m.winner_team_id IS NOT NULL
        AND m.winner_team_id <> t.id
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS ko_diff,
    (SELECT COUNT(*)::BIGINT
      FROM public.match_predictions mp
      JOIN public.matches m ON m.id = mp.match_id
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND mp.user_id = t.owner_user_id
        AND m.status IN ('completed','forfeit')
        AND m.winner_team_id IS NOT NULL
        AND mp.predicted_team_id = m.winner_team_id) AS prediction_points
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id
  ORDER BY wins DESC, losses ASC, ko_diff DESC, t.team_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.season_standings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.season_standings(UUID) TO authenticated;

-- The same standings for a named season, which the dashboard and schedule page
-- read so a past season keeps its own table. The return type changes, so this is
-- dropped and recreated for the new PP column.
DROP FUNCTION IF EXISTS public.season_standings_for(UUID, UUID);

CREATE FUNCTION public.season_standings_for(
  p_league_id UUID,
  p_season_id UUID
)
RETURNS TABLE (
  team_id UUID,
  team_name TEXT,
  wins BIGINT,
  losses BIGINT,
  ko_diff BIGINT,
  prediction_points BIGINT
)
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
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS ko_diff,
    (SELECT COUNT(*)::BIGINT
      FROM public.match_predictions mp
      JOIN public.matches m ON m.id = mp.match_id
      WHERE m.league_id = p_league_id AND m.season_id = p_season_id
        AND mp.user_id = t.owner_user_id
        AND m.status IN ('completed','forfeit')
        AND m.winner_team_id IS NOT NULL
        AND mp.predicted_team_id = m.winner_team_id) AS prediction_points
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = p_season_id
  ORDER BY wins DESC, losses ASC, ko_diff DESC, t.team_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.season_standings_for(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.season_standings_for(UUID, UUID) TO authenticated;
