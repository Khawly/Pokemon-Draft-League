-- Draft pause/resume, priority-list pruning, and pause-aware resolver
--
-- Adds a draft_paused_at stamp to seasons so an owner can freeze the on-clock
-- pick timer; re-creates insert_draft_pick so a Pokemon drafted by anyone is
-- removed from every priority list in the season; makes resolve_draft_timeout
-- treat a paused draft as "not due" (no auto-pick/pass while frozen); re-creates
-- start_draft/reset_draft so both clear the pause stamp; and adds the owner-only
-- set_draft_paused RPC used by the Pause/Play button.

-- The pause stamp on a season. NULL while the pick timer is running; a
-- timestamp while the owner has frozen the current pick.
ALTER TABLE public.seasons ADD COLUMN IF NOT EXISTS draft_paused_at TIMESTAMPTZ;

-- Recreates insert_draft_pick: records the pick, prunes the drafted Pokemon
-- from every priority list in the season (so stale auto-pick candidates vanish
-- for all players at once), mirrors the roster/transaction rows, and restarts
-- the next player's timer or completes the draft.
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
    -- same deadline from this timestamp.
    UPDATE public.seasons
    SET draft_pick_started_at = NOW()
    WHERE id = p_season_id;
    status := 'draft_active';
  END IF;

  season_id := p_season_id;

  RETURN NEXT;
END;
$$;

-- Recreates start_draft: unchanged behavior except that starting a fresh draft
-- also clears any leftover draft_paused_at stamp from a prior paused attempt.
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

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;

