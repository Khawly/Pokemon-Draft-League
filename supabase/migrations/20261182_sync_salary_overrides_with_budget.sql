-- Keep per-team token overrides in step with the league-wide budget
--
-- Symptom: the owner set Total Token Salary to 10 on Draft Settings, but the
-- draft board, teams page, and Members Settings all kept showing 33.
--
-- Cause: teams.total_salary_override and league_members.total_token_salary are
-- snapshots. start_draft copies the member value onto the team row (20261019),
-- and the Members page writes both through update_league_member_salary, but
-- nothing re-syncs them when the league-wide default in league_settings changes.
-- Every salary read path prefers the team override when
-- allow_per_team_salary is on, so a team that never had a custom budget keeps
-- quoting the number the league had when that snapshot was taken.
--
-- Fix: cascade a change of the league default onto the members and current-season
-- teams that were still sitting on the previous default. A value that matches
-- neither the old nor the new default is a deliberate per-team override and is
-- left alone. Only the settings row's own season is rewritten, so a past season's
-- budgets stay as they were played.
--
-- One exception: while every member still holds the same number, nobody has
-- actually differentiated their budget, so the whole league follows the new
-- default. That also repairs the case this migration was written for, where the
-- stored 33 was the default from *before* the previous 33 -> 10 change and so
-- matched neither the current default nor the one being replaced. As soon as one
-- member holds a different number, the per-member rule above takes over again.

-- Cascades a league_settings.total_token_salary change onto the members and
-- current-season team rows that still hold the previous league-wide value.
CREATE OR REPLACE FUNCTION public.sync_salary_overrides_on_budget_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_varied BOOLEAN;
BEGIN
  -- Turning costs off (NULL) or saving the same number has nothing to cascade.
  IF NEW.total_token_salary IS NULL
     OR NEW.total_token_salary IS NOT DISTINCT FROM OLD.total_token_salary
  THEN
    RETURN NEW;
  END IF;

  -- True once at least one active member holds a different number from the
  -- others, i.e. the league has a real per-team budget. COUNT(DISTINCT) ignores
  -- NULLs, so an untouched league reads as uniform.
  SELECT COUNT(DISTINCT lm.total_token_salary) > 1 INTO v_varied
  FROM public.league_members lm
  WHERE lm.league_id = NEW.league_id
    AND lm.is_active IS TRUE;

  -- Members carry the league-wide value between seasons; move the ones that
  -- never customised it. IS NOT DISTINCT FROM also covers the NULL -> number
  -- case when costs are switched on for the first time.
  UPDATE public.league_members lm
  SET total_token_salary = NEW.total_token_salary
  WHERE lm.league_id = NEW.league_id
    AND (
      lm.total_token_salary IS NULL
      OR lm.total_token_salary IS NOT DISTINCT FROM OLD.total_token_salary
      OR NOT v_varied
    );

  -- The season being edited is the one whose board quotes the budget. Other
  -- seasons keep their own team rows untouched so completed seasons stay
  -- read-only in practice.
  UPDATE public.teams t
  SET total_salary_override = NEW.total_token_salary
  WHERE t.league_id = NEW.league_id
    AND t.season_id = NEW.season_id
    AND (
      t.total_salary_override IS NULL
      OR t.total_salary_override IS NOT DISTINCT FROM OLD.total_token_salary
      OR NOT v_varied
    );

  RETURN NEW;
END;
$$;

-- Fires after the draft-settings upsert lands, so the cascade and the setting it
-- came from commit together and no page can observe a half-applied budget.
DROP TRIGGER IF EXISTS league_settings_sync_salary_overrides
  ON public.league_settings;
CREATE TRIGGER league_settings_sync_salary_overrides
AFTER UPDATE OF total_token_salary ON public.league_settings
FOR EACH ROW
EXECUTE FUNCTION public.sync_salary_overrides_on_budget_change();
