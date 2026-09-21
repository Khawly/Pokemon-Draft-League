-- Draft engine: pick ledger, timers, and the pick/priority RPCs
--
-- Backs the live draft arena. Adds:
--   - draft_picks, the number-of-picks ledger and single source of truth for
--     who drafted which Pokemon (or passed) in the season
--   - seasons.draft_pick_started_at so clients can run per-pick timers by
--     reading the persisted start time (no server-side scheduler)
--   - get_draft_turn, insert_draft_pick, make_draft_pick,
--     resolve_draft_timeout and save_priority_list, SECURITY DEFINER RPCs that
--     enforce snake/set order, duplicate blocks, salary budgets, timeout
--     auto-pick/pass, zero-token auto-skip, and draft completion entirely in
--     the database
--   - SELECT RLS policies for teams/team_roster/draft_picks and a self-read
--     policy for draft_priority_lists (writes stay SECURITY DEFINER-only)

-- The draft pick ledger; one row per pick overall (including passes), so the
-- league, season, and overall pick are unique even when two teams pass.
CREATE TABLE IF NOT EXISTS public.draft_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  round_number INTEGER NOT NULL CHECK (round_number >= 1),
  pick_in_round INTEGER NOT NULL CHECK (pick_in_round >= 1),
  overall_pick INTEGER NOT NULL CHECK (overall_pick >= 1),
  pokemon_id TEXT,
  species_name TEXT,
  tier_value INTEGER NOT NULL DEFAULT 0,
  cost_delta INTEGER NOT NULL DEFAULT 0,
  is_pass BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One roster slot per season: a Pokemon can only be drafted once per season.
-- Passes (pokemon_id IS NULL) are excluded so they do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS draft_picks_one_roster_spot_uk
  ON public.draft_picks (season_id, pokemon_id)
  WHERE pokemon_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS draft_picks_slot_uk
  ON public.draft_picks (league_id, season_id, overall_pick);

ALTER TABLE public.draft_picks ENABLE ROW LEVEL SECURITY;

-- Members of a league can view the draft pick ledger for that league.
DROP POLICY IF EXISTS "Members can view draft picks" ON public.draft_picks;
CREATE POLICY "Members can view draft picks"
ON public.draft_picks
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

-- When the current pick started, so every client can derive the pick deadline
-- from the persisted pick_time_limit_minutes setting.
ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS draft_pick_started_at TIMESTAMPTZ;

-- Arena reads join teams and rosters; add the SELECT policies those pages rely
-- on (they were previously only writable through SECURITY DEFINER RPCs).
DROP POLICY IF EXISTS "Members can view league teams" ON public.teams;
CREATE POLICY "Members can view league teams"
ON public.teams
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

DROP POLICY IF EXISTS "Members can view league rosters" ON public.team_roster;
CREATE POLICY "Members can view league rosters"
ON public.team_roster
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.teams t
    WHERE t.id = team_id
      AND public.is_active_league_member(t.league_id)
  )
);

