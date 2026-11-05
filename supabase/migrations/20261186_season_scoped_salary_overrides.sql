-- Keep per-team token salaries scoped to the season being edited
--
-- Symptom: season 1's teams showed season 2's salaries (10/11) instead of the
-- 33 configured on season 1.
--
-- Cause: update_league_member_salary mirrored a member's salary onto every team
-- row that member owned in the league, across all seasons. Editing season 2
-- therefore overwrote the completed season's per-team overrides.
--
-- Fix: the Members Settings page now reads the selected season's team overrides
-- and writes them through update_team_salary_for_season, which only touches that
-- season. The old RPC is kept for any client still on the previous build, but it
-- now limits its mirror to the newest season instead of every season.
--
-- The repair at the end clears past-season overrides that exactly match the
-- current league-wide member salary while differing from that season's own
-- league default: that is the fingerprint of the overwrite, and leaves genuine
-- custom values that do not match it alone.

-- Season-scoped salary write used by the Members Settings page.
CREATE OR REPLACE FUNCTION public.update_team_salary_for_season(
  p_league_id UUID,
  p_season_id UUID,
  p_user_id UUID,
  p_total_token_salary INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_current_season BOOLEAN;
BEGIN
  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can update team token salaries.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.seasons s
    WHERE s.id = p_season_id AND s.league_id = p_league_id
  ) THEN
    RAISE EXCEPTION 'That season does not belong to this league.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.league_settings ls
    WHERE ls.season_id = p_season_id
      AND ls.allow_per_team_salary = TRUE
  ) THEN
    RAISE EXCEPTION 'Per-team token salaries are not enabled for that season.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = p_league_id
      AND lm.user_id = p_user_id
      AND lm.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'This league has no active member with that user id.';
  END IF;

  IF p_total_token_salary IS NULL OR p_total_token_salary < 0 THEN
    RAISE EXCEPTION 'Total token salary must be a non-negative whole number.';
  END IF;

  UPDATE public.teams t
  SET total_salary_override = p_total_token_salary
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND t.owner_user_id = p_user_id;

  /*
   * league_members.total_token_salary is the template the next season copies
   * from. Only the current season may update it; editing a past season must not
   * change what a future draft starts with.
   */
  SELECT s.id = (
    SELECT s2.id FROM public.seasons s2
    WHERE s2.league_id = p_league_id
    ORDER BY s2.season_number DESC
    LIMIT 1
  )
  INTO v_is_current_season
  FROM public.seasons s
  WHERE s.id = p_season_id;

  IF v_is_current_season THEN
    UPDATE public.league_members lm
    SET total_token_salary = p_total_token_salary
    WHERE lm.league_id = p_league_id
      AND lm.user_id = p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_team_salary_for_season(UUID, UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_team_salary_for_season(UUID, UUID, UUID, INTEGER) TO authenticated;

-- Existing callers keep working, but old clients can no longer touch a season
-- other than the newest through this function.
CREATE OR REPLACE FUNCTION public.update_league_member_salary(
  p_league_id UUID,
  p_user_id UUID,
  p_total_token_salary INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_active_member BOOLEAN;
BEGIN
  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can update member token salaries.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.league_settings ls
    WHERE ls.league_id = p_league_id
      AND ls.allow_per_team_salary = TRUE
  ) THEN
    RAISE EXCEPTION 'Per-team token salaries are not enabled for this league.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = p_league_id
      AND lm.user_id = p_user_id
      AND lm.is_active = TRUE
  ) INTO v_is_active_member;

  IF NOT v_is_active_member THEN
    RAISE EXCEPTION 'This league has no active member with that user id.';
  END IF;

  IF p_total_token_salary IS NULL OR p_total_token_salary < 0 THEN
    RAISE EXCEPTION 'Total token salary must be a non-negative whole number.';
  END IF;

  UPDATE public.league_members lm
  SET total_token_salary = p_total_token_salary
  WHERE lm.league_id = p_league_id
    AND lm.user_id = p_user_id;

  UPDATE public.teams t
  SET total_salary_override = p_total_token_salary
  WHERE t.league_id = p_league_id
    AND t.owner_user_id = p_user_id
    AND t.season_id = (
      SELECT s.id FROM public.seasons s
      WHERE s.league_id = p_league_id
      ORDER BY s.season_number DESC
      LIMIT 1
    );
END;
$$;

REVOKE ALL ON FUNCTION public.update_league_member_salary(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_league_member_salary(UUID, UUID, INTEGER) TO authenticated;

-- Repair completed seasons whose overrides were replaced by the league-wide
-- member salary. The newest season is left alone because that is the season the
-- global value legitimately describes today.
UPDATE public.teams t
SET total_salary_override = NULL
FROM public.seasons s
WHERE t.season_id = s.id
  AND s.id <> (
    SELECT s2.id FROM public.seasons s2
    WHERE s2.league_id = s.league_id
    ORDER BY s2.season_number DESC
    LIMIT 1
  )
  AND t.total_salary_override IS NOT NULL
  AND t.total_salary_override = (
    SELECT lm.total_token_salary
    FROM public.league_members lm
    WHERE lm.league_id = t.league_id
      AND lm.user_id = t.owner_user_id
  )
  AND EXISTS (
    SELECT 1 FROM public.league_settings ls
    WHERE ls.season_id = s.id
      AND ls.total_token_salary IS DISTINCT FROM t.total_salary_override
  );

NOTIFY pgrst, 'reload schema';
