-- Keeps the champion's crown on until somebody else wins it.
--
-- It used to be the winner of the viewed season and of the season before, which meant the
-- title fell off after one year even if nobody had taken it from them. A crown is held until
-- it is won, not until a season ends, so this looks for the most recent season at or before
-- the one being viewed that actually produced a champion and crowns that winner.
--
-- "At or before" rather than simply the newest: a season still being played has no champion
-- yet, and the previous winner should still be wearing it. It also means looking back at an
-- older season shows the champion as they stood then, rather than somebody who won later.
--
-- Read from playoff_champion per season rather than from a stored flag, so it stays right if
-- a bracket is replayed or a result corrected before the season closes.
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
  v_reigning UUID;
  v_champion UUID;
BEGIN
  SELECT s.season_number INTO v_number
  FROM public.seasons s
  WHERE s.id = p_season_id;

  IF v_number IS NULL THEN
    RETURN;
  END IF;

  /*
   * Walk back from the season on screen to the most recent one that actually produced a
   * champion. A season still being played has none yet, and the previous winner should
   * still be wearing the crown during it.
   */
  FOR v_reigning IN
    SELECT s.id
    FROM public.seasons s
    WHERE s.league_id = p_league_id
      AND s.season_number <= v_number
    ORDER BY s.season_number DESC
  LOOP
    v_champion := public.playoff_champion(p_league_id, v_reigning);

    IF v_champion IS NOT NULL THEN
      RETURN QUERY
      SELECT t.owner_user_id
      FROM public.teams t
      WHERE t.league_id = p_league_id
        AND t.owner_user_id IS NOT NULL
        AND t.id = v_champion;

      RETURN;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.crowned_members(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crowned_members(UUID, UUID) TO authenticated;