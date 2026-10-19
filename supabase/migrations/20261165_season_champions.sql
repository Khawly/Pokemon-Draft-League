-- Every season's champion, for the Hall of Fame.
--
-- One row per season that has produced a champion, in season order. A season still being
-- played has none and is skipped, so the hall grows as titles are decided rather than
-- listing empty seasons.
--
-- The champion is read from playoff_champion per season, which is the same function the
-- crown and the bracket use. Reading it here rather than from a stored column means a
-- replayed bracket or a corrected result is reflected without anything needing to be
-- backfilled.
--
-- The owner's presentation fields are joined here because the hall shows the member rather
-- than the team: a champion who later changed teams still won the title.
--
-- @returns One row per decided season, oldest first.
CREATE OR REPLACE FUNCTION public.season_champions(p_league_id UUID)
RETURNS TABLE (
  season_number INTEGER,
  season_name TEXT,
  team_id UUID,
  team_name TEXT,
  owner_user_id UUID,
  display_name TEXT,
  avatar_url TEXT,
  name_color TEXT,
  avatar_initials TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season RECORD;
  v_champion UUID;
BEGIN
  FOR v_season IN
    SELECT s.id, s.season_number, s.name
    FROM public.seasons s
    WHERE s.league_id = p_league_id
    ORDER BY s.season_number
  LOOP
    v_champion := public.playoff_champion(p_league_id, v_season.id);

    CONTINUE WHEN v_champion IS NULL;

    season_number := v_season.season_number;
    season_name := v_season.name;

    SELECT
      t.id,
      t.team_name,
      t.owner_user_id,
      p.display_name,
      p.avatar_url,
      p.name_color,
      p.avatar_initials
    INTO
      team_id,
      team_name,
      owner_user_id,
      display_name,
      avatar_url,
      name_color,
      avatar_initials
    FROM public.teams t
    LEFT JOIN public.profiles p ON p.id = t.owner_user_id
    WHERE t.id = v_champion;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.season_champions(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.season_champions(UUID) TO authenticated;