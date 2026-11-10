-- Enforce a 32-character maximum on league and season names
--
-- Display names already use the same limit. League and season names sit in the
-- same compact headings and selectors, so they get the same cap in the UI, the
-- RPCs that write them, and the tables themselves.
--
-- Existing names longer than the limit are truncated rather than rejected: a
-- migration that fails on existing data cannot enforce anything.

-- Bring existing rows inside the new limit first.
UPDATE public.leagues
SET name = LEFT(name, 32)
WHERE char_length(name) > 32;

UPDATE public.seasons
SET name = LEFT(name, 32)
WHERE name IS NOT NULL
  AND char_length(name) > 32;

-- The direct owner update path for leagues writes the table without an RPC, so
-- the column constraint is what covers it.
ALTER TABLE public.leagues
  DROP CONSTRAINT IF EXISTS leagues_name_length;

ALTER TABLE public.leagues
  ADD CONSTRAINT leagues_name_length
  CHECK (char_length(name) <= 32);

-- Seasons already had a combined non-blank and 80-character constraint. Replace
-- it with the same non-blank rule at the new limit.
ALTER TABLE public.seasons
  DROP CONSTRAINT IF EXISTS seasons_name_not_blank;

ALTER TABLE public.seasons
  ADD CONSTRAINT seasons_name_not_blank
  CHECK (
    name IS NULL
    OR (btrim(name) <> '' AND char_length(name) <= 32)
  );

-- Re-issue league creation with the same limit checked before the insert, so a
-- long name produces a clear validation error rather than a constraint error.
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

  RETURN QUERY
  SELECT v_league_id, v_season_id, btrim(p_name), p_number_of_players;
END;
$$;

REVOKE ALL ON FUNCTION public.create_league_for_user(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_league_for_user(TEXT, INTEGER) TO authenticated;

-- Re-issue the season rename RPC with the 32-character limit.
CREATE OR REPLACE FUNCTION public.set_season_name(
  p_league_id UUID,
  p_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_name TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to rename a season.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can rename a season.';
  END IF;

  v_name := btrim(p_name);

  IF v_name = '' THEN
    v_name := NULL;
  END IF;

  IF v_name IS NOT NULL AND char_length(v_name) > 32 THEN
    RAISE EXCEPTION 'Season name must be 32 characters or fewer.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  UPDATE public.seasons
  SET name = v_name
  WHERE id = v_season_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_season_name(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_season_name(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