-- Recreates reset_draft: unchanged behavior except that returning a season to
-- draft_pending also clears any draft_paused_at stamp.
--
-- @param p_league_id - The id of the league whose latest season to reset.
-- @returns The id and new (draft_pending) status of the season.
CREATE OR REPLACE FUNCTION public.reset_draft(
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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to reset the draft.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can reset the draft.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season exists for this league.';
  END IF;

  IF v_status = 'draft_pending' THEN
    RETURN QUERY SELECT v_season_id, 'draft_pending';
    RETURN;
  END IF;

  -- Tear down the draft's generated state in foreign-key order so nothing the
  -- arena references outlives the reset.
  DELETE FROM public.draft_picks d
  WHERE d.league_id = p_league_id AND d.season_id = v_season_id;

  DELETE FROM public.team_roster r
  USING public.teams t
  WHERE r.team_id = t.id
    AND t.league_id = p_league_id
    AND t.season_id = v_season_id;

  DELETE FROM public.transactions x
  WHERE x.league_id = p_league_id AND x.season_id = v_season_id;

  DELETE FROM public.draft_priority_lists pl
  WHERE pl.season_id = v_season_id;

  DELETE FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  UPDATE public.seasons
  SET status = 'draft_pending',
      draft_started_at = NULL,
      draft_pick_started_at = NULL,
      draft_completed_at = NULL,
      draft_paused_at = NULL
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_pending';
END;
$$;

-- Recreates resolve_draft_timeout: while the season's draft_paused_at stamp is
-- set, the pick timer is frozen, so (unless forced) no auto-pick, zero-salary
-- skip, or pass resolves the turn. Resuming shifts the start stamp forward by
-- the elapsed pause so the deadline stays the same length.
--
-- @param p_league_id - The league whose current turn may need resolving.
-- @param p_force     - When true, resolve regardless of timer/pause state.
-- @returns The season id and a status of 'draft_active', 'draft_complete', or
--   'not_due' when the turn should not resolve yet.
CREATE OR REPLACE FUNCTION public.resolve_draft_timeout(
  p_league_id UUID,
  p_force BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (season_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_turn RECORD;
  v_deadline TIMESTAMPTZ;
  v_limit_minutes INTEGER;
  v_started_at TIMESTAMPTZ;
  v_paused_at TIMESTAMPTZ;
  v_enable_costs BOOLEAN;
  v_per_team BOOLEAN;
  v_budget INTEGER;
  v_override INTEGER;
  v_spent INTEGER;
  v_remaining INTEGER;
  v_due BOOLEAN;
  v_candidate RECORD;
  v_cost INTEGER;
  v_auto_pick BOOLEAN;
  v_chosen TEXT := NULL;
  v_species TEXT := NULL;
  v_tier INTEGER := 0;
BEGIN
  FOR v_turn IN SELECT * FROM public.get_draft_turn(p_league_id) LOOP
    EXIT;
  END LOOP;

  SELECT s.draft_pick_started_at, s.draft_paused_at
  INTO v_started_at, v_paused_at
  FROM public.seasons s
  WHERE s.id = v_turn.season_id;

  -- A paused timer never resolves on its own; only an explicit force advances
  -- a paused draft. Resuming (set_draft_paused FALSE) shifts the start stamp.
  IF NOT p_force AND v_paused_at IS NOT NULL THEN
    RETURN QUERY SELECT v_turn.season_id, 'not_due';
    RETURN;
  END IF;

  SELECT
    COALESCE(ls.pick_time_limit_minutes, 5),
    COALESCE(ls.enable_pokemon_costs, FALSE),
    COALESCE(ls.allow_per_team_salary, FALSE),
    COALESCE(ls.auto_pick_on_timeout, FALSE)
  INTO v_limit_minutes, v_enable_costs, v_per_team, v_auto_pick
  FROM public.league_settings ls
  WHERE ls.season_id = v_turn.season_id;

  v_due := p_force;

  -- Resolve the on-turn team's salary figures up front so the zero-token skip
  -- and the auto-pick affordability check use the same numbers.
  IF v_enable_costs THEN
    SELECT COALESCE(SUM(d.cost_delta), 0) INTO v_spent
    FROM public.draft_picks d
    WHERE d.season_id = v_turn.season_id AND d.team_id = v_turn.team_id;

    IF v_per_team THEN
      SELECT t.total_salary_override INTO v_override
      FROM public.teams t
      WHERE t.id = v_turn.team_id;
      v_budget := v_override;
    END IF;

    IF v_budget IS NULL THEN
      SELECT ls.total_token_salary INTO v_budget
      FROM public.league_settings ls
      WHERE ls.season_id = v_turn.season_id;
    END IF;

    v_remaining := COALESCE(v_budget, 0) - v_spent;
  END IF;

  IF NOT p_force AND v_started_at IS NOT NULL THEN
    v_deadline := v_started_at + make_interval(mins => v_limit_minutes);
    IF NOW() >= v_deadline THEN
      v_due := TRUE;
    END IF;
  ELSIF v_started_at IS NULL THEN
    -- No start stamp yet; treat the turn as due so the draft advances.
    v_due := TRUE;
  END IF;

  -- Zero remaining salary: the player cannot afford a paid pick, so skip
  -- them immediately rather than letting the timer run out.
  IF v_enable_costs AND NOT v_due AND v_remaining <= 0 THEN
    v_due := TRUE;
  END IF;

  IF NOT v_due THEN
    RETURN QUERY SELECT v_turn.season_id, 'not_due';
    RETURN;
  END IF;

  IF v_auto_pick THEN
    FOR v_candidate IN
      SELECT dpl.pokemon_id, dpp.species_name, dpp.tier_value
      FROM public.draft_priority_lists dpl
      JOIN public.draft_pool_pokemon dpp
        ON dpp.pokemon_id = dpl.pokemon_id
      JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
      WHERE dpl.season_id = v_turn.season_id
        AND dpl.user_id = v_turn.on_turn_user_id
        AND dpl.round_number = v_turn.round_number
        AND dpp.is_in_pool = TRUE
        AND dp.season_id = v_turn.season_id
        AND (
          dp.is_active = TRUE
          OR NOT EXISTS (
            SELECT 1 FROM public.draft_pools a
            WHERE a.season_id = v_turn.season_id AND a.is_active = TRUE
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.draft_picks d
          WHERE d.season_id = v_turn.season_id AND d.pokemon_id = dpl.pokemon_id
        )
      ORDER BY dpl.slot_index ASC
    LOOP
      v_cost := 0;
      IF v_enable_costs THEN
        v_cost := v_candidate.tier_value;
        IF (COALESCE(v_budget, 0) - v_spent - v_cost) < 0 THEN
          CONTINUE;
        END IF;
      END IF;
      v_chosen := v_candidate.pokemon_id;
      v_species := v_candidate.species_name;
      v_tier := v_candidate.tier_value;
      EXIT;
    END LOOP;
  END IF;

  IF v_chosen IS NULL THEN
    RETURN QUERY
    SELECT * FROM public.insert_draft_pick(
      p_league_id, v_turn.season_id, v_turn.team_id, v_turn.on_turn_user_id,
      v_turn.round_number, v_turn.pick_in_round, v_turn.overall_pick,
      NULL, NULL, 0, 0, TRUE
    );
  ELSE
    RETURN QUERY
    SELECT * FROM public.insert_draft_pick(
      p_league_id, v_turn.season_id, v_turn.team_id, v_turn.on_turn_user_id,
      v_turn.round_number, v_turn.pick_in_round, v_turn.overall_pick,
      v_chosen, v_species, v_tier, v_cost, FALSE
    );
  END IF;
  RETURN;
END;
$$;

-- Owner-only RPC that pauses or resumes the current pick timer. Pausing stamps
-- draft_paused_at; resuming shifts draft_pick_started_at forward by the elapsed
-- pause so the deadline budget that existed when the timer was frozen is
-- restored exactly (it neither gains nor loses time).
--
-- @param p_league_id - The league whose draft timer to toggle.
-- @param p_paused    - True to pause the timer, false to resume it.
-- @returns The season id, its status, and the (new) draft_paused_at value.
CREATE OR REPLACE FUNCTION public.set_draft_paused(
  p_league_id UUID,
  p_paused BOOLEAN
)
RETURNS TABLE (season_id UUID, status TEXT, draft_paused_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_status TEXT;
  v_paused_at TIMESTAMPTZ;
  v_started_at TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to pause the draft.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Only the league owner can pause the draft.';
  END IF;

  SELECT s.id, s.status, s.draft_paused_at, s.draft_pick_started_at
  INTO v_season_id, v_status, v_paused_at, v_started_at
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season exists for this league.';
  END IF;

  IF v_status <> 'draft_active' THEN
    RAISE EXCEPTION 'The draft timer can only be paused while the draft is active.';
  END IF;

  IF p_paused AND v_paused_at IS NULL THEN
    UPDATE public.seasons
    SET draft_paused_at = NOW()
    WHERE id = v_season_id;
  ELSIF NOT p_paused AND v_paused_at IS NOT NULL THEN
    -- Fold the paused window into the start stamp so the next deadline is
    -- exactly limit-minutes after the timer resumes.
    UPDATE public.seasons
    SET draft_pick_started_at = v_started_at + (NOW() - v_paused_at),
        draft_paused_at = NULL
    WHERE id = v_season_id;
  END IF;

  SELECT s.draft_paused_at INTO v_paused_at
  FROM public.seasons s
  WHERE s.id = v_season_id;

  RETURN QUERY SELECT v_season_id, v_status, v_paused_at;
END;
$$;

-- Restrict the new RPC to authenticated users only, like the other engine calls.
REVOKE ALL ON FUNCTION public.set_draft_paused(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_draft_paused(UUID, BOOLEAN) TO authenticated;