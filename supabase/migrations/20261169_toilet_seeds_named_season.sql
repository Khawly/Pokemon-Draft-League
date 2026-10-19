-- Seeds the Toilet Bowl from the named season's standings.
--
-- toilet_seeds already took a season for the frozen playoff seed list, but ordered the field
-- with season_standings(p_league_id), which resolves the league's newest season. For the
-- current season the two are the same and the bug was invisible; asking for an older one
-- ordered that season's non-playoff teams by the current season's results, and because team
-- ids differ between seasons it also treated every team as a non-playoff team. A four team
-- league asking about last season got a four team consolation bracket instead of a two team
-- one.
--
-- season_standings_for is the same ranking with the season supplied, so the current season
-- behaves exactly as before and a past season now ranks its own results.

/*
 * The teams that missed the playoff field, best record first.
 *
 * Read from the frozen playoff seeds rather than from the current standings, so the
 * consolation field cannot change under a bracket that is already being played. The
 * standings still decide the order, which is what seeds the bracket.
 *
 * @param p_league_id - The league the season belongs to.
 * @param p_season_id - The season to seed.
 * @param p_playoff_teams - The configured playoff field size (kept for signature stability).
 * @returns The non-playoff teams in seed order, or an empty array when nobody missed out.
 */
CREATE OR REPLACE FUNCTION public.toilet_seeds(
  p_league_id UUID,
  p_season_id UUID,
  p_playoff_teams INTEGER
) RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state JSONB;
  v_seeds UUID[] := ARRAY[]::UUID[];
  v_i INTEGER;
  v_toilet UUID[];
BEGIN
  SELECT COALESCE(playoff_state_json, '{}'::JSONB) INTO v_state
  FROM public.league_settings
  WHERE season_id = p_season_id;

  IF jsonb_typeof(v_state -> 'seeds') = 'array' THEN
    FOR v_i IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seeds := v_seeds || ARRAY[(v_state -> 'seeds' ->> v_i)::UUID]::UUID[];
    END LOOP;
  END IF;

  -- Nothing is frozen yet, so the playoff field is not decided and there is no field to
  -- leave anybody out of.
  IF array_length(v_seeds, 1) IS NULL THEN
    RETURN ARRAY[]::UUID[];
  END IF;

  SELECT ARRAY(
    SELECT st.team_id
    FROM public.season_standings_for(p_league_id, p_season_id) st
    WHERE NOT (st.team_id = ANY (v_seeds))
    ORDER BY st.wins DESC, st.losses ASC, st.ko_diff DESC, st.team_name ASC
  ) INTO v_toilet;

  RETURN COALESCE(v_toilet, ARRAY[]::UUID[]);
END;
$$;

REVOKE ALL ON FUNCTION public.toilet_seeds(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toilet_seeds(UUID, UUID, INTEGER) TO authenticated;
