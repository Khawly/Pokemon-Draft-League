-- Creates an empty team for a member as soon as they join a league.
--
-- Teams used to be minted only by start_draft. Until then a league showed no
-- teams at all, so the teams page had nothing for its members and the owner
-- could not place free agents on a team before the draft (the pickup RPC
-- resolves a team row first). Create the team for the newest season while it is
-- still draft_pending, and backfill teams for members who joined before this
-- migration.
--
-- The draft itself is untouched: start_draft still refreshes each team's draft
-- position from league_members and inserts only the teams that are missing.

-- Backfill: every active member of a league whose newest season has not started
-- yet gets an empty team if they do not already have one.
INSERT INTO public.teams (
  league_id, season_id, owner_user_id, team_name, draft_position
)
SELECT
  lm.league_id,
  s.id,
  lm.user_id,
  COALESCE(p.display_name, 'Player ' || substr(lm.user_id::text, 1, 8)),
  lm.draft_position
FROM public.league_members lm
JOIN public.seasons s ON s.league_id = lm.league_id
LEFT JOIN public.profiles p ON p.id = lm.user_id
WHERE lm.is_active = TRUE
  AND s.status = 'draft_pending'
  AND s.season_number = (
    SELECT MAX(s2.season_number)
    FROM public.seasons s2
    WHERE s2.league_id = lm.league_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.teams t
    WHERE t.league_id = lm.league_id
      AND t.season_id = s.id
      AND t.owner_user_id = lm.user_id
  );

-- Re-issued league creation (same 32-character name limit as 20261189) with the
-- owner's empty team created alongside the first season.
CREATE OR REPLACE FUNCTION public.create_league_for_user(
  p_name TEXT,
  p_number_of_players INTEGER
)
RETURNS TABLE (
  league_id UUID,
  season_id UUID,
  league_name TEXT,
  number_of_players INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_league_id UUID;
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to create a league.';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'League name is required.';
  END IF;

  IF char_length(btrim(p_name)) > 32 THEN
    RAISE EXCEPTION 'League name must be 32 characters or fewer.';
  END IF;

  IF p_number_of_players IS NULL OR p_number_of_players <= 0 THEN
    RAISE EXCEPTION 'Number of players must be a positive whole number.';
  END IF;

  INSERT INTO public.leagues (name, owner_id, number_of_players, is_active)
  VALUES (btrim(p_name), v_user_id, p_number_of_players, TRUE)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, is_active)
  VALUES (v_league_id, v_user_id, 'owner', TRUE);

  INSERT INTO public.seasons (league_id, season_number, status)
  VALUES (v_league_id, 1, 'draft_pending')
  RETURNING id INTO v_season_id;

  INSERT INTO public.league_settings (
    league_id,
    season_id,
    draft_format,
    total_rounds,
    enable_pokemon_costs,
    total_token_salary,
    allow_per_team_salary,
    pick_time_limit_minutes,
    auto_pick_on_timeout,
    skip_player_on_timeout,
    quiet_hours_enabled,
    quiet_hours_start_est,
    quiet_hours_end_est,
    enable_transaction_costs,
    transaction_cost,
    admins_approve_trades,
    owners_admins_vote_on_trades,
    draft_order_json
  )
  VALUES (
    v_league_id,
    v_season_id,
    'snake',
    1,
    FALSE,
    NULL,
    FALSE,
    5,
    FALSE,
    FALSE,
    FALSE,
    NULL,
    NULL,
    FALSE,
    NULL,
    FALSE,
    FALSE,
    jsonb_build_object(
      'mode', 'randomized',
      'participants', p_number_of_players
    )
  );

  -- The owner is on the teams page, with an empty roster, from the moment the
  -- league exists.
  INSERT INTO public.teams (league_id, season_id, owner_user_id, team_name)
  SELECT
    lm.league_id,
    v_season_id,
    lm.user_id,
    COALESCE(p.display_name, 'Player ' || substr(lm.user_id::text, 1, 8))
  FROM public.league_members lm
  LEFT JOIN public.profiles p ON p.id = lm.user_id
  WHERE lm.league_id = v_league_id
    AND lm.user_id = v_user_id;

  RETURN QUERY
  SELECT v_league_id, v_season_id, btrim(p_name), p_number_of_players;
END;
$$;

REVOKE ALL ON FUNCTION public.create_league_for_user(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_league_for_user(TEXT, INTEGER) TO authenticated;

-- Re-issued invite join with the same membership rules, plus an empty team in
-- the newest season while that season is still pre-draft. No team is created
-- once the draft has started, because the draft order and schedule are already
-- built around the teams that existed when it began.
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

  INSERT INTO public.teams (
    league_id, season_id, owner_user_id, team_name, draft_position
  )
  SELECT
    v_league_id,
    s.id,
    v_user_id,
    COALESCE(p.display_name, 'Player ' || substr(v_user_id::text, 1, 8)),
    lm.draft_position
  FROM public.seasons s
  JOIN public.league_members lm
    ON lm.league_id = s.league_id
   AND lm.user_id = v_user_id
  LEFT JOIN public.profiles p ON p.id = v_user_id
  WHERE s.league_id = v_league_id
    AND s.status = 'draft_pending'
    AND s.season_number = (
      SELECT MAX(s2.season_number)
      FROM public.seasons s2
      WHERE s2.league_id = v_league_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.league_id = v_league_id
        AND t.season_id = s.id
        AND t.owner_user_id = v_user_id
    );

  RETURN QUERY SELECT v_league_id, v_league_name;
END;
$$;

-- The invite join was already granted to authenticated by 20250915; re-assert
-- it so this migration is self-contained.
REVOKE ALL ON FUNCTION public.join_league_by_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_league_by_invite(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
