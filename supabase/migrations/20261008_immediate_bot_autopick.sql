-- Immediate auto-pick for test bots
--
-- Makes test-bot members (current and future, detected by profile display
-- name) take their pick the instant their turn comes up: after any pick lands,
-- insert_draft_pick now auto-advances through consecutive bot turns using the
-- normal resolver (priority list, then the pool fallback), so a single human
-- pick sweeps through every following bot without waiting for a timer or an
-- open client. start_draft does the same when the very first on-clock player
-- is a bot. Bots whose round has no auto-pick enabled are left to the normal
-- timer path.

-- True when the given user is a test bot (profile display name "Test Bot ...").
-- Name-driven so current and future test bots are covered without re-seeding.
--
-- @param p_user_id - The user to classify.
-- @returns True for members whose profile marks them as a test bot.
CREATE OR REPLACE FUNCTION public.is_test_bot_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user_id
      AND p.display_name ILIKE 'test bot%'
  );
$$;

-- Auto-advances the draft through consecutive test-bot turns. Each iteration
-- resolves the on-clock bot's turn immediately (prioritizing their round list,
-- then falling back to the best available pool Pokemon) and repeats until the
-- clock lands on a human player, the draft completes, the bot's round lacks
-- auto-pick, or the draft is paused. The cap is a safety valve against any
-- unforeseen loop; a well-formed draft can never reach it.
--
-- @param p_league_id - The league whose draft to advance.
CREATE OR REPLACE FUNCTION public.advance_bot_autopicks(p_league_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_turn RECORD;
  v_league_auto BOOLEAN;
  v_round_auto BOOLEAN;
  v_res_status TEXT;
  v_guard INTEGER := 0;
BEGIN
  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 200 THEN
      RAISE EXCEPTION 'Bot auto-pick chain exceeded its safety limit.';
    END IF;

    -- Stop immediately if the draft has completed or the owner paused it.
    IF NOT EXISTS (
      SELECT 1 FROM public.seasons s
      WHERE s.league_id = p_league_id
        AND s.status = 'draft_active'
        AND s.draft_paused_at IS NULL
      ORDER BY s.season_number DESC
      LIMIT 1
    ) THEN
      EXIT;
    END IF;

    SELECT * INTO v_turn
    FROM public.get_draft_turn(p_league_id)
    LIMIT 1;

    -- Only chain while the on-clock player is a test bot.
    IF NOT public.is_test_bot_user(v_turn.on_turn_user_id) THEN
      EXIT;
    END IF;

    -- ...and their current round has auto-pick (league setting or round flag).
    SELECT
      COALESCE(ls.auto_pick_on_timeout, FALSE),
      COALESCE(drs.auto_pick, FALSE)
    INTO v_league_auto, v_round_auto
    FROM public.league_settings ls
    LEFT JOIN public.draft_round_settings drs
      ON drs.season_id = ls.season_id
     AND drs.user_id = v_turn.on_turn_user_id
     AND drs.round_number = v_turn.round_number
    WHERE ls.season_id = v_turn.season_id;

    IF NOT (v_league_auto OR v_round_auto) THEN
      EXIT;
    END IF;

    -- Resolve this bot's turn right now; the resolver records the pick (or a
    -- zero-salary skip) and the pick itself re-enters the chain for the next
    -- player, so the loop here just follows along until a human is up again.
    SELECT status INTO v_res_status
    FROM public.resolve_draft_timeout(p_league_id, TRUE)
    LIMIT 1;

    IF COALESCE(v_res_status, '') <> 'draft_active' THEN
      EXIT;
    END IF;
  END LOOP;
END;
$$;

