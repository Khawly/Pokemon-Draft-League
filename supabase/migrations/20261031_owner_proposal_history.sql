-- Lets a league owner read every match-time proposal ever made in their league.
--
-- The participants' own view is unchanged: they still only read proposals on
-- matches they are in, and the History tab's proposal log is additionally gated
-- on ownership in the client. This migration only widens what the database will
-- hand back, and only to the owner.
--
-- No new table is needed. match_scheduling_proposals already keeps resolved rows:
-- responding moves `status` to accepted/declined/withdrawn and stamps
-- `responded_at`/`responded_by` rather than deleting the row, so the agreement
-- trail is the existing history. Only the read path is missing.
--
-- The policy has to reach the league through the match, because the table itself
-- carries no league_id; matches does, and matches is the same hop the participants
-- policy avoids by testing the match directly.

ALTER TABLE public.match_scheduling_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can read their league's match scheduling proposals" ON public.match_scheduling_proposals;

-- The owner reads the full negotiation history for matches in leagues they own,
-- including proposals for matches they are not a participant in. This is an
-- administrative read: it exposes when members agreed to play, which both of them
-- already knew, and it grants no write path, since every mutation still goes
-- through the SECURITY DEFINER RPCs that check participation.
CREATE POLICY "Owners can read their league's match scheduling proposals"
ON public.match_scheduling_proposals
FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.matches m
  JOIN public.leagues l ON l.id = m.league_id
  WHERE m.id = match_scheduling_proposals.match_id
    AND l.owner_id = auth.uid()
));

-- No new index is needed. The owner query resolves the league's match ids first
-- and then filters proposals by match_id, which the existing
-- match_scheduling_proposals_match_id_idx on (match_id, created_at DESC) already
-- serves for both the filter and the newest-first ordering.

-- Force PostgREST to pick up the new policy immediately.
NOTIFY pgrst, 'reload schema';
