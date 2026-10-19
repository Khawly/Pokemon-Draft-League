-- The reigning champion's member id and display name, for the whole app to read once.
--
-- Everything that renders a name needs to know whether to put a crown beside it, and most
-- of those places have a name but no member id. This returns both, so a surface with an id
-- can match exactly and a surface with only a name can still match.
--
-- Scoped to the league rather than to a season because the shell that provides this does not
-- know which season a page is showing; crowned_members already walks back to the most
-- recent decided season, which is the one whose winner is wearing the crown.
--
-- @returns One row when a champion exists, none otherwise.
CREATE OR REPLACE FUNCTION public.crowned_member_names(p_league_id UUID)
RETURNS TABLE (user_id UUID, display_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id UUID;
BEGIN
  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.user_id, p.display_name
  FROM public.crowned_members(p_league_id, v_season_id) c
  LEFT JOIN public.profiles p ON p.id = c.user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.crowned_member_names(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crowned_member_names(UUID) TO authenticated;