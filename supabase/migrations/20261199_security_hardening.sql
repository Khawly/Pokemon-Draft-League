-- Security hardening: internal RPC grants, membership inserts, and RLS gaps
--
-- Root cause addressed here: Supabase grants EXECUTE on new functions in the
-- public schema to anon and authenticated by default. The earlier migrations
-- revoked those helpers from PUBLIC, which does not remove the explicit anon /
-- authenticated grants (the same behavior documented in
-- 20261179_revoke_anon_on_admin_functions.sql). Several browser-reachable
-- helpers therefore stayed callable from PostgREST even though they were meant
-- to be internal.
--
-- This migration:
--   1. removes browser EXECUTE from the internal draft and notification
--      helpers (they still work when called from other SECURITY DEFINER
--      functions and triggers, which run as the owner),
--   2. drops the pre-invite league_members INSERT policy so joining a league
--      can only happen through join_league_by_invite (invite, expiry, and
--      player-cap checks) and role changes only through the owner RPCs,
--   3. locks down the reference and audit tables: RLS is enabled and the
--      browser roles lose the default table grants, keeping anonymous callers
--      from rewriting the type chart or spamming the heartbeat audit rows.
--
-- All statements are idempotent: REVOKE and DROP POLICY IF EXISTS are no-ops
-- when already applied, and ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a
-- no-op when RLS is already on.

-- ---------------------------------------------------------------- internal RPCs

-- Commits a draft pick and mirrors it into the roster and ledger. It trusts its
-- arguments and is only ever called by make_draft_pick, resolve_draft_timeout,
-- and advance_bot_autopicks, so it must never be reachable over PostgREST.
REVOKE EXECUTE ON FUNCTION public.insert_draft_pick(
  UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated;

-- advance_bot_autopicks is deliberately left granted to authenticated: an earlier
-- migration grants it on purpose, it only settles a bot's already-determined
-- turn, and no client path in this tree relies on it. Revoking it would be a
-- behavior change without a matching security win.

-- Notification writers take the recipient, actor, type, and message from their
-- arguments, so exposing them lets a caller forge or spam notifications. They
-- are only called by the trade, scheduling, and league-event RPCs/triggers.
REVOKE EXECUTE ON FUNCTION public.notify_trade_user(
  UUID, UUID, UUID, UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.notify_trade_approvers(
  UUID, UUID, UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.notify_match_actor(
  UUID, UUID, UUID, UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.notify_league_members(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID[]
) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------- league membership joins

-- The pre-invite self-insert policy only checked user_id, so any signed-in user
-- could add themselves to any league they knew the id of, bypassing the invite
-- token, its expiry, and the player cap. It also allowed choosing role =
-- 'admin', which unlocks staff-only trade and matchup actions. Joining now goes
-- exclusively through join_league_by_invite (SECURITY DEFINER), and role
-- changes through the owner RPCs.
DROP POLICY IF EXISTS "Users can insert their own league membership"
  ON public.league_members;

-- ------------------------------------------------ reference and audit tables

-- Type effectiveness reference data. The hosted project already has RLS on this
-- table (with no policy), but its default grants still existed, so an operator
-- disabling RLS would silently reopen writes. Revoking the browser roles makes
-- the lock explicit. Only the SECURITY DEFINER draft engine reads it; there is
-- no client read or write path.
ALTER TABLE public.type_chart ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.type_chart FROM anon, authenticated;

-- Heartbeat audit rows are written only by the service-role sweeps and the
-- SECURITY DEFINER functions. Nothing in the app reads them, so they are closed
-- to the browser roles entirely; the definer functions continue to write as the
-- table owner.
ALTER TABLE public.draft_sweep_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.draft_sweep_heartbeats FROM anon, authenticated;

ALTER TABLE public.week_deadline_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.week_deadline_heartbeats FROM anon, authenticated;

-- Force PostgREST to pick up the grant, policy, and RLS changes immediately.
NOTIFY pgrst, 'reload schema';

-- Regression check after applying (expect both helper rows to be false):
--
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute
--   FROM pg_proc p
--   WHERE p.pronamespace = 'public'::regnamespace
--     AND p.proname IN (
--       'insert_draft_pick',
--       'notify_league_members'
--     );
--
-- And confirm the membership policy is gone (expect zero rows):
--
--   SELECT policyname
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename = 'league_members'
--     AND cmd = 'INSERT';
