-- Raise Supabase role-level execution caps for the draft engine
--
-- Supabase sets tight per-role statement_timeout caps (anon 3s, authenticator
-- and authenticated 8s). PostgREST applies the cap to a whole RPC statement
-- when it arrives, and raising it mid-statement has no effect — so a draft
-- resolution that runs a busy bot chain gets canceled by the cap partway, the
-- transaction silently rolls back, and the draft appears hung (a heartbeat
-- sweep retries on the same locked rows until everything wedges). The engine
-- functions are bounded work (a handful of inserts per league), so a generous
-- 60s budget simply guarantees the pick commits instead of dying at an
-- arbitrary round boundary.

-- anon: the server heartbeat sweep runs under this role.
ALTER ROLE anon SET statement_timeout = '60000';
ALTER ROLE anon SET lock_timeout = '60000';

-- authenticator: PostgREST connects as this role, so its caps govern every
-- RPC the app and the server heartbeat issue.
ALTER ROLE authenticator SET statement_timeout = '60000';
ALTER ROLE authenticator SET lock_timeout = '60000';

-- authenticated: the browser's resolve/priority/board RPCs run under it.
ALTER ROLE authenticated SET statement_timeout = '60000';
ALTER ROLE authenticated SET lock_timeout = '60000';

-- service_role: server-side clients (admin flows) run under it.
ALTER ROLE service_role SET statement_timeout = '60000';
ALTER ROLE service_role SET lock_timeout = '60000';

-- Ask PostgREST to reload its schema/config so freshly-raised caps take effect
-- once existing pooled connections recycle.
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';