-- Permission hardening for the public API surface.
--
-- The audit found three least-privilege gaps:
--
--   1. resolve_draft_timeout(p_league_id, p_force) was executable by any signed-in
--      member. p_force exists for the bot chain and the server sweep, but exposing
--      it let a member force another player's pick timer to expire. The browser
--      only ever calls it with force = false, so a force-free wrapper is granted
--      to authenticated and the internal function is closed.
--   2. Trigger and internal helper functions carried the platform's default
--      EXECUTE grants for anon/authenticated. Most return trigger and cannot be
--      reached through PostgREST, but ensure_testbot_autopick_flags and the pure
--      helpers do not need browser access at all.
--   3. Every public table carried the platform default ALL grant for anon and
--      authenticated, including TRUNCATE. RLS gates DML, but RLS does not gate
--      TRUNCATE, and this app has no anonymous table reads: the only pre-login
--      surface is the invite lookup RPC.
--
-- RLS itself is unchanged. Every public table still has RLS enabled, and the
-- authenticated grants used by the pages (via PostgREST under RLS) are kept.

-- --------------------------------------------------- draft timeout wrapper

-- Browser-facing resolver. Always resolves only a turn that is already due; the
-- force path stays inside the definer functions that legitimately need it.
CREATE OR REPLACE FUNCTION public.resolve_draft_turn(p_league_id UUID)
RETURNS TABLE (season_id UUID, status TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.resolve_draft_timeout(p_league_id, FALSE);
$$;

REVOKE ALL ON FUNCTION public.resolve_draft_turn(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_draft_turn(UUID) TO authenticated;

-- Force is for advance_bot_autopicks and the server sweep only. Both run as the
-- table owner through SECURITY DEFINER, so no browser grant is needed.
REVOKE ALL ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) TO service_role;

-- ------------------------------------------- internal functions off the API

-- Trigger functions. They are invoked by the table they are attached to and are
-- never called through PostgREST.
REVOKE ALL ON FUNCTION public.award_allowance_on_week_advance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_allowance_on_week_complete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.classify_transaction_source() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_free_agency_deadline() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_trade_deadline() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_draft_salary_reduction() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.matches_default_unscheduled() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_free_agency_move() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_trade_completed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.on_league_settings_round_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.on_season_testbot_autopick_flags() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_salary_overrides_on_budget_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_updated_at() FROM PUBLIC, anon, authenticated;

-- Internal helpers called from definer functions, never by a page.
REVOKE ALL ON FUNCTION public.draft_quiet_hours(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_testbot_autopick_flags(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_test_bot_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.playoff_next_power_of_two(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pokemon_weaknesses(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shuffle_uuid_array(UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.team_salary_totals(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trade_approver_ids(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.week_deadline_instant(DATE, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------- anonymous function access

-- Only the invite lookup runs before the member has a session. Every other
-- public function keeps its explicit authenticated grant where one exists.
DO $$
DECLARE
  v_function REGPROCEDURE;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname <> 'get_league_invite_info'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', v_function);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_league_invite_info(TEXT) TO anon;

-- ------------------------------------------------------ anonymous table access

-- The pre-login surface is the invite RPC, which runs as its definer. No public
-- table needs an anonymous grant. TRUNCATE/TRIGGER/REFERENCES are also removed
-- from authenticated: PostgREST never issues them, and RLS does not gate
-- TRUNCATE.
DO $$
DECLARE
  v_table REGCLASS;
BEGIN
  FOR v_table IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm')
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM anon, authenticated',
      v_table
    );
    EXECUTE format('REVOKE ALL ON TABLE %s FROM anon', v_table);
  END LOOP;
END;
$$;

-- Keep future migrations from reintroducing the same three grants. Authenticated
-- keeps DML so RLS-backed reads and writes continue to work; anon gets nothing
-- by default and must be granted explicitly if a new pre-login surface appears.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

NOTIFY pgrst, 'reload schema';
