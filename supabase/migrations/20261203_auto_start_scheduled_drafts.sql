-- Start drafts whose scheduled time has arrived.
--
-- The draft settings page stores an absolute draft_at instant. Until now that
-- value was only displayed: a league that scheduled its draft still needed the
-- owner to press Start Draft. This re-issues the server-side draft sweep so a
-- draft_pending season whose draft_at has passed is started automatically.
--
-- The sweep already runs every 15 seconds from the app server (see
-- src/lib/supabase/draft-heartbeat.ts), holds a single-writer advisory lock, and
-- steps into the league owner's identity per league. Auto-start reuses all three
-- properties: start_draft still performs its own validation (player slots, draft
-- positions, pool contents), and a league that is not ready yet is skipped and
-- retried on the next tick rather than started in a broken state.
--
-- Only the latest season of each league is considered, because start_draft
-- always operates on that season.

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
  v_started INTEGER := 0;
BEGIN
  -- Another process is already sweeping. Returning 0 is indistinguishable from
  -- an idle sweep and is the same answer the heartbeat already tolerates.
  IF NOT pg_try_advisory_xact_lock(814771001) THEN
    RETURN 0;
  END IF;

  -- A single sweep may run long when several leagues are due or a bot chain is
  -- running, so lift the role-level budget for this transaction.
  PERFORM set_config('statement_timeout', '60000', true);
  PERFORM set_config('lock_timeout', '45000', true);

  -- Scheduled drafts whose start time has arrived. The latest season is
  -- resolved first because start_draft ignores which settings row triggered it
  -- and always starts the league's newest season.
  FOR v_league_row IN
    SELECT l.id AS league_id,
           l.owner_id
    FROM public.leagues l
    JOIN LATERAL (
      SELECT s.id, s.status
      FROM public.seasons s
      WHERE s.league_id = l.id
      ORDER BY s.season_number DESC
      LIMIT 1
    ) latest ON TRUE
    JOIN public.league_settings ls
      ON ls.league_id = l.id
     AND ls.season_id = latest.id
    WHERE latest.status = 'draft_pending'
      AND ls.draft_at IS NOT NULL
      AND ls.draft_at <= NOW()
    ORDER BY ls.draft_at ASC
  LOOP
    BEGIN
      -- start_draft requires the caller to be the owner, so take that identity
      -- for this league. The notification it raises then excludes the owner,
      -- which is the same behaviour as the manual button.
      PERFORM set_config(
        'request.jwt.claims',
        json_build_object('sub', v_league_row.owner_id::text)::text,
        true
      );

      SELECT status INTO v_status
      FROM public.start_draft(v_league_row.league_id)
      LIMIT 1;

      IF COALESCE(v_status, '') = 'draft_active' THEN
        v_started := v_started + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Not ready yet (slots, draft positions, or pool incomplete), or a
      -- mid-state change. Leave the season pending and retry next sweep.
      NULL;
    END;
  END LOOP;

  -- Existing behaviour: advance every active, unpaused draft whose turn is due.
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

  -- Only record a sweep that did something. See 20261112 for why idle sweeps
  -- are no longer logged and what that means for liveness checks.
  IF v_advanced + v_started > 0 THEN
    INSERT INTO public.draft_sweep_heartbeats (leagues_advanced)
    VALUES (v_advanced + v_started);
  END IF;

  RETURN v_advanced + v_started;
END;
$$;

-- The sweep is a server-only operation. Re-assert the grant so a replace does
-- not leave a path back to anon or the browser roles.
REVOKE ALL ON FUNCTION public.advance_overdue_drafts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_overdue_drafts() TO service_role;

-- Force PostgREST to pick up the replaced function immediately.
NOTIFY pgrst, 'reload schema';
