-- Makes the Rules page (spec section 13) writable and readable
--
-- rules_documents has existed since the initial schema with RLS enabled and no
-- policies at all, so nothing in the app could read or write it: a member had no
-- way to see the league's rules and the owner had no way to set them. This adds
-- the two access paths the page needs.
--
-- Reads go through a policy so the client can fetch the row directly. Writes go
-- through an RPC, because the spec's own rule is that the browser is never the
-- source of truth for anything affecting league integrity: who may author the
-- rules is decided by the league's owner_id, not by whatever the caller claims.

-- One rules document per season.
--
-- save_league_rules upserts on this key, and without it the upsert would have had
-- no conflict target. Collapses any duplicates first, keeping the most recently
-- updated row, because the page only ever shows one document.
DELETE FROM public.rules_documents a
USING public.rules_documents b
WHERE a.season_id = b.season_id
  AND a.id <> b.id
  AND (a.updated_at, a.id) < (b.updated_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS rules_documents_league_season_uk
  ON public.rules_documents (league_id, season_id);

-- Members may read their own league's rules; nobody may insert, update, or delete
-- directly. Both writes go through save_league_rules.
--
-- Scoped to the latest season so a member cannot read a previous season's rules
-- through this route; the spec describes the rules as a property of the current
-- season. Ordering by season_number and taking the newest mirrors how every other
-- page in the app resolves a season.
DROP POLICY IF EXISTS "Members can view their league rules" ON public.rules_documents;

CREATE POLICY "Members can view their league rules"
  ON public.rules_documents
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_league_member(league_id)
    AND season_id = (
      SELECT s.id
      FROM public.seasons s
      WHERE s.league_id = rules_documents.league_id
      ORDER BY s.season_number DESC
      LIMIT 1
    )
  );

-- Saves the league's rules for its current season, creating the document the first
-- time and replacing it thereafter.
--
-- Owner-only, matching the spec ("Show league rules created by the Owner"). Writes
-- are SECURITY DEFINER so the ownership test cannot be bypassed by calling the
-- table directly, which the RLS above forbids anyway.
--
-- Blank content is stored as NULL rather than an empty string so "no rules set"
-- stays distinguishable from "set to nothing", and the page can say so.
--
-- @param p_league_id - The league whose rules are being written.
-- @param p_content  - The rules text, or NULL/blank to clear them.
-- @returns The saved document's id and updated_at.
CREATE OR REPLACE FUNCTION public.save_league_rules(
  p_league_id UUID,
  p_content TEXT
)
RETURNS TABLE (id UUID, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_owner_id UUID;
  v_body TEXT := NULLIF(BTRIM(COALESCE(p_content, '')), '');
  v_doc_id UUID;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to edit the league rules.';
  END IF;

  SELECT l.owner_id INTO v_owner_id
  FROM public.leagues l
  WHERE l.id = p_league_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'That league does not exist.';
  END IF;

  IF v_owner_id <> v_user_id THEN
    RAISE EXCEPTION 'Only the league owner can edit the rules.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no season to attach rules to.';
  END IF;

  INSERT INTO public.rules_documents (league_id, season_id, created_by, content)
  VALUES (p_league_id, v_season_id, v_user_id, v_body)
  ON CONFLICT (league_id, season_id) DO UPDATE
    SET content = EXCLUDED.content,
        created_by = EXCLUDED.created_by
    -- The BEFORE UPDATE trigger already stamps updated_at, but it only fires on
    -- UPDATE, so an insert would otherwise report the row's creation time as its
    -- last edit. Stamped here too so the returned value is true either way.
    RETURNING rules_documents.id, NOW() INTO v_doc_id, v_updated_at;

  RETURN QUERY SELECT v_doc_id, v_updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.save_league_rules(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_league_rules(UUID, TEXT) TO authenticated;

-- Force PostgREST to pick up the new policy and function immediately.
NOTIFY pgrst, 'reload schema';