-- Publishes the three tables whose changes a member can notice in real time.
--
-- Realtime is deliberately narrow. Everything else in this schema changes either
-- once at the draft or never (rosters, pool, teams, pools, rules), and putting
-- those on a channel would buy nothing while making every write broadcast to
-- every connected client.
--
-- What is published:
--   matches                     - status and the agreed time changing, and the
--                                 weekly-deadline sweep settling a week
--   notifications               - the nav badge, including match-time events
--   match_scheduling_proposals  - a time being proposed, answered, or withdrawn
--
-- REPLICA IDENTITY FULL lets the realtime filter match on a non-key column.
-- `matches` and `notifications` are both filtered by `league_id` so a client only
-- hears about its own league. These tables are small (a season's fixtures, a
-- member's notification history), so carrying the full row costs nothing.
--
-- The app does not react to individual events: an event only marks the data
-- stale and triggers a scoped refetch, coalesced by the client. That is what
-- keeps a sweep that writes a whole week of matches from turning into a burst of
-- renders.

ALTER TABLE public.matches REPLICA IDENTITY FULL;
ALTER TABLE public.notifications REPLICA IDENTITY FULL;
ALTER TABLE public.match_scheduling_proposals REPLICA IDENTITY FULL;

-- Membership is a no-op if the publication or table is already present, which
-- keeps this migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END;
$$;

-- Adding a table that is already in the publication raises an error, so each
-- membership is checked first.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.matches',
    'public.notifications',
    'public.match_scheduling_proposals'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables p
      WHERE p.pubname = 'supabase_realtime'
        AND p.schemaname || '.' || p.tablename = v_table
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE %s',
        v_table
      );
    END IF;
  END LOOP;
END;
$$;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
