-- Finds the members who should wear the champion crown for a season's view.
--
-- The crown is the playoff winner's, and it lasts the season they won and the whole of the
-- following season: a title you have just won should still be on you when the next season
-- starts, and then it comes off.
--
-- It follows the member rather than the team. A champion who changes teams the next season
-- still won the title, and moving the crown to whoever inherits the roster would credit the
-- wrong person.
--
-- Read from playoff_champion per season rather than from a stored flag, so it stays right
-- if a bracket is replayed or a result is corrected before the season closes.
CREATE OR REPLACE FUNCTION public.crowned_members(
  p_league_id UUID,
  p_season_id UUID
) RETURNS TABLE (user_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number INTEGER;
  v_previous_id UUID;
  v_current_champion UUID;
  v_previous_champion UUID;
BEGIN
  SELECT s.season_number INTO v_number
  FROM public.seasons s
  WHERE s.id = p_season_id;

  IF v_number IS NULL THEN
    RETURN;
  END IF;

  SELECT s.id INTO v_previous_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
    AND s.season_number < v_number
  ORDER BY s.season_number DESC
  LIMIT 1;

  v_current_champion := public.playoff_champion(p_league_id, p_season_id);

  IF v_previous_id IS NOT NULL THEN
    v_previous_champion := public.playoff_champion(p_league_id, v_previous_id);
  END IF;

  RETURN QUERY
  SELECT DISTINCT t.owner_user_id
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.owner_user_id IS NOT NULL
    AND (
      t.id = v_current_champion
      OR t.id = v_previous_champion
    );
END;
$$;

REVOKE ALL ON FUNCTION public.crowned_members(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crowned_members(UUID, UUID) TO authenticated;