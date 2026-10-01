-- Adds a denormalised league_id to match_scheduling_proposals and publishes the
-- draft tables to Realtime.
--
-- Two independent traffic problems are fixed here.
--
-- 1. match_scheduling_proposals had no league column, so the client could not
--    filter its subscription and every proposal event in the database was
--    delivered to every Schedule viewer. league_id is derived from the parent
--    match, which already carries it, so this is a pure denormalisation: it makes
--    the column filterable and indexable without changing any meaning.
--
-- 2. The draft page had no realtime signal at all, so it polled a full data load
--    every five seconds (12+ requests per tick) purely to learn that a pick had
--    been made. draft_picks and draft_round_settings are published instead, so a
--    pick propagates by event and the poll degrades to a slow safety net rather
--    than being the primary update path.
--
-- Everything here is additive. No column is dropped, no policy is tightened, and
-- the existing row-level security policies keep working unchanged: they already
-- resolve membership through league_members, and the new column agrees with them.

-- ---------------------------------------------------------------------------
-- 1. league_id on match_scheduling_proposals
-- ---------------------------------------------------------------------------

-- Nullable at first so the backfill below can run against existing rows, and so a
-- row can never be inserted without the column before it is enforced.
ALTER TABLE public.match_scheduling_proposals
  ADD COLUMN IF NOT EXISTS league_id UUID REFERENCES public.leagues(id) ON DELETE CASCADE;

-- Backfill from the parent match. Every existing proposal belongs to exactly one
-- match and every match has a league_id, so this covers the whole table. The
-- WHERE clause keeps the statement idempotent if it is ever re-run.
UPDATE public.match_scheduling_proposals p
SET league_id = m.league_id
FROM public.matches m
WHERE m.id = p.match_id
  AND p.league_id IS DISTINCT FROM m.league_id;

-- A proposal whose match has vanished cannot be attributed to a league. ON DELETE
-- CASCADE from matches means this should be empty, so check rather than assume:
-- a non-empty result means there is orphaned data to clean up by hand and the
-- migration should stop before NOT NULL hides it.
DO $$
DECLARE
  v_orphaned INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_orphaned
  FROM public.match_scheduling_proposals
  WHERE league_id IS NULL;

  IF v_orphaned > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce NOT NULL: % match_scheduling_proposals row(s) have no league_id because their match is missing.',
      v_orphaned;
  END IF;
END;
$$;

ALTER TABLE public.match_scheduling_proposals
  ALTER COLUMN league_id SET NOT NULL;

-- Serves the client's league filter and the owner history policy's league scoping.
CREATE INDEX IF NOT EXISTS match_scheduling_proposals_league_id_idx
  ON public.match_scheduling_proposals (league_id, created_at DESC);

-- Keeps the client subscription filter usable on the new column.
ALTER TABLE public.match_scheduling_proposals REPLICA IDENTITY FULL;

-- propose_match_time is the only writer that inserts a proposal. It already loads
-- the whole match row into v_match, so league_id is available without an extra
-- read; the column is set explicitly rather than left to a trigger so that a
-- proposal can never disagree with its own match.
CREATE OR REPLACE FUNCTION public.propose_match_time(
  p_match_id UUID,
  p_scheduled_at TIMESTAMPTZ,
  p_notes TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_my_team_id UUID;
  v_opponent_team_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to propose a match time.';
  END IF;

  IF p_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'Choose a date and time to propose.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  v_my_team_id := CASE
    WHEN v_match.player_1_team_id = (
      SELECT t.id FROM public.teams t
      WHERE t.owner_user_id = v_user_id
        AND t.season_id = v_match.season_id
        AND t.league_id = v_match.league_id
      LIMIT 1
    ) THEN v_match.player_1_team_id
    ELSE v_match.player_2_team_id
  END;

  IF v_my_team_id IS NULL THEN
    RAISE EXCEPTION 'You do not have a team in this match.';
  END IF;

  v_opponent_team_id := CASE
    WHEN v_match.player_1_team_id = v_my_team_id THEN v_match.player_2_team_id
    ELSE v_match.player_1_team_id
  END;

  -- Close whatever question was already open so the opponent always has exactly
  -- one thing to answer.
  UPDATE public.match_scheduling_proposals
  SET status = 'withdrawn', responded_at = NOW(), responded_by = v_user_id
  WHERE match_id = p_match_id
    AND status = 'pending';

  INSERT INTO public.match_scheduling_proposals (
    match_id, league_id, proposed_by, proposed_at, notes, status
  )
  VALUES (
    p_match_id, v_match.league_id, v_user_id, p_scheduled_at, NULLIF(p_notes, ''), 'pending'
  );

  -- The time is staged on the match so the card can show what is being proposed,
  -- but the status stays unscheduled until the opponent accepts.
  UPDATE public.matches
  SET scheduled_at = p_scheduled_at,
      notes = NULLIF(p_notes, ''),
      status = 'unscheduled',
      updated_at = NOW()
  WHERE id = p_match_id;

  PERFORM public.notify_match_actor(
    v_match.league_id, v_match.season_id, v_opponent_team_id, v_user_id,
    'match_proposed',
    'A match time was proposed for your upcoming match. Accept or decline it on the schedule page.',
    v_match.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.propose_match_time(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_match_time(UUID, TIMESTAMPTZ, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Realtime publication for the draft tables
-- ---------------------------------------------------------------------------

-- draft_picks is the signal that a pick has been made: it is written by manual
-- picks, by advance_bot_autopicks, and by resolve_draft_timeout, so one
-- subscription covers every way the draft can advance. It already carries
-- league_id, so the existing client filter applies with no change.
--
-- draft_priority_lists is published for the same reason and also carries league_id.
--
-- REPLICA IDENTITY FULL is required for a filtered UPDATE or DELETE to be
-- delivered, because the filter is evaluated against the changed row. INSERT
-- events would work without it, but the draft's flag writes are upserts.
ALTER TABLE public.draft_picks REPLICA IDENTITY FULL;
ALTER TABLE public.draft_priority_lists REPLICA IDENTITY FULL;

-- draft_round_settings is keyed by season and user with no league column, so it
-- cannot use the client's league filter. Its policy is already per-user
-- (a user reads only their own rows), so subscribing unfiltered leaks nothing
-- beyond what the subscriber could read directly; it is added so a member's own
-- round flags changing on another device is picked up. Added separately because
-- the client subscribes to it without a league filter.
ALTER TABLE public.draft_round_settings REPLICA IDENTITY FULL;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.draft_picks',
    'public.draft_priority_lists',
    'public.draft_round_settings'
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