-- Priority lists are private: each user reads only their own rows.
DROP POLICY IF EXISTS "Users can view their own priority list" ON public.draft_priority_lists;
CREATE POLICY "Users can view their own priority list"
ON public.draft_priority_lists
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Resolves whose turn it is in the on-going draft, enforcing membership, an
-- active season, a fully ordered roster, and the league's snake/set order.
-- Raises instead of returning when the caller is not a member or the draft is
-- not active; safe for the write RPCs to rely on.
CREATE OR REPLACE FUNCTION public.get_draft_turn(
  p_league_id UUID
)
RETURNS TABLE (
  season_id UUID,
  round_number INTEGER,
  pick_in_round INTEGER,
  overall_pick INTEGER,
  team_id UUID,
  on_turn_user_id UUID,
  teams_count INTEGER,
  total_rounds INTEGER,
  is_snake_reversal BOOLEAN,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_format TEXT;
  v_teams_count INTEGER;
  v_picks_count INTEGER;
  v_overall INTEGER;
  v_round INTEGER;
  v_slot INTEGER;
  v_team_id UUID;
  v_owner UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT s.id, s.status INTO season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF season_id IS NULL THEN
    RAISE EXCEPTION 'No season exists for this league.';
  END IF;

  IF v_status <> 'draft_active' THEN
    RAISE EXCEPTION 'The draft is not active.';
  END IF;

  SELECT ls.draft_format, ls.total_rounds INTO v_format, total_rounds
  FROM public.league_settings ls
  WHERE ls.season_id = season_id;

  total_rounds := COALESCE(total_rounds, 1);

  SELECT COUNT(*)::INTEGER INTO v_teams_count
  FROM public.teams t
  WHERE t.season_id = season_id;

  IF v_teams_count <= 0 THEN
    RAISE EXCEPTION 'The draft order has no teams.';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_picks_count
  FROM public.draft_picks d
  WHERE d.season_id = season_id;

  v_overall := v_picks_count + 1;

  IF v_overall > v_teams_count * total_rounds THEN
    RAISE EXCEPTION 'The draft is already complete.';
  END IF;

  v_round := ((v_overall - 1) / v_teams_count) + 1;
  v_slot := ((v_overall - 1) % v_teams_count) + 1;

  round_number := v_round;
  pick_in_round := v_slot;
  overall_pick := v_overall;
  teams_count := v_teams_count;
  is_snake_reversal := (v_format = 'snake' AND v_round % 2 = 0);
  status := v_status;

  IF is_snake_reversal THEN
    v_slot := v_teams_count - v_slot + 1;
  END IF;

  SELECT t.id, t.owner_user_id INTO v_team_id, v_owner
  FROM public.teams t
  WHERE t.season_id = season_id AND t.draft_position = v_slot;

  IF v_team_id IS NULL THEN
    RAISE EXCEPTION 'The draft order is not fully set up.';
  END IF;

  team_id := v_team_id;
  on_turn_user_id := v_owner;

  RETURN NEXT;
END;
$$;

-- Commits a pick (or pass) and the matching roster/ledger rows, then advances
-- the timer or locks the draft when the last pick lands. SECURITY DEFINER and
-- callable only from the other engine functions; validate every input before
-- reaching this point and never expose it to the API.
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

-- Records a pick for the currently on-turn team's owner: validates the turn,
-- pool membership, duplication, and (when enabled) that the team's salary stays
-- non-negative. Passing (p_pokemon_id IS NULL) skips the team's turn.
CREATE OR REPLACE FUNCTION public.make_draft_pick(
  p_league_id UUID,
  p_pokemon_id TEXT DEFAULT NULL
)
RETURNS TABLE (season_id UUID, overall_pick INTEGER, round_number INTEGER, pick_in_round INTEGER, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_turn RECORD;
  v_species TEXT;
  v_tier INTEGER;
  v_cost INTEGER;
  v_enable_costs BOOLEAN;
  v_per_team BOOLEAN;
  v_budget INTEGER;
  v_override INTEGER;
  v_spent INTEGER;
BEGIN
  -- Resolve and validate the on-turn team (raises for non-members/inactive).
  FOR v_turn IN SELECT * FROM public.get_draft_turn(p_league_id) LOOP
    EXIT;
  END LOOP;

  IF auth.uid() <> v_turn.on_turn_user_id THEN
    RAISE EXCEPTION 'It is not your turn to make a pick.';
  END IF;

  SELECT
    COALESCE(ls.enable_pokemon_costs, FALSE),
    COALESCE(ls.allow_per_team_salary, FALSE)
  INTO v_enable_costs, v_per_team
  FROM public.league_settings ls
  WHERE ls.season_id = v_turn.season_id;

  IF p_pokemon_id IS NULL THEN
    RETURN QUERY
    SELECT * FROM public.insert_draft_pick(
      p_league_id, v_turn.season_id, v_turn.team_id, auth.uid(),
      v_turn.round_number, v_turn.pick_in_round, v_turn.overall_pick,
      NULL, NULL, 0, 0, TRUE
    );
    RETURN;
  END IF;

  -- Resolve species/tier from the season's draft pool (any active pool, or all
  -- pools when none has been marked active), matching start_draft's scope.
  SELECT dpp.species_name, dpp.tier_value INTO v_species, v_tier
  FROM public.draft_pool_pokemon dpp
  JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
  WHERE dp.season_id = v_turn.season_id
    AND dpp.pokemon_id = p_pokemon_id
    AND dpp.is_in_pool = TRUE
    AND (
      dp.is_active = TRUE
      OR NOT EXISTS (
        SELECT 1 FROM public.draft_pools a
        WHERE a.season_id = v_turn.season_id AND a.is_active = TRUE
      )
    )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That Pokemon is not in the draft pool.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.draft_picks d
    WHERE d.season_id = v_turn.season_id AND d.pokemon_id = p_pokemon_id
  ) THEN
    RAISE EXCEPTION 'That Pokemon has already been drafted.';
  END IF;

  -- Also refuse to re-draft a species already on any roster from earlier data.
  IF EXISTS (
    SELECT 1 FROM public.team_roster r
    JOIN public.teams t ON t.id = r.team_id
    WHERE t.season_id = v_turn.season_id AND r.pokemon_id = p_pokemon_id
  ) THEN
    RAISE EXCEPTION 'That Pokemon is already on a roster.';
  END IF;

  v_cost := 0;
  IF v_enable_costs THEN
    v_cost := v_tier;

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

    IF v_budget IS NULL OR (v_budget - v_spent - v_cost) < 0 THEN
      RAISE EXCEPTION 'This pick would put your salary below 0.';
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public.insert_draft_pick(
    p_league_id, v_turn.season_id, v_turn.team_id, auth.uid(),
    v_turn.round_number, v_turn.pick_in_round, v_turn.overall_pick,
    p_pokemon_id, v_species, v_tier, v_cost, FALSE
  );
  RETURN;
