-- Security hardening follow-up: remaining internal RPC grants
--
-- The first hardening migration (20261199) closed the draft engine and the
-- notification writers, but the Supabase advisors still showed SECURITY DEFINER
-- functions reachable from the browser. Most are intentional client RPCs or
-- read-only policy helpers. The rest are internal write paths that were only ever
-- meant to be called by another SECURITY DEFINER function, and several have no
-- caller check at all because they assumed the grant boundary would keep them
-- private:
--
--   reject_trade, complete_trade, recompute_match_status,
--   advance_league_week_deadline, award_weekly_allowance, archive_season_pools,
--   and the playoff_* / toilet_* bracket writers.
--
-- This migration:
--   1. revokes EXECUTE from anon on every public SECURITY DEFINER function
--      except the public invite lookup and the read-only policy helpers that an
--      anonymous policy evaluation may still call,
--   2. revokes EXECUTE from anon and authenticated on the internal write helpers,
--      which remain callable from the SECURITY DEFINER functions that own those
--      flows (those run as the owner),
--   3. sets a fixed search_path on the four functions the advisor flagged.
--
-- The revokes are idempotent, and the DO loops simply do nothing when a name is
-- absent, so the migration is safe to re-run.

-- ------------------------------------------------------- anon: only the invite page

-- Revoke the anonymous grant from every public SECURITY DEFINER RPC. The invite
-- page needs get_league_invite_info before sign-in; the remaining exceptions are
-- read-only predicates that a policy evaluated for an anonymous caller could
-- invoke. None of the exceptions can write.
DO $$
DECLARE
  v_function RECORD;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prosecdef
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND p.proname NOT IN (
        'get_league_invite_info',
        'is_active_league_member',
        'is_league_owner',
        'is_league_staff',
        'can_view_trade',
        'is_match_participant',
        'is_trade_party'
      )
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM anon',
      v_function.signature
    );
  END LOOP;
END;
$$;

-- ------------------------------------------- internal write helpers: both roles

-- These functions write rosters, trades, brackets, salary rows, or match state,
-- and are only reached from another SECURITY DEFINER function. Revoke them from
-- both browser roles so PostgREST cannot call them at all; the owning definer
-- functions keep working because they run as the function owner.
DO $$
DECLARE
  v_name TEXT;
  v_function RECORD;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'advance_league_week_deadline',
    'archive_season_pools',
    'award_weekly_allowance',
    'complete_trade',
    'reject_trade',
    'recompute_match_status',
    'playoff_advance',
    'playoff_advance_12',
    'playoff_settle_pending_byes',
    'playoff_insert_game',
    'playoff_reset_due',
    'playoff_game_resolved',
    'playoff_feeder_team',
    'playoff_wb_first_losers',
    'toilet_advance',
    'toilet_feeder_team',
    'toilet_game_resolved',
    'toilet_seeds'
  ]
  LOOP
    FOR v_function IN
      SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = v_name
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated',
        v_function.signature
      );
    END LOOP;
  END LOOP;
END;
$$;

-- ------------------------------------------------------- mutable search paths

-- These trigger functions had no SET search_path, so a caller-controlled
-- search_path could change how an unqualified name resolves. Pin it to public,
-- matching the rest of the schema's SECURITY DEFINER functions.
ALTER FUNCTION public.classify_transaction_source() SET search_path = public;
ALTER FUNCTION public.handle_new_user() SET search_path = public;
ALTER FUNCTION public.matches_default_unscheduled() SET search_path = public;
ALTER FUNCTION public.update_updated_at() SET search_path = public;

-- Force PostgREST to pick up the grant changes immediately.
NOTIFY pgrst, 'reload schema';

-- Regression check after applying. Expect no rows for the internal writers:
--
--   SELECT p.proname
--   FROM pg_proc p
--   WHERE p.pronamespace = 'public'::regnamespace
--     AND p.proname IN (
--       'reject_trade', 'complete_trade', 'recompute_match_status',
--       'advance_league_week_deadline', 'award_weekly_allowance',
--       'archive_season_pools', 'playoff_advance', 'toilet_advance'
--     )
--     AND (
--       has_function_privilege('anon', p.oid, 'EXECUTE')
--       OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     );
