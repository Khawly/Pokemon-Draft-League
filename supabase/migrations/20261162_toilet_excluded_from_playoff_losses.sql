-- Keeps the consolation bracket out of the playoff bracket's loss counts.
--
-- The Toilet Bowl is stored as playoff matches -- same table, same advance -- so every
-- count that reads "playoff losses" also picked up its results. That broke the final: the
-- grand final is played when exactly one team is on no losses and exactly one is on one,
-- and a toilet bowl team sitting on no losses made the first count two teams, so the final
-- was never created and the bracket stopped after the losers final.
--
-- The two brackets are separate competitions. A result in one says nothing about where a
-- team stands in the other, so every loss count and elimination test here is scoped to the
-- playoff brackets.

-- How many playoff games a team has lost.
--
-- A double forfeit counts as a loss for both sides, since the rule is that each takes one.
-- Toilet bowl games are excluded: they are a different bracket and a team can be in only
-- one of the two.
--
-- @returns The team's playoff losses, which is what decides elimination in the playoffs.
CREATE OR REPLACE FUNCTION public.playoff_side_losses(
  p_league_id UUID,
  p_season_id UUID,
  p_team UUID
) RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.bracket_phase IS DISTINCT FROM 'toilet'
    AND m.status IN ('completed', 'forfeit', 'cancelled')
    AND p_team IN (m.player_1_team_id, m.player_2_team_id)
    AND (m.winner_team_id IS NULL OR m.winner_team_id <> p_team);
$$;

-- True when a team's only double forfeit has already put it out of the playoff bracket.
--
-- Toilet bowl games are excluded for the same reason as above: losing a consolation game
-- is not losing a playoff game.
--
-- @returns True when the team is on the losing side of a playoff game nobody won.
CREATE OR REPLACE FUNCTION public.playoff_double_forfeited(
  p_league_id UUID,
  p_season_id UUID,
  p_team UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.matches m
    WHERE m.league_id = p_league_id
      AND m.season_id = p_season_id
      AND m.is_playoff
      AND m.bracket_phase IS DISTINCT FROM 'toilet'
      AND m.status IN ('completed', 'forfeit', 'cancelled')
      AND m.winner_team_id IS NULL
      AND p_team IN (m.player_1_team_id, m.player_2_team_id)
  );
$$;

-- The last team in the playoff bracket, if there is exactly one.
--
-- A team is out on two losses, or on one loss taken as a double forfeit, so this is the
-- only side still standing when exactly one team is left under that. It covers the endings
-- the finals do not reach: a bracket that never got a final because a double forfeit in the
-- winners bracket final took a loss off both finalists.
--
-- A team that only played in the toilet bowl is not in this bracket at all, so the "has
-- played" test is scoped to the playoff brackets too. Without that a consolation team on no
-- losses counted as still standing.
--
-- NULL when nobody or several teams qualify, which is the ordinary state of a tournament
-- still running.
CREATE OR REPLACE FUNCTION public.playoff_last_standing(
  p_league_id UUID,
  p_season_id UUID
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (array_agg(t.id))[1]
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND public.playoff_side_losses(p_league_id, p_season_id, t.id) < 2
    AND NOT public.playoff_double_forfeited(p_league_id, p_season_id, t.id)
    AND EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.league_id = p_league_id
        AND m.season_id = p_season_id
        AND m.is_playoff
        AND m.bracket_phase IS DISTINCT FROM 'toilet'
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)
    )
  HAVING COUNT(*) = 1;
$$;

REVOKE ALL ON FUNCTION public.playoff_side_losses(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_double_forfeited(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_last_standing(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_side_losses(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_double_forfeited(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_last_standing(UUID, UUID) TO authenticated;
-- The one team still on no losses in the playoff bracket, if there is exactly one.
--
-- The "has played" test is scoped to the playoff brackets. It was not, and a team that only
-- appeared in the toilet bowl counted as undefeated: the final is played when exactly one
-- team is on no losses and exactly one is on one, and a consolation team on no losses made
-- the first count two, so the final was never created.
--
-- @returns The undefeated team, or null when none or several qualify.
CREATE OR REPLACE FUNCTION public.playoff_undefeated(
  p_league_id UUID,
  p_season_id UUID
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (array_agg(t.id))[1]
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND public.playoff_side_losses(p_league_id, p_season_id, t.id) = 0
    AND EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.league_id = p_league_id
        AND m.season_id = p_season_id
        AND m.is_playoff
        AND m.bracket_phase IS DISTINCT FROM 'toilet'
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)
    )
  HAVING COUNT(*) = 1;
$$;

REVOKE ALL ON FUNCTION public.playoff_undefeated(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_undefeated(UUID, UUID) TO authenticated;
