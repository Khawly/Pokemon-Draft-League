-- Weekly token allowances and total token salary edit history
--
-- Two related league-owner tools:
--
--   1. Weekly Allowance: a per-season setting that credits every team one token
--      for each week that closes. A week closes either when the recurring weekly
--      deadline passes or when its last match is settled, whichever happens
--      first, and the credit is written once per team per week.
--
--   2. Total token salary edit history: records every change made through the
--      Members Settings salary editor so an owner can see what a budget used to
--      be, who changed it, and when.
--
-- The allowance is written as a negative `transactions` row, because every
-- salary read and every budget guard already sums that ledger. That makes the
-- credit spendable everywhere without changing the draft, pickup, trade, or
-- team-page accounting.

-- -------- league setting --------

-- Opt-in per season. Off by default so existing leagues do not start granting
-- tokens until the owner asks for it.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS weekly_allowance_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- -------- salary edit history --------

-- One recorded change to a member's total token salary for a season. The
-- previous value is nullable because a member may start with no override and
-- inherit the league default. Team-level rows are not recorded separately: the
-- RPC updates every team the member owns in the season with the same value.
CREATE TABLE IF NOT EXISTS public.member_salary_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  previous_salary INTEGER,
  new_salary INTEGER NOT NULL CHECK (new_salary >= 0),
  changed_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The Members Settings page reads one season's history newest first.
CREATE INDEX IF NOT EXISTS member_salary_edits_season_created_idx
  ON public.member_salary_edits (season_id, created_at DESC);

ALTER TABLE public.member_salary_edits ENABLE ROW LEVEL SECURITY;

-- Any active member of the league may read the history; only the salary RPC
-- below writes to it, so there are deliberately no write policies.
DROP POLICY IF EXISTS "League members can view salary edit history"
  ON public.member_salary_edits;
CREATE POLICY "League members can view salary edit history"
ON public.member_salary_edits
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

GRANT SELECT ON public.member_salary_edits TO authenticated;

-- Re-issue the season-scoped salary write with history recording. Behaviour is
-- unchanged; the previous effective salary is captured before the update, and a
-- row is only written when the value actually changes.
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
  v_previous_salary INTEGER;
  v_has_team BOOLEAN;
  v_changed_by UUID := auth.uid();
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

  -- What the page shows today: the season override when one is set, otherwise
  -- the season's league default.
  SELECT t.total_salary_override INTO v_previous_salary
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND t.owner_user_id = p_user_id
  ORDER BY t.id
  LIMIT 1;

  v_has_team := FOUND;

  IF v_previous_salary IS NULL THEN
    SELECT ls.total_token_salary INTO v_previous_salary
    FROM public.league_settings ls
    WHERE ls.season_id = p_season_id;
  END IF;

  IF (v_has_team OR v_is_current_season)
     AND v_previous_salary IS DISTINCT FROM p_total_token_salary THEN
    INSERT INTO public.member_salary_edits (
      league_id,
      season_id,
      user_id,
      previous_salary,
      new_salary,
      changed_by
    )
    VALUES (
      p_league_id,
      p_season_id,
      p_user_id,
      v_previous_salary,
      p_total_token_salary,
      v_changed_by
    );
  END IF;

  UPDATE public.teams t
  SET total_salary_override = p_total_token_salary
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND t.owner_user_id = p_user_id;

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

