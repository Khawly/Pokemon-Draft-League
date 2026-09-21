-- Server-side draft resolution heartbeat
--
-- Resolves the current turn of every active, unpaused draft whose turn is due
-- by the engine's own rules (the pick timer expired, or the on-clock player's
-- Auto/Skip round flag is armed). Up to now the pick-flow has relied on a
-- browser firing resolve_draft_timeout when the timer reaches zero; a client
-- that is asleep, unloaded, or clock-skewed leaves the draft wedged at 0:00
-- forever. The app's server calls this sweep on a heartbeat, playing the role
-- of the missing browser so an overdue turn always advances.
--
-- Security: SECURITY DEFINER (runs as the table owner). Callable by anon
-- strictly via RPC because the server heartbeat uses the public anon key. It
-- never advances a turn that is not already due: resolve_draft_timeout(FALSE)
-- returns 'not_due' for a normal human turn still inside its pick window, so
-- no one can use this to rush a pick. Per league it steps into the league
-- owner's identity (request.jwt.claims) purely so the engine's membership
-- checks pass; leagues that error are skipped and retried by the next tick.

-- Advances every due turn across all active drafts.
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

  RETURN v_advanced;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_overdue_drafts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_overdue_drafts() TO anon;