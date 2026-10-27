-- Single-writer guard for the time-based sweeps
--
-- advance_overdue_drafts and advance_overdue_week_deadlines are invoked by
-- process heartbeats (and, for the week sweep, by the Schedule page). On a
-- horizontally scaled Node deployment, or several serverless instances, every
-- process can call the same sweep at the same time. The sweeps are logically
-- idempotent, but duplicate invocations still do the work twice: the draft sweep
-- walks every active draft and calls resolve_draft_timeout, and the week sweep
-- walks every league with a deadline enabled.
--
-- A transaction-scoped advisory lock makes the sweep single-writer. The first
-- caller takes the lock and does the work; concurrent callers fail the
-- non-blocking acquisition and return 0 immediately. The lock releases when the
-- RPC's transaction commits or rolls back, so a crashed sweep cannot leave the
-- league permanently locked.
--
-- The lock keys are arbitrary but must stay stable across deployments:
--   draft sweep = 814771001
--   week sweep  = 814771002
--
-- No eligibility rules, resolution logic, audit writes, return values, or grants
-- change. Only the entry guard is added.

CREATE OR REPLACE FUNCTION public.advance_overdue_drafts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league_row RECORD;
  v_status TEXT;
  v_advanced INTEGER := 0;
BEGIN
  -- Another process is already sweeping. Returning 0 is indistinguishable from
  -- an idle sweep and is the same answer the heartbeat already tolerates.
  IF NOT pg_try_advisory_xact_lock(814771001) THEN
    RETURN 0;
  END IF;

  -- PostgREST caps anon RPCs at 3s (authenticator 8s); a single sweep may
  -- take longer when several leagues are due or a bot chain is running, so
  -- lift the budget for this transaction.
  PERFORM set_config('statement_timeout', '60000', true);
  PERFORM set_config('lock_timeout', '45000', true);

  FOR v_league_row IN
    SELECT l.id AS league_id,
           s.id AS season_id,
           l.owner_id
    FROM public.seasons s
    JOIN public.leagues l ON l.id = s.league_id
    WHERE s.status = 'draft_active'
      AND s.draft_paused_at IS NULL
    ORDER BY s.season_number DESC
  LOOP
    BEGIN
      -- The engine's membership gate reads auth.uid(); step into the league
      -- owner's role for this league so is_active_league_member passes.
      PERFORM set_config(
        'request.jwt.claims',
        json_build_object('sub', v_league_row.owner_id::text)::text,
        false
      );

      SELECT status INTO v_status
      FROM public.resolve_draft_timeout(v_league_row.league_id, FALSE)
      LIMIT 1;

      IF COALESCE(v_status, '') <> 'not_due' THEN
        v_advanced := v_advanced + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Unresolvable league (owner not an active member, mid-state change):
      -- skip it, the next heartbeat will retry.
      NULL;
    END;
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', false);

  -- Only record a sweep that resolved at least one turn. See 20261112 for why
  -- idle sweeps are no longer logged and what that means for liveness checks.
  IF v_advanced > 0 THEN
    INSERT INTO public.draft_sweep_heartbeats (leagues_advanced)
    VALUES (v_advanced);
  END IF;

  RETURN v_advanced;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_overdue_drafts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_overdue_drafts() TO anon;

CREATE OR REPLACE FUNCTION public.advance_overdue_week_deadlines()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league_row RECORD;
  v_status TEXT;
  v_advanced INTEGER := 0;
BEGIN
  -- Single-writer guard; see the draft sweep above.
  IF NOT pg_try_advisory_xact_lock(814771002) THEN
    RETURN 0;
  END IF;

  FOR v_league_row IN
    SELECT ls.league_id, l.owner_id
    FROM public.league_settings ls
    JOIN public.seasons s ON s.id = ls.season_id
    JOIN public.leagues l ON l.id = ls.league_id
    WHERE ls.week_deadline_enabled
      AND NOT ls.week_deadline_paused
      AND s.status <> 'archived'
    GROUP BY ls.league_id, l.owner_id
  LOOP
    BEGIN
      -- The bracket seed and membership checks read auth.uid(); step into the
      -- league owner's role for this league. The claim is transaction-scoped so
      -- each iteration replaces the previous league's identity instead of
      -- being shadowed by it.
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_league_row.owner_id::text)::text, true);

      v_status := public.advance_league_week_deadline(v_league_row.league_id, v_league_row.owner_id, FALSE);

      IF v_status IN ('advanced','playoffs_started','playoffs_pending') THEN
        v_advanced := v_advanced + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Unresolvable league (owner no longer an active member, mid-state
      -- change): skip it, the next heartbeat will retry.
      NULL;
    END;
  END LOOP;

  -- Only record a sweep that advanced at least one league. See 20261128 for why
  -- idle sweeps are no longer logged and what that means for liveness checks.
  IF v_advanced > 0 THEN
    INSERT INTO public.week_deadline_heartbeats (leagues_advanced)
    VALUES (v_advanced);
  END IF;

  RETURN v_advanced;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_overdue_week_deadlines() FROM PUBLIC;
-- anon covers the app-server heartbeat; authenticated covers the Schedule
-- page's nudge, which PostgREST runs as the signed-in user's role.
GRANT EXECUTE ON FUNCTION public.advance_overdue_week_deadlines() TO anon, authenticated;

-- Force PostgREST to pick up the replaced function bodies immediately.
NOTIFY pgrst, 'reload schema';