-- Recreates insert_draft_pick: records the pick, prunes the drafted Pokemon
-- from every priority list in the season, mirrors the roster/transaction rows,
-- restarts the next player's timer (or completes the draft), and — once a pick
-- lands while the draft stays active — kicks the test-bot auto-chain so the
-- draft immediately sweeps through any consecutive bot turns.
--
-- @param p_league_id    - The league the pick belongs to.
-- @param p_season_id    - The season being drafted.
-- @param p_team_id      - The on-turn team making the pick.
-- @param p_user_id      - The team owner making the pick.
-- @param p_round_number - Round of the pick board.
-- @param p_pick_in_round - Position within the round.
-- @param p_overall_pick - Overall position in the draft.
-- @param p_pokemon_id   - Slug of the drafted Pokemon (NULL when passing).
-- @param p_species_name - Species display name (NULL when passing).
-- @param p_tier_value   - The Pokemon's tier value (0 when passing).
-- @param p_cost_delta   - Salary cost applied to the team (0 when passing).
-- @param p_is_pass      - True when the pick is a pass, not a Pokemon.
-- @returns The season id and its status after the pick lands.
CREATE OR REPLACE FUNCTION public.insert_draft_pick(
  p_league_id UUID,
  p_season_id UUID,
  p_team_id UUID,
  p_user_id UUID,
  p_round_number INTEGER,
  p_pick_in_round INTEGER,
  p_overall_pick INTEGER,
  p_pokemon_id TEXT,
  p_species_name TEXT,
  p_tier_value INTEGER,
  p_cost_delta INTEGER,
  p_is_pass BOOLEAN
)
RETURNS TABLE (season_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_teams_count INTEGER;
  v_total_rounds INTEGER;
  v_last_overall INTEGER;
BEGIN
  INSERT INTO public.draft_picks (
    league_id, season_id, team_id, user_id, round_number, pick_in_round,
    overall_pick, pokemon_id, species_name, tier_value, cost_delta, is_pass
  ) VALUES (
    p_league_id, p_season_id, p_team_id, p_user_id, p_round_number,
    p_pick_in_round, p_overall_pick, p_pokemon_id, p_species_name,
    p_tier_value, p_cost_delta, p_is_pass
  );

  IF p_pokemon_id IS NOT NULL AND NOT p_is_pass THEN
    -- A Pokemon is drafted at most once per season: drop it from every player's
    -- priority list (and the current player's draft-board picks) the moment it
    -- is taken, so no stale auto-pick candidate lingers anywhere.
    DELETE FROM public.draft_priority_lists dpl
    WHERE dpl.season_id = p_season_id
      AND dpl.pokemon_id = p_pokemon_id;

    INSERT INTO public.team_roster (team_id, pokemon_id, species_name, tier_value, source)
    VALUES (p_team_id, p_pokemon_id, p_species_name, p_tier_value, 'draft');

    INSERT INTO public.transactions (
      league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
      cost_delta, note
    ) VALUES (
      p_league_id, p_season_id, p_user_id, p_team_id, p_pokemon_id, 'added',
      1, p_cost_delta, 'Draft pick'
    );
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_teams_count
  FROM public.teams t
  WHERE t.season_id = p_season_id;

  SELECT COALESCE(ls.total_rounds, 1) INTO v_total_rounds
  FROM public.league_settings ls
  WHERE ls.season_id = p_season_id;

  v_total_rounds := COALESCE(v_total_rounds, 1);

  v_last_overall := v_teams_count * v_total_rounds;

  IF p_overall_pick >= v_last_overall THEN
    UPDATE public.seasons
    SET status = 'draft_complete', draft_completed_at = NOW()
    WHERE id = p_season_id;
    status := 'draft_complete';
  ELSE
    -- Restart the next player's timer right away so every client derives the
    -- same deadline from this timestamp, then run any following bot turns.
    UPDATE public.seasons
    SET draft_pick_started_at = NOW()
    WHERE id = p_season_id;
    status := 'draft_active';

    PERFORM public.advance_bot_autopicks(p_league_id);
    IF status = 'draft_active' THEN
      SELECT COALESCE(MAX(ss.status), 'draft_active') INTO status
      FROM public.seasons ss
      WHERE ss.id = p_season_id;
    END IF;
  END IF;

  season_id := p_season_id;

  RETURN NEXT;
END;
$$;

-- Recreates start_draft: unchanged behavior except that after flipping the
-- season live it kicks the test-bot auto-chain, so a league whose first on-clock
-- player is a bot starts drafting immediately.
--
-- @param p_league_id - The id of the league whose draft is being started.
-- @returns The id and new status of the started season.
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
  v_member_count INTEGER;
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

  SELECT COUNT(*)::INTEGER INTO v_member_count
  FROM public.league_members lm
  WHERE lm.league_id = p_league_id AND lm.is_active = TRUE;

  IF v_member_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: fill all player slots first (% of % filled).',
      v_member_count,
      v_max_players;
  END IF;

  -- Draft order must be fully assigned before the order locks in.
  SELECT COUNT(*)::INTEGER INTO v_assigned_count
  FROM public.league_members lm
  WHERE lm.league_id = p_league_id
    AND lm.is_active = TRUE
    AND lm.draft_position IS NOT NULL;

  IF v_assigned_count < v_max_players THEN
    RAISE EXCEPTION
      'Draft cannot start: assign a draft position to every player (%).',
      v_assigned_count;
  END IF;

  -- Mirror the ordered member list into one team row per active member so the
  -- pick ledger / roster / transaction tables keep working unchanged. Rewritten
  -- as update-then-insert (all identifiers qualified) to avoid the ambiguous
  -- column reference the ON CONFLICT clause raises next to the OUT parameters.
  UPDATE public.teams t
  SET draft_position = lm.draft_position
  FROM public.league_members lm
  WHERE t.league_id = p_league_id
    AND t.season_id = v_season_id
    AND t.owner_user_id = lm.user_id
    AND lm.league_id = p_league_id
    AND lm.is_active = TRUE;

  INSERT INTO public.teams (league_id, season_id, owner_user_id, team_name, draft_position)
  SELECT lm.league_id, v_season_id, lm.user_id,
         COALESCE(p.display_name, 'Player ' || substr(lm.user_id::text, 1, 8)),
         lm.draft_position
  FROM public.league_members lm
  LEFT JOIN public.profiles p ON p.id = lm.user_id
  WHERE lm.league_id = p_league_id
    AND lm.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.league_id = p_league_id
        AND t.season_id = v_season_id
        AND t.owner_user_id = lm.user_id
    );

  SELECT COUNT(*)::INTEGER INTO v_pool_pokemon_count
  FROM public.draft_pool_pokemon dpp
  JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
  WHERE dp.season_id = v_season_id
    AND dpp.is_in_pool = TRUE
    AND (
      dp.is_active = TRUE
      OR NOT EXISTS (
        SELECT 1 FROM public.draft_pools a
        WHERE a.season_id = v_season_id AND a.is_active = TRUE
      )
    );

  IF v_pool_pokemon_count <= 0 THEN
    RAISE EXCEPTION 'Draft cannot start: the draft pool has no in-pool Pokemon yet.';
  END IF;

  UPDATE public.seasons
  SET status = 'draft_active', draft_started_at = NOW(), draft_pick_started_at = NOW(),
      draft_paused_at = NULL
  WHERE id = v_season_id;

  -- If the first on-clock player is an auto-pick test bot, start drafting
  -- immediately instead of waiting out the first timer.
  PERFORM public.advance_bot_autopicks(p_league_id);

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;

-- Round settings are read by clients through the RLS policy; grant SELECT to
-- authenticated users and keep the new helper callable by the app like the
-- other engine RPCs.
GRANT SELECT ON public.draft_round_settings TO authenticated;
REVOKE ALL ON FUNCTION public.is_test_bot_user(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_test_bot_user(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.advance_bot_autopicks(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_bot_autopicks(UUID) TO authenticated;