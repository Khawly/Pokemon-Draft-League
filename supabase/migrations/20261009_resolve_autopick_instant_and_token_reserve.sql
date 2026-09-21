-- Instant auto-pick on empty priority lists + a token reserve rule
--
-- Two changes to the draft's turn resolver:
--   1. A round with Auto Pick enabled now resolves the turn immediately even
--      when the player's priority list has no remaining candidates — the pool
--      fallback (best available, weakness-aware Pokemon) picks instead of the
--      turn hanging until the timer expires (or forever on a setting that
--      never fires the client timer path).
--   2. The auto picker can no longer spend the player's last tokens on a
--      single Pokemon: while the team has fewer than six Pokemon drafted, the
--      picker keeps enough tokens in reserve to afford one Pokemon for every
--      roster slot still to come (up to six), so a player can never drain
--      their whole budget before drafting their 6th Pokemon. The reserve is
--      clamped so it can never block spending on the cheapest pick when the
--      budget is too small to reach six Pokemon anyway.

-- Recreates resolve_draft_timeout with the two auto-pick rules. Behavior is
-- unchanged otherwise: pause/force handling, the priority-list pick, the
-- weakness-aware pool fallback, the zero-token skip, and pass-on-no-candidate
-- all stay as-is.
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
  v_round_auto BOOLEAN := FALSE;
  v_round_skip BOOLEAN := FALSE;
  v_chosen TEXT := NULL;
  v_species TEXT := NULL;
  v_tier INTEGER := 0;
  v_roster_count INTEGER := 0;
  v_reserve INTEGER := 0;
  v_min_roster CONSTANT INTEGER := 6;
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

  -- The on-turn player's per-round Auto/Skip flags (stored independently of
  -- the priority list, so they work for empty rounds too). Skip-pick takes
  -- precedence over auto-pick; those flags also drive the timer budget below.
  SELECT COALESCE(drs.auto_pick, FALSE), COALESCE(drs.skip_pick, FALSE)
  INTO v_round_auto, v_round_skip
  FROM public.draft_round_settings drs
  WHERE drs.season_id = v_turn.season_id
    AND drs.user_id = v_turn.on_turn_user_id
    AND drs.round_number = v_turn.round_number;

  IF v_round_skip THEN
    v_auto_pick := FALSE;
  ELSIF v_round_auto THEN
    v_auto_pick := TRUE;
  END IF;

  -- Resolve the on-turn team's salary figures up front so the zero-token skip,
  -- the token reserve, and the auto-pick affordability check use the same
  -- numbers.
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

    -- How many Pokemon the team has already locked in; the reserve keeps the
    -- rest of the roster (up to six) affordable.
    SELECT COUNT(*)::INTEGER INTO v_roster_count
    FROM public.draft_picks d
    WHERE d.season_id = v_turn.season_id
      AND d.team_id = v_turn.team_id
      AND d.pokemon_id IS NOT NULL;

    -- Reserve one token per roster slot that will still follow this pick
    -- (slots up to the 6th Pokemon). If the whole remaining budget can't even
    -- cover the required reserve, clamp it down so at least the cheapest pick
    -- stays spendable — otherwise the picker would pass every turn forever.
    v_reserve := GREATEST(0, v_min_roster - (v_roster_count + 1));
    IF (COALESCE(v_budget, 0) - v_spent - v_reserve) < 1 THEN
      v_reserve := GREATEST(0, COALESCE(v_budget, 0) - v_spent - 1);
    END IF;
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

  -- Round-level flags resolve the turn immediately instead of waiting out the
  -- timer: skip-pick passes right away, and auto-pick fires right away even
  -- when the round's priority list has no remaining candidates — the pool
  -- fallback below then picks the best available Pokemon for the player.
  IF NOT p_force AND NOT v_due THEN
    IF v_round_skip THEN
      v_due := TRUE;
    ELSIF v_round_auto THEN
      v_due := TRUE;
    END IF;
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
        IF (COALESCE(v_budget, 0) - v_spent - v_cost) < v_reserve THEN
          CONTINUE;
        END IF;
      END IF;
      v_chosen := v_candidate.pokemon_id;
      v_species := v_candidate.species_name;
      v_tier := v_candidate.tier_value;
      EXIT;
    END LOOP;
  END IF;

  -- No usable priority-list entry while auto-pick is on: fall back to the best
  -- available pool Pokemon instead of wasting the roster slot on a pass.
  -- Candidates are ordered by tier (highest first), then by how little their
  -- weaknesses duplicate the team's existing drafted Pokemon, then BST and
  -- name. The weakness penalty is strict in the first three rounds (any
  -- duplicated weakness drops the rank); afterwards sharing a weakness with at
  -- most one drafted Pokemon is ideal and sharing with two is acceptable.
  IF v_auto_pick AND v_chosen IS NULL THEN
    FOR v_candidate IN
      WITH available AS (
        SELECT DISTINCT ON (dpp.pokemon_id)
          dpp.pokemon_id, dpp.species_name, dpp.tier_value, dpp.bst,
          dpp.type_primary, dpp.type_secondary
        FROM public.draft_pool_pokemon dpp
        JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
        WHERE dp.season_id = v_turn.season_id
          AND dpp.is_in_pool = TRUE
          AND (
            dp.is_active = TRUE
            OR NOT EXISTS (
              SELECT 1 FROM public.draft_pools a
              WHERE a.season_id = v_turn.season_id AND a.is_active = TRUE
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.draft_picks d
            WHERE d.season_id = v_turn.season_id AND d.pokemon_id = dpp.pokemon_id
          )
        ORDER BY dpp.pokemon_id, dp.is_active DESC
      ),
      candidate_weakness AS (
        SELECT c.pokemon_id, w AS weakness_type
        FROM available c
        CROSS JOIN LATERAL public.pokemon_weaknesses(
          c.type_primary, c.type_secondary
        ) AS w
      ),
      team_weakness AS (
        SELECT dpp.pokemon_id AS team_poke, w AS weakness_type
        FROM public.draft_picks d
        JOIN public.draft_pool_pokemon dpp ON dpp.pokemon_id = d.pokemon_id
        CROSS JOIN LATERAL public.pokemon_weaknesses(
          dpp.type_primary, dpp.type_secondary
        ) AS w
        WHERE d.season_id = v_turn.season_id
          AND d.team_id = v_turn.team_id
          AND d.pokemon_id IS NOT NULL
      ),
      scored AS (
        SELECT a.pokemon_id, a.species_name, a.tier_value, a.bst,
          COALESCE((
            SELECT MAX(shared)
            FROM (
              SELECT COUNT(DISTINCT tw.team_poke) AS shared
              FROM team_weakness tw
              WHERE tw.weakness_type = cw.weakness_type
            ) s
          ), 0) AS worst_share
        FROM available a
        JOIN candidate_weakness cw ON cw.pokemon_id = a.pokemon_id
      )
      SELECT s.pokemon_id, s.species_name, s.tier_value
      FROM scored s
      ORDER BY
        s.tier_value DESC,
        (
          CASE
            WHEN v_turn.round_number <= 3 THEN
              CASE WHEN s.worst_share = 0 THEN 0
                   WHEN s.worst_share = 1 THEN 1
                   ELSE 2 END
            ELSE
              CASE WHEN s.worst_share <= 1 THEN 0
                   WHEN s.worst_share = 2 THEN 1
                   ELSE 2 END
          END
        ) ASC,
        s.worst_share ASC,
        s.bst DESC,
        s.species_name ASC
    LOOP
      v_cost := 0;
      IF v_enable_costs THEN
        v_cost := v_candidate.tier_value;
        IF (COALESCE(v_budget, 0) - v_spent - v_cost) < v_reserve THEN
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