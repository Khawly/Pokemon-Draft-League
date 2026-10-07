-- Stops the token budget being lowered below what a team has already spent.
--
-- Symptom: on a long draft the owner lowered total_token_salary partway through to
-- "even things out". Every remaining pick for every team was then auto-passed and
-- every roster finished short, with nothing on screen explaining why.
--
-- Cause: the resolver reads the budget live on every turn (20261125:203-209) and
-- derives v_remaining = budget - sum(draft_picks.cost_delta) for the team on the
-- clock (:209). Nothing checked the new budget against picks that had already
-- been made, so lowering it put teams into negative remaining, which trips two
-- things at once:
--
--   * the instant-due check at :347 sees v_remaining <= 0 and forces the turn to
--     resolve immediately, and
--   * the reserve clamp at :318 releases the reserve to 0, after which the pool
--     scan's affordability test rejects every candidate.
--
-- With nothing affordable, v_chosen stays NULL and resolve_draft_timeout records
-- a pass for every remaining pick in the season.
--
-- Fix: reject only the reduction that causes this. Raising the budget is always
-- safe and is sometimes exactly what a member needs, so it stays allowed, as does
-- turning costs on or off. The check is against the largest amount any single
-- team has already committed, so a budget that still covers what has been picked
-- can still be lowered.
--
-- The same hole exists on teams.total_salary_override when per-team salaries are
-- enabled, and is not covered here: that column is written by start_draft and by
-- update_league_member_salary rather than from the draft settings form, and the
-- member's new value is not even propagated to it mid-season. That is tracked
-- separately rather than folded in here.

-- Rejects lowering a season's token budget below the largest amount any single
-- team has already committed while that season's draft is running.
CREATE OR REPLACE FUNCTION public.guard_draft_salary_reduction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_max_committed BIGINT := 0;
BEGIN
  -- Only a genuine reduction of an existing budget is in scope. Turning costs on
  -- or off moves through NULL and raising is always safe.
  IF NEW.total_token_salary IS NULL
     OR OLD.total_token_salary IS NULL
     OR NEW.total_token_salary >= OLD.total_token_salary
  THEN
    RETURN NEW;
  END IF;

  SELECT s.status INTO v_status
  FROM public.seasons s
  WHERE s.id = NEW.season_id;

  IF v_status IS DISTINCT FROM 'draft_active' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(committed), 0) INTO v_max_committed
  FROM (
    SELECT SUM(d.cost_delta) AS committed
    FROM public.draft_picks d
    WHERE d.season_id = NEW.season_id
    GROUP BY d.team_id
  ) per_team;

  IF NEW.total_token_salary < v_max_committed THEN
    RAISE EXCEPTION
      'Cannot lower the token budget to % while the draft is running: teams have already committed up to % tokens. Raise the budget instead, or reset the draft first.',
      NEW.total_token_salary, v_max_committed;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS league_settings_guard_salary_reduction ON public.league_settings;
CREATE TRIGGER league_settings_guard_salary_reduction
BEFORE UPDATE OF total_token_salary ON public.league_settings
FOR EACH ROW
EXECUTE FUNCTION public.guard_draft_salary_reduction();

-- Force PostgREST to pick up the new function bodies immediately.
NOTIFY pgrst, 'reload schema';