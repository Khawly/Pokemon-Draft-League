-- Round-level Auto/Skip flags, immediate resolution, and test-bot seeding
--
-- Moves per-round auto-pick / skip-pick toggles off the priority rows and into
-- a new draft_round_settings table so a flag can be set for a round with no
-- Pokemon pinned (the old columns required at least one row to carry the
-- flag). Adds immediate resolution to resolve_draft_timeout: skip-pick passes
-- the turn the instant it comes up, auto-pick fires right away when the round
-- has candidates, and auto-pick also re-enables the pool fallback (weakness-
-- aware best-Pokemon selection when the priority list is empty) that a later
-- recreate of the function dropped. Also seeds auto-pick on every round for
-- test-bot members, including on future season starts via a seasons trigger.

-- Per-round Auto-Pick / Skip-Pick flags for a (season, user). Unlike the old
-- columns on draft_priority_lists, these rows exist even when a round has no
-- Pokemon pinned, so toggles survive an empty round and survive refreshes.
CREATE TABLE IF NOT EXISTS public.draft_round_settings (
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  auto_pick BOOLEAN NOT NULL DEFAULT FALSE,
  skip_pick BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (season_id, user_id, round_number)
);

ALTER TABLE public.draft_round_settings ENABLE ROW LEVEL SECURITY;

-- Round flags are private per user, mirroring the priority-list policy: each
-- user reads only their own rows (the RPCs write via SECURITY DEFINER).
DROP POLICY IF EXISTS "Users can view their own round settings"
  ON public.draft_round_settings;
CREATE POLICY "Users can view their own round settings"
ON public.draft_round_settings
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Recreates set_priority_round_flags to write to the new table: the call now
-- upserts one (season, user, round) row instead of updating priority rows, so
-- it works for empty rounds too. Behavior otherwise unchanged (mutual
-- exclusion enforced, active membership required).
--
-- @param p_league_id   - The league whose priority round is being toggled.
-- @param p_round_number - The round number to flag (1-based).
-- @param p_auto_pick    - TRUE to auto-pick this round, FALSE otherwise.
-- @param p_skip_pick    - TRUE to skip this round, FALSE otherwise. Both TRUE
--   is rejected; callers pass at most one TRUE.
CREATE OR REPLACE FUNCTION public.set_priority_round_flags(
  p_league_id UUID,
  p_round_number INTEGER,
  p_auto_pick BOOLEAN,
  p_skip_pick BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  IF p_auto_pick AND p_skip_pick THEN
    RAISE EXCEPTION 'Auto-pick and skip-pick are mutually exclusive.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No season exists for this league.';
  END IF;

  INSERT INTO public.draft_round_settings (
    season_id, user_id, round_number, auto_pick, skip_pick
  ) VALUES (
    v_season_id, v_user_id, p_round_number, p_auto_pick, p_skip_pick
  )
  ON CONFLICT (season_id, user_id, round_number)
  DO UPDATE SET
    auto_pick = EXCLUDED.auto_pick,
    skip_pick = EXCLUDED.skip_pick;
END;
$$;

-- Turns on Auto-Pick for every round of the given season for every active
-- member whose profile name marks them as a test bot. Used both by the seed
-- below and by the seasons trigger for freshly started seasons.
--
-- @param p_season_id - The season to seed round flags for.
CREATE OR REPLACE FUNCTION public.ensure_testbot_autopick_flags(
  p_season_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.draft_round_settings (
    season_id, user_id, round_number, auto_pick, skip_pick
  )
  SELECT p_season_id, lm.user_id, r.round_number, TRUE, FALSE
  FROM public.league_members lm
  JOIN public.profiles p ON p.id = lm.user_id
  LEFT JOIN public.league_settings ls ON ls.season_id = p_season_id
  CROSS JOIN LATERAL generate_series(
    1, COALESCE(ls.total_rounds, 7)
  ) AS r(round_number)
  WHERE lm.league_id = (
        SELECT s.league_id FROM public.seasons s WHERE s.id = p_season_id
      )
    AND lm.is_active = TRUE
    AND p.display_name ILIKE 'test bot%'
  ON CONFLICT (season_id, user_id, round_number) DO NOTHING;
END;
$$;

-- Auto-picks on every round for test-bot members whenever a season flips to
-- draft_active, so starting a fresh draft (Test League 1 included) always has
-- the bots drafting instead of passing.
CREATE OR REPLACE FUNCTION public.on_season_testbot_autopick_flags()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'draft_active' AND OLD.status IS DISTINCT FROM 'draft_active' THEN
    PERFORM public.ensure_testbot_autopick_flags(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS season_testbot_autopick_flags ON public.seasons;
CREATE TRIGGER season_testbot_autopick_flags
AFTER INSERT OR UPDATE OF status ON public.seasons
FOR EACH ROW
EXECUTE FUNCTION public.on_season_testbot_autopick_flags();

-- Seeds existing seasons so the current Test League 1 season is covered too.
SELECT public.ensure_testbot_autopick_flags(s.id)
FROM public.seasons s;

-- Recreates resolve_draft_timeout: pause gate, per-round immediate resolution
-- (skip-pick passes as soon as the turn is up, auto-pick resolves immediately
-- when the round has candidates), the priority-list auto-pick loop, and the
-- empty-list fallback to the best available pool Pokemon. The fallback was
-- dropped by a later recreate of this function; it is restored here so bots
-- with Auto Pick on never burn a pick on a pass.
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
  v_round_has_candidates BOOLEAN := FALSE;
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

  SELECT EXISTS (
    SELECT 1 FROM public.draft_priority_lists dpl
    WHERE dpl.season_id = v_turn.season_id
      AND dpl.user_id = v_turn.on_turn_user_id
      AND dpl.round_number = v_turn.round_number
  ) INTO v_round_has_candidates;

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

  -- Round-level flags resolve the turn immediately instead of waiting out the
  -- timer: skip-pick passes right away (even with a full list), and auto-pick
  -- fires as soon as the round has priority candidates to choose from. An
  -- auto-pick round with an empty list still waits for the timer, then uses
  -- the pool fallback below.
  IF NOT p_force AND NOT v_due THEN
    IF v_round_skip THEN
      v_due := TRUE;
    ELSIF v_round_auto AND v_round_has_candidates THEN
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

-- Restrict the new/updated RPCs to authenticated users only, like the others.
REVOKE ALL ON FUNCTION public.set_priority_round_flags(UUID, INTEGER, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_priority_round_flags(UUID, INTEGER, BOOLEAN, BOOLEAN) TO authenticated;
REVOKE ALL ON FUNCTION public.ensure_testbot_autopick_flags(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_testbot_autopick_flags(UUID) TO authenticated;