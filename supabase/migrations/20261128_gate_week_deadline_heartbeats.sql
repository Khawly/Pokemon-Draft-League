-- Stops week_deadline_heartbeats growing on every idle sweep.
--
-- advance_overdue_week_deadlines inserted one audit row per invocation,
-- unconditionally. The heartbeat in src/lib/supabase/week-deadline-heartbeat.ts
-- runs every 60 seconds for the lifetime of the app server, and the Schedule page
-- nudges the same sweep, so a league idling through a long season accrues tens of
-- thousands of rows that record the single fact that nothing happened.
--
-- This is the same problem 20261112 fixed for draft_sweep_heartbeats, applied to
-- the week deadline sweep that was missed. Only record a sweep that actually
-- advanced a league.
--
-- It also adds the index 20261112 gave the draft table. The table is append-only
-- and was queried newest-first, so the index turns "did anything happen
-- recently" into an index scan instead of a sort over the whole history.
--
-- Known trade-off, carried over from 20261112: liveness can no longer be proven
-- from this table while every deadline is idle. A sweep that failed silently
-- leaves no row either. That is the price of not logging a no-op every minute.

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

  -- Only record a sweep that advanced at least one league. See the header for
  -- why idle sweeps are no longer logged and what that means for liveness checks.
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

-- The leagues_advanced = 0 rows are exactly the history this stops writing, so
-- they are removed. Bounded to that single condition, on a table nothing reads.
DELETE FROM public.week_deadline_heartbeats
WHERE leagues_advanced = 0;

-- Append-only table queried newest-first: order by recency without a sort, and
-- support a cheap "did anything happen recently" probe.
CREATE INDEX IF NOT EXISTS week_deadline_heartbeats_invoked_at_idx
  ON public.week_deadline_heartbeats (invoked_at DESC);

-- Force PostgREST to pick up the new function bodies immediately.
NOTIFY pgrst, 'reload schema';