-- The legacy league-wide salary RPC is kept for stale clients, but now records
-- history as well. It still only touches the newest season.
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
  v_season_id UUID;
  v_previous_salary INTEGER;
  v_changed_by UUID := auth.uid();
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

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  SELECT t.total_salary_override INTO v_previous_salary
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = v_season_id
    AND t.owner_user_id = p_user_id
  ORDER BY t.id
  LIMIT 1;

  IF v_previous_salary IS NULL THEN
    SELECT ls.total_token_salary INTO v_previous_salary
    FROM public.league_settings ls
    WHERE ls.season_id = v_season_id;
  END IF;

  IF v_season_id IS NOT NULL
     AND v_previous_salary IS DISTINCT FROM p_total_token_salary THEN
    INSERT INTO public.member_salary_edits (
      league_id,
      season_id,
      user_id,
      previous_salary,
      new_salary,
      changed_by
    )
    VALUES (
      p_league_id,
      v_season_id,
      p_user_id,
      v_previous_salary,
      p_total_token_salary,
      v_changed_by
    );
  END IF;

  UPDATE public.league_members lm
  SET total_token_salary = p_total_token_salary
  WHERE lm.league_id = p_league_id
    AND lm.user_id = p_user_id;

  UPDATE public.teams t
  SET total_salary_override = p_total_token_salary
  WHERE t.league_id = p_league_id
    AND t.owner_user_id = p_user_id
    AND t.season_id = v_season_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_league_member_salary(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_league_member_salary(UUID, UUID, INTEGER) TO authenticated;

-- -------- weekly allowance ledger --------

-- One credit per team per closing week. The unique key is what makes the award
-- idempotent when both triggers (the last match settling and the week pointer
-- advancing) fire for the same week.
CREATE TABLE IF NOT EXISTS public.weekly_allowance_awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_number INTEGER NOT NULL CHECK (week_number > 0),
  amount INTEGER NOT NULL DEFAULT 1 CHECK (amount > 0),
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('deadline', 'week_complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, week_number, team_id)
);

-- The member-facing ledger and the settings page both read recent awards.
CREATE INDEX IF NOT EXISTS weekly_allowance_awards_season_created_idx
  ON public.weekly_allowance_awards (season_id, created_at DESC);

ALTER TABLE public.weekly_allowance_awards ENABLE ROW LEVEL SECURITY;

-- Members can see allowances granted in their league. Writes are trigger-only.
DROP POLICY IF EXISTS "League members can view weekly allowances"
  ON public.weekly_allowance_awards;
CREATE POLICY "League members can view weekly allowances"
ON public.weekly_allowance_awards
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

GRANT SELECT ON public.weekly_allowance_awards TO authenticated;

-- Widens the ledger vocabulary with a pure token credit. `pokemon_id` is already
-- nullable (token trades opened that door), so an allowance row carries no fake
-- species and the existing salary sums pick the credit up unchanged.
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_action_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_action_check
  CHECK (action IN (
    'added',
    'dropped',
    'trade_in',
    'trade_out',
    'token_transfer',
    'weekly_allowance'
  ));

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_source_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_source_check
  CHECK (source IN (
    'draft_pick',
    'free_agent_pickup',
    'trade',
    'release',
    'weekly_allowance'
  ));

-- Credits one token to every team in the season for a closing week, once.
--
-- @param p_league_id - League whose setting gates the award.
-- @param p_season_id - Season the closing week belongs to.
-- @param p_week_number - The week that closed.
-- @param p_trigger - 'deadline' or 'week_complete', for the audit row.
-- @returns How many teams were credited on this call.
CREATE OR REPLACE FUNCTION public.award_weekly_allowance(
  p_league_id UUID,
  p_season_id UUID,
  p_week_number INTEGER,
  p_trigger TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_team RECORD;
  v_awarded INTEGER := 0;
  v_inserted INTEGER;
BEGIN
  SELECT COALESCE(ls.weekly_allowance_enabled, FALSE)
  INTO v_enabled
  FROM public.league_settings ls
  WHERE ls.league_id = p_league_id
    AND ls.season_id = p_season_id;

  IF NOT COALESCE(v_enabled, FALSE) OR COALESCE(p_week_number, 0) < 1 THEN
    RETURN 0;
  END IF;

  FOR v_team IN
    SELECT t.id, t.owner_user_id
    FROM public.teams t
    WHERE t.league_id = p_league_id
      AND t.season_id = p_season_id
  LOOP
    INSERT INTO public.weekly_allowance_awards (
      league_id,
      season_id,
      team_id,
      user_id,
      week_number,
      amount,
      trigger_source
    )
    VALUES (
      p_league_id,
      p_season_id,
      v_team.id,
      v_team.owner_user_id,
      p_week_number,
      1,
      CASE WHEN p_trigger = 'deadline' THEN 'deadline' ELSE 'week_complete' END
    )
    ON CONFLICT (season_id, week_number, team_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted > 0 THEN
      INSERT INTO public.transactions (
        league_id,
        season_id,
        user_id,
        team_id,
        pokemon_id,
        action,
        quantity,
        cost_delta,
        note,
        source
      )
      VALUES (
        p_league_id,
        p_season_id,
        v_team.owner_user_id,
        v_team.id,
        NULL,
        'weekly_allowance',
        1,
        -1,
        'Weekly allowance for week ' || p_week_number,
        'weekly_allowance'
      );

      v_awarded := v_awarded + 1;
    END IF;
  END LOOP;

  RETURN v_awarded;
END;
$$;

REVOKE ALL ON FUNCTION public.award_weekly_allowance(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;

-- Awards the week as soon as its last non-playoff match is settled. Every
-- settlement path (member report, owner report, forfeit, double forfeit) ends by
-- updating the match status, so one trigger covers them all.
CREATE OR REPLACE FUNCTION public.award_allowance_on_week_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_playoff THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('completed', 'forfeit', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.season_id = NEW.season_id
      AND m.week_number = NEW.week_number
      AND NOT m.is_playoff
      AND m.status NOT IN ('completed', 'forfeit', 'cancelled')
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.award_weekly_allowance(
    NEW.league_id,
    NEW.season_id,
    NEW.week_number,
    'week_complete'
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.award_allowance_on_week_complete() FROM PUBLIC;

DROP TRIGGER IF EXISTS matches_award_week_allowance ON public.matches;

CREATE TRIGGER matches_award_week_allowance
AFTER INSERT OR UPDATE OF status, winner_team_id ON public.matches
FOR EACH ROW
EXECUTE FUNCTION public.award_allowance_on_week_complete();

-- Awards the closing week when the week pointer advances, which is how the
-- deadline and the manual Progress week button close a week whose matches were
-- not all reported. The unique key makes this a no-op when the last match
-- already triggered the award.
CREATE OR REPLACE FUNCTION public.award_allowance_on_week_advance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_closed_week INTEGER := OLD.current_week;
BEGIN
  IF NOT NEW.weekly_allowance_enabled THEN
    RETURN NEW;
  END IF;

  IF v_closed_week IS NULL OR v_closed_week < 1 THEN
    RETURN NEW;
  END IF;

  IF (
    NEW.current_week IS DISTINCT FROM OLD.current_week
    AND NEW.current_week > OLD.current_week
  ) OR (
    OLD.regular_season_completed_at IS NULL
    AND NEW.regular_season_completed_at IS NOT NULL
  ) THEN
    PERFORM public.award_weekly_allowance(
      NEW.league_id,
      NEW.season_id,
      v_closed_week,
      'deadline'
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.award_allowance_on_week_advance() FROM PUBLIC;

DROP TRIGGER IF EXISTS league_settings_award_week_allowance
  ON public.league_settings;

CREATE TRIGGER league_settings_award_week_allowance
AFTER UPDATE OF current_week, regular_season_completed_at ON public.league_settings
FOR EACH ROW
EXECUTE FUNCTION public.award_allowance_on_week_advance();

-- Owner-only RPC behind the "Weekly Allowance" checkbox. Enabling it mid-week
-- also awards the current week immediately when every match in that week is
-- already settled, so turning it on does not wait for another match to move.
CREATE OR REPLACE FUNCTION public.set_weekly_allowance(
  p_league_id UUID,
  p_enabled BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_current_week INTEGER;
  v_has_matches BOOLEAN;
  v_has_unfinished BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to change the weekly allowance.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can change the weekly allowance.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  INSERT INTO public.league_settings (league_id, season_id, updated_at)
  VALUES (p_league_id, v_season_id, NOW())
  ON CONFLICT (league_id, season_id) DO NOTHING;

  UPDATE public.league_settings
  SET weekly_allowance_enabled = COALESCE(p_enabled, FALSE),
      updated_at = NOW()
  WHERE league_id = p_league_id
    AND season_id = v_season_id;

  IF NOT COALESCE(p_enabled, FALSE) THEN
    RETURN;
  END IF;

  SELECT ls.current_week INTO v_current_week
  FROM public.league_settings ls
  WHERE ls.league_id = p_league_id
    AND ls.season_id = v_season_id;

  IF COALESCE(v_current_week, 0) < 1 THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.season_id = v_season_id
      AND m.week_number = v_current_week
      AND NOT m.is_playoff
  ) INTO v_has_matches;

  SELECT EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.season_id = v_season_id
      AND m.week_number = v_current_week
      AND NOT m.is_playoff
      AND m.status NOT IN ('completed', 'forfeit', 'cancelled')
  ) INTO v_has_unfinished;

  IF v_has_matches AND NOT v_has_unfinished THEN
    PERFORM public.award_weekly_allowance(
      p_league_id,
      v_season_id,
      v_current_week,
      'week_complete'
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_weekly_allowance(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_weekly_allowance(UUID, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
