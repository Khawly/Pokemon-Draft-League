-- Invite links + Draftboard prerequisites
--
-- Adds:
--   - league_invites table (shareable join tokens)
--   - teams integrity indexes (unique draft positions, one team per member)
--   - SECURITY DEFINER RPCs: create_league_invite, get_league_invite_info,
--     join_league_by_invite, start_draft
--
-- All business-critical rules (ownership checks, checklist validation) are
-- enforced inside the database, not trusted from the client.

-- Shareable join tokens for a league; tokens are UNIQUE so they can be used as
-- lookup keys, and expires_at limits the token's lifetime.
CREATE TABLE IF NOT EXISTS public.league_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Speeds up lookups of all invites belonging to a league.
CREATE INDEX IF NOT EXISTS league_invites_league_id_idx
ON public.league_invites (league_id);

ALTER TABLE public.league_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their league invites" ON public.league_invites;
DROP POLICY IF EXISTS "Owners can create league invites" ON public.league_invites;
DROP POLICY IF EXISTS "Owners can delete league invites" ON public.league_invites;

CREATE POLICY "Members can view their league invites"
ON public.league_invites
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = league_invites.league_id
      AND lm.user_id = auth.uid()
      AND lm.is_active = TRUE
  )
);

CREATE POLICY "Owners can create league invites"
ON public.league_invites
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = league_invites.league_id AND l.owner_id = auth.uid()
  )
);

CREATE POLICY "Owners can delete league invites"
ON public.league_invites
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = league_invites.league_id AND l.owner_id = auth.uid()
  )
);

-- A draft position can only be used once per league season.
DROP INDEX IF EXISTS teams_league_season_draft_position_uk;
CREATE UNIQUE INDEX teams_league_season_draft_position_uk
ON public.teams (league_id, season_id, draft_position)
WHERE draft_position IS NOT NULL;

-- Each member can only hold one team slot per league season.
DROP INDEX IF EXISTS teams_league_season_owner_uk;
CREATE UNIQUE INDEX teams_league_season_owner_uk
ON public.teams (league_id, season_id, owner_user_id);

-- SECURITY DEFINER RPC that issues a random 64-char token invite that expires
-- in 30 days. Only the league owner may create invites; both the sign-in check
-- and the ownership check are enforced inside the function. Returns the new
-- token, league id, and expiry.
CREATE OR REPLACE FUNCTION public.create_league_invite(
  p_league_id UUID
)
RETURNS TABLE (token TEXT, league_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_token TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to create an invite link.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can create invite links.';
  END IF;

  v_token := replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.league_invites (league_id, token, created_by, expires_at)
  VALUES (p_league_id, v_token, v_user_id, NOW() + INTERVAL '30 days');

  RETURN QUERY
  SELECT i.token, i.league_id, i.expires_at
  FROM public.league_invites i
  WHERE i.token = v_token;
END;
$$;

-- SECURITY DEFINER RPC that returns public metadata about an invite token --
-- the league id, league name, active member count, and expiry status -- for
-- the join screen, without exposing the league to arbitrary viewers.
CREATE OR REPLACE FUNCTION public.get_league_invite_info(
  p_token TEXT
)
RETURNS TABLE (league_id UUID, league_name TEXT, member_count BIGINT, is_expired BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT li.league_id,
         l.name AS league_name,
         (SELECT COUNT(*)::BIGINT FROM public.league_members lm
          WHERE lm.league_id = li.league_id AND lm.is_active = TRUE) AS member_count,
         (li.expires_at IS NOT NULL AND li.expires_at < NOW()) AS is_expired
  FROM public.league_invites li
  JOIN public.leagues l ON l.id = li.league_id
  WHERE li.token = p_token
  LIMIT 1;
END;
$$;

-- SECURITY DEFINER RPC that adds the signed-in user as an active member of the
-- league referenced by a token. Validates sign-in, token validity and expiry,
-- existing membership, and the league's player cap before inserting; on
-- conflict re-activates a prior membership. Returns the joined league.
CREATE OR REPLACE FUNCTION public.join_league_by_invite(
  p_token TEXT
)
RETURNS TABLE (league_id UUID, league_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_league_id UUID;
  v_league_name TEXT;
  v_member_count INTEGER;
  v_max_players INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to join a league.';
  END IF;

  SELECT li.league_id, l.name, l.number_of_players
    INTO v_league_id, v_league_name, v_max_players
  FROM public.league_invites li
  JOIN public.leagues l ON l.id = li.league_id
  WHERE li.token = p_token
  LIMIT 1;

  IF v_league_id IS NULL THEN
    RAISE EXCEPTION 'This invite link is invalid or has been revoked.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.league_invites li
    WHERE li.token = p_token AND li.expires_at IS NOT NULL AND li.expires_at < NOW()
  ) THEN
    RAISE EXCEPTION 'This invite link has expired.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = v_league_id AND lm.user_id = v_user_id AND lm.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'You are already a member of this league.';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_member_count
  FROM public.league_members lm
  WHERE lm.league_id = v_league_id AND lm.is_active = TRUE;

  IF v_member_count >= v_max_players THEN
    RAISE EXCEPTION 'This league already has the maximum number of players.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, is_active)
  VALUES (v_league_id, v_user_id, 'member', TRUE)
  ON CONFLICT (league_id, user_id)
  DO UPDATE SET is_active = TRUE, joined_at = NOW();

  RETURN QUERY SELECT v_league_id, v_league_name;
END;
$$;

-- SECURITY DEFINER RPC that transitions the latest season of a league into
-- draft_active. Only the league owner may call it; the function then enforces
-- the full pre-draft checklist: a season exists and is not already active or
-- complete, every team slot is filled, every team has a draft_position, and the
-- draft pool contains at least one in-pool Pokémon.
CREATE OR REPLACE FUNCTION public.start_draft(
  p_league_id UUID
)
RETURNS TABLE (season_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_status TEXT;
  v_max_players INTEGER;
  v_team_count INTEGER;
  v_assigned_count INTEGER;
  v_pool_pokemon_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to start the draft.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can start the draft.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season exists for this league.';
  END IF;

  IF v_status = 'draft_active' THEN
    RAISE EXCEPTION 'The draft has already started.';
  END IF;

  IF v_status IN ('draft_complete', 'archived') THEN
    RAISE EXCEPTION 'The draft for this season is already complete.';
  END IF;

  SELECT l.number_of_players INTO v_max_players
  FROM public.leagues l
  WHERE l.id = p_league_id;

  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  IF v_team_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: fill all team slots first (% of % filled).',
      v_team_count,
      v_max_players;
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_assigned_count
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = v_season_id
    AND t.draft_position IS NOT NULL;

  IF v_assigned_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: assign a draft position to every team (%).',
      v_assigned_count;
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_pool_pokemon_count
  FROM public.draft_pools dp
  JOIN public.draft_pool_pokemon dpp ON dpp.draft_pool_id = dp.id
  WHERE dp.league_id = p_league_id
    AND dp.season_id = v_season_id
    AND dpp.is_in_pool = TRUE;

  IF v_pool_pokemon_count <= 0 THEN
    RAISE EXCEPTION 'Draft cannot start: the draft pool has no in-pool Pokémon yet.';
  END IF;

  UPDATE public.seasons
  SET status = 'draft_active', draft_started_at = NOW()
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;