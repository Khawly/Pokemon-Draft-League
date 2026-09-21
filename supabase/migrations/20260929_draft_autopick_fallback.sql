-- Auto-pick fallback with weakness diversity
--
-- When auto_pick_on_timeout is on and the on-turn player has no usable
-- priority-list entry for the round, `resolve_draft_timeout` previously
-- recorded a pass -- wasting a real roster slot. This adds a fallback that
-- picks the best available Pokemon (highest tier, then BST, then name) while
-- preferring candidates whose weaknesses least duplicate the team's existing
-- drafted Pokemon. Duplication is penalized harder in the first three rounds;
-- afterwards a weakness shared by the new pick with at most one drafted
-- Pokemon is ideal, with two already-drafted carriers tolerated as a fallback.

-- Resolves the attacking types that hit one or both of a Pokemon's types for
-- super-effective (2x+) damage, driven by the standard type chart. A weakness
-- here means "an opposing move type that deals bonus damage against this
-- Pokemon", which is what duplicate-weakness avoidance needs to compare.
--
-- @param p_primary - The Pokemon's primary normalized type, e.g. "fire".
-- @param p_secondary - The Pokemon's secondary normalized type, or NULL.
-- @returns The distinct attacking types the Pokemon is weak to.
CREATE OR REPLACE FUNCTION public.pokemon_weaknesses(
  p_primary TEXT,
  p_secondary TEXT
)
RETURNS SETOF TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT DISTINCT chart.attacker
  FROM (VALUES
    ('fire', 'grass'), ('fire', 'ice'), ('fire', 'bug'), ('fire', 'steel'),
    ('water', 'fire'), ('water', 'ground'), ('water', 'rock'),
    ('electric', 'water'), ('electric', 'flying'),
    ('grass', 'water'), ('grass', 'ground'), ('grass', 'rock'),
    ('ice', 'grass'), ('ice', 'ground'), ('ice', 'flying'), ('ice', 'dragon'),
    ('fighting', 'normal'), ('fighting', 'ice'), ('fighting', 'rock'),
    ('fighting', 'dark'), ('fighting', 'steel'),
    ('poison', 'grass'), ('poison', 'fairy'),
    ('ground', 'fire'), ('ground', 'electric'), ('ground', 'poison'),
    ('ground', 'rock'), ('ground', 'steel'),
    ('flying', 'grass'), ('flying', 'fighting'), ('flying', 'bug'),
    ('psychic', 'fighting'), ('psychic', 'poison'),
    ('bug', 'grass'), ('bug', 'psychic'), ('bug', 'dark'),
    ('rock', 'fire'), ('rock', 'ice'), ('rock', 'flying'), ('rock', 'bug'),
    ('ghost', 'ghost'), ('ghost', 'psychic'),
    ('dragon', 'dragon'),
    ('dark', 'ghost'), ('dark', 'psychic'),
    ('steel', 'ice'), ('steel', 'rock'), ('steel', 'fairy'),
    ('fairy', 'fighting'), ('fairy', 'dragon'), ('fairy', 'dark')
  ) AS chart(attacker, defender)
  WHERE chart.defender = lower(p_primary)
     OR (p_secondary IS NOT NULL AND chart.defender = lower(p_secondary));
$$;

-- Advances the draft when the current player's timer has expired (or is forced
-- via p_force). With auto_pick_on_timeout it takes the player's highest
-- remaining priority-list Pokemon for the round; otherwise (or when the list is
-- exhausted) it records a pass. Players with a zero remaining salary are
-- auto-skipped as soon as their turn begins, without waiting out the timer.
--
-- When the priority list has no usable entry, the auto-pick falls back to the
-- best available Pokemon in the pool (highest tier, then BST descending, then
-- name) unless none can be afforded. The fallback also favors Pokemon whose
-- weakness profile (see pokemon_weaknesses) least overlaps the team's already
-- drafted roster: strictly avoiding any duplicated weakness in the first three
-- rounds, and preferring at most two Pokemon sharing a weakness afterwards.
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
  v_taken TEXT;
BEGIN
  FOR v_turn IN SELECT * FROM public.get_draft_turn(p_league_id) LOOP
    EXIT;
  END LOOP;

  SELECT s.draft_pick_started_at INTO v_started_at
  FROM public.seasons s
  WHERE s.id = v_turn.season_id;

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

  -- No usable priority-list entry: fall back to the best available pool Pokemon
  -- instead of wasting the roster slot on a pass. Candidates are ordered by
  -- tier (highest first), then by how little their weaknesses duplicate the
  -- team's existing drafted Pokemon, then BST and name. The weakness penalty is
  -- strict in the first three rounds (any duplicated weakness drops the rank);
  -- afterwards sharing a weakness with at most one drafted Pokemon is ideal and
  -- sharing with two is acceptable.
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