END;
$$;

-- Advances the draft when the current player's timer has expired (or is forced
-- via p_force). With auto_pick_on_timeout it takes the player's highest
-- remaining priority-list Pokemon for the round; otherwise (or when the list is
-- exhausted) it records a pass. Players with a zero remaining salary are
-- auto-skipped as soon as their turn begins, without waiting out the timer.
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

-- Atomically replaces the calling user's priority list for the season from a
-- JSON payload of {round_number, pokemon_id} entries, in display order. The
-- leftmost entry in a round becomes the highest priority (slot_index 0). A
-- Pokemon may appear in multiple rounds but never twice within one round, and
-- every entry must be a Pokemon from the season's draft pool.
CREATE OR REPLACE FUNCTION public.save_priority_list(
  p_league_id UUID,
  p_entries JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_status TEXT;
  v_duplicates INTEGER;
  v_missing INTEGER;
  v_entries_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'The priority list must be an array of entries.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No season exists for this league.';
  END IF;

  IF v_status NOT IN ('draft_pending', 'draft_active') THEN
    RAISE EXCEPTION 'The priority list can only be edited while the draft is pending or active.';
  END IF;

  SELECT COUNT(*) INTO v_duplicates
  FROM (
    SELECT (entry->>'round_number')::INTEGER AS round_number, entry->>'pokemon_id' AS pokemon_id
    FROM jsonb_array_elements(p_entries) AS entry
    WHERE entry->>'pokemon_id' IS NOT NULL AND entry->>'round_number' IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) > 1
  ) doubled;

  IF v_duplicates > 0 THEN
    RAISE EXCEPTION 'A Pokemon cannot appear twice within the same round.';
  END IF;

  -- Every listed Pokemon must exist in the season's pool (active pool, or all
  -- pools when none is active).
  SELECT COUNT(*) INTO v_missing
  FROM (
    SELECT entry->>'pokemon_id' AS pokemon_id
    FROM jsonb_array_elements(p_entries) AS entry
    WHERE entry->>'pokemon_id' IS NOT NULL
    EXCEPT
    SELECT dpp.pokemon_id
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
      )
  ) unlisted;

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'The priority list contains Pokemon that are not in the draft pool.';
  END IF;

  DELETE FROM public.draft_priority_lists
  WHERE season_id = v_season_id AND user_id = v_user_id;

  INSERT INTO public.draft_priority_lists
    (league_id, season_id, user_id, round_number, slot_index, pokemon_id)
  SELECT
    p_league_id,
    v_season_id,
    v_user_id,
    (entry->>'round_number')::INTEGER AS round_number,
    ROW_NUMBER() OVER (
      PARTITION BY entry->>'round_number' ORDER BY ordinality
    ) - 1 AS slot_index,
    entry->>'pokemon_id' AS pokemon_id
  FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS entries(entry, ordinality)
  WHERE entry->>'pokemon_id' IS NOT NULL AND entry->>'round_number' IS NOT NULL
  ORDER BY ordinality;

  GET DIAGNOSTICS v_entries_count = ROW_COUNT;

  RETURN v_entries_count;
END;
$$;

-- Redefines start_draft (from the active-draft-pool migration) so that opening
-- the draft also starts the first player's timer: the arena reads
-- draft_pick_started_at to count down the first pick.
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

-- Default pick order to join order: rank teams by when their owner joined the
-- league (earliest joined_at = owner who created the league = pick 1, next
-- player to accept the invite = pick 2, and so on). Only fills teams whose
-- draft_position is still NULL, so a manually dragged-in position (set on the
-- draftboard) is kept as the override.
UPDATE public.teams t
SET draft_position = sub.new_position
FROM (
  SELECT lm.user_id,
         ROW_NUMBER() OVER (
           PARTITION BY lm.league_id
           ORDER BY lm.joined_at ASC, lm.user_id ASC
         ) AS new_position
  FROM public.league_members lm
  WHERE lm.league_id = p_league_id
    AND lm.is_active = TRUE
) sub
WHERE t.league_id = p_league_id
  AND t.season_id = v_season_id
  AND t.owner_user_id = sub.user_id
  AND t.draft_position IS NULL;

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
  SET status = 'draft_active', draft_started_at = NOW(), draft_pick_started_at = NOW()
  WHERE id = v_season_id;

  RETURN QUERY SELECT v_season_id, 'draft_active';
END;
$$;

-- Keep the write RPCs away from anon and any unauthenticated user; only
-- signed-in league members (enforced inside each function) may call them.
REVOKE ALL ON FUNCTION public.get_draft_turn(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insert_draft_pick(UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.make_draft_pick(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_priority_list(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_draft(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.make_draft_pick(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_priority_list(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_draft(UUID) TO authenticated;

-- Force PostgREST to pick up the new RPC/function signatures immediately so the
-- arena can call them without waiting for a schema-cache refresh.
NOTIFY pgrst, 'reload schema';