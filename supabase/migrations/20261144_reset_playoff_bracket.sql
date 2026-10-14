-- Clears the playoff bracket so the owner can rebuild it.
--
-- Regenerating a bracket that already exists cannot work: generate_playoff_round only
-- creates a step when that round has no finished games, so a bracket with results in
-- it would have those games counted as the current round and the next call would
-- branch off the wrong survivors. Once a playoff game has been played the bracket has
-- to be cleared before it can be advanced again, which is what this does.
--
-- Deletes every playoff match for the season and empties the frozen seed list, so the
-- next generate call reseeds from the current standings. Reseeding rather than keeping
-- the old seeds is deliberate: a reset is almost always because the bracket was built
-- from the wrong teams, and silently reusing the old order would reproduce the same
-- mistake.
--
-- match_results rows are removed with their matches. The schema cascades them from
-- matches, so they cannot outlive the match they belong to and would otherwise be
-- orphaned.
--
-- This does not touch regular-season matches or any standings derived from them,
-- except that season_standings does not filter on is_playoff, so any playoff results
-- currently feeding the table disappear along with the matches. That is the correct
-- outcome for a reset, but it means a reset is not purely cosmetic and is guarded by
-- a confirmation in the UI.

CREATE OR REPLACE FUNCTION public.reset_playoff_bracket(p_league_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_removed INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to reset the playoff bracket.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can reset the playoff bracket.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  -- Any playoff game still carrying a result is a bracket mid-flight, which is
  -- exactly what a reset is for. Nothing here refuses: the owner asked for it.
  DELETE FROM public.matches
  WHERE league_id = p_league_id
    AND season_id = v_season_id
    AND is_playoff = TRUE;

  GET DIAGNOSTICS v_removed = ROW_COUNT;

  UPDATE public.league_settings
  SET playoff_state_json = '{}'::jsonb, updated_at = NOW()
  WHERE season_id = v_season_id;

  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_playoff_bracket(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_playoff_bracket(UUID) TO authenticated;