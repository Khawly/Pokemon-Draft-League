-- Draft heartbeat sweep audit trail
--
-- Adds a lightweight audit table recording every invocation of the
-- advance_overdue_drafts sweep (timestamp + how many drafts were advanced) so
-- we can tell whether the app-server heartbeat is actually reaching the DB,
-- versus a draft that is stuck because nothing is invoking the sweep. The
-- function body is otherwise unchanged.

-- Audit trail for advance_overdue_drafts invocations.
CREATE TABLE IF NOT EXISTS public.draft_sweep_heartbeats (
  -- Surrogate key.
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- When the sweep ran.
  invoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- How many drafts had their turn advanced by that sweep.
  leagues_advanced INTEGER NOT NULL DEFAULT 0
);

-- Recreates advance_overdue_drafts with one audit row written per invocation.
--
-- @returns The number of drafts whose turn was actually resolved.
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

  INSERT INTO public.draft_sweep_heartbeats (leagues_advanced)
  VALUES (v_advanced);

  RETURN v_advanced;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_overdue_drafts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_overdue_drafts() TO anon;