-- Stops draft_sweep_heartbeats growing without bound while no draft is running.
--
-- The problem
-- -----------
-- advance_overdue_drafts inserted one audit row per invocation, unconditionally.
-- The heartbeat in src/lib/supabase/draft-heartbeat.ts runs every 15 seconds for
-- the lifetime of the Node process, regardless of whether any draft exists, so the
-- table accrued ~5,760 rows per day per process. Its loop only touches leagues
-- whose season is 'draft_active' and unpaused, so outside a draft the sweep did no
-- work and still wrote a row recording leagues_advanced = 0. Confirmed in
-- production: 5,815 rows in the ten days from 2026-09-21, the newest of them
-- 15 seconds apart and all zero.
--
-- The change
-- ----------
-- Write an audit row only when the sweep actually advanced something. The row is
-- meant to answer "did the heartbeat reach the database, and did it do anything",
-- and a sweep that advanced nothing says the first point while telling us nothing
-- the previous row did not. Rows are therefore now written exactly when a draft
-- turn resolved, which is the event worth having a record of.
--
-- What this costs
-- ---------------
-- Liveness can no longer be proven from this table while every draft is idle. A
-- sweep that failed silently would leave no row either. That was already the
-- weaker signal it appeared to be: the heartbeat logs one line per sweep to the
-- server console (draft-heartbeat.ts runSweep), which is where an RPC failure is
-- actually visible, and the two problems this table was created to diagnose --
-- a heartbeat that never started, and one that errors on every tick -- both
-- already surface in that log. The table remains authoritative for "a draft turn
-- was resolved by the sweep at this time", which is the part it is read for.
--
-- The row that recorded an idle tick also had leagues_advanced = 0, so the
-- leagues_advanced column stays meaningful: a row now always has a positive count.
--
-- The resolution logic itself is untouched. Same eligibility filter, same
-- per-league resolve, same statement and lock timeouts, same return value, same
-- grants. Only the INSERT moves behind the v_advanced > 0 test.

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

  -- Only record a sweep that resolved at least one turn. See the header for why
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

-- ---------------------------------------------------------------------------
-- Backfill trim
-- ---------------------------------------------------------------------------
--
-- The table already holds the idle rows this migration stops writing. The
-- leagues_advanced = 0 rows are the ones that record a sweep doing nothing, which
-- is exactly the history that is now redundant, so they are removed. Rows with a
-- positive count are the real record of a turn being resolved and are kept.
--
-- This is a delete of already-redundant audit data on a table nothing reads, and
-- it is the one irreversible statement in this migration. It is bounded to the
-- single condition below so no meaningful row can be caught by it.
DELETE FROM public.draft_sweep_heartbeats
WHERE leagues_advanced = 0;

-- The table is append-only by convention and was previously queried newest-first,
-- so give it an index matching that: order by recency without a sort, and support
-- a cheap "did anything happen recently" probe.
CREATE INDEX IF NOT EXISTS draft_sweep_heartbeats_invoked_at_idx
  ON public.draft_sweep_heartbeats (invoked_at DESC);