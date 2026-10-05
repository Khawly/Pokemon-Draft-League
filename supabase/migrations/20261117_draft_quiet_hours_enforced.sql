-- Enforces quiet hours on the live draft, and gives them a real time zone
--
-- Quiet hours have been configurable since the initial schema: the draft settings
-- page writes quiet_hours_enabled plus the two wall clocks, and the columns were
-- there. Nothing ever read them. resolve_draft_timeout only consulted
-- seasons.draft_paused_at, which is the owner's manual Pause button, so a league
-- that set quiet hours watched the pick timer run straight through them and the
-- timeout auto-pick fire at 2am exactly as it would at 2pm.
--
-- The two clock columns are also named `_est`, which described an intent nobody
-- had implemented: they are bare TEXT wall clocks with no zone, so a 20:00-09:00
-- window had no defined meaning. A zone column is added here and backfilled from
-- the league owner's profile timezone, which is where the person configuring the
-- league already keeps the zone they think in.
--
-- Enforcement is deliberately ahead of every "the turn is due" escalation in
-- resolve_draft_timeout and ignores p_force, because advance_bot_autopicks calls
-- the resolver with p_force = TRUE and would otherwise chain bots straight
-- through the window.

-- The zone the quiet_hours_start/end wall clocks are expressed in. Falls back to
-- UTC in the helper rather than defaulting here, so a row written before this
-- migration still resolves to a definite window instead of a null one.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS quiet_hours_timezone TEXT;

-- Backfill from the owner's profile timezone, which is where the person who set
-- the window keeps their own zone. Left null where the owner has no profile row,
-- so the helper falls back to UTC.
UPDATE public.league_settings ls
SET quiet_hours_timezone = p.timezone
FROM public.leagues l
JOIN public.profiles p ON p.id = l.owner_id
WHERE l.id = ls.league_id
  AND ls.quiet_hours_timezone IS NULL;

-- Resolves whether NOW() falls inside the season's quiet hours, and if so when the
-- window opened and closes.
--
-- Returns the instants as well as the flag because resolve_draft_timeout has to
-- park the pick timer at the window's end, and needs to know where the window
-- began to work out how much pick time the player had left when it did.
--
-- Handles both a window inside one local day (09:00-17:00) and one that wraps past
-- midnight (20:00-09:00), which is the case the default settings use and the one
-- that has to be right for the feature to be worth anything.
--
-- @param p_season_id - The season whose league settings carry the window.
-- @returns in_quiet, plus window_start/window_end as instants, all NULL when out.
CREATE OR REPLACE FUNCTION public.draft_quiet_hours(
  p_season_id UUID
)
RETURNS TABLE (in_quiet BOOLEAN, window_start TIMESTAMPTZ, window_end TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_start_clock TEXT;
  v_end_clock TEXT;
  v_tz TEXT;
  v_start TIME;
  v_end TIME;
  v_today DATE;
  v_local_now TIME;
BEGIN
  SELECT
    COALESCE(ls.quiet_hours_enabled, FALSE),
    NULLIF(BTRIM(ls.quiet_hours_start_est), ''),
    NULLIF(BTRIM(ls.quiet_hours_end_est), ''),
    COALESCE(NULLIF(BTRIM(ls.quiet_hours_timezone), ''), 'UTC')
  INTO v_enabled, v_start_clock, v_end_clock, v_tz
  FROM public.league_settings ls
  WHERE ls.season_id = p_season_id;

  IF NOT v_enabled OR v_start_clock IS NULL OR v_end_clock IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- A malformed clock must not take the draft engine down with it, and must not
  -- silently read as "always quiet" either.
  BEGIN
    v_start := v_start_clock::TIME;
    v_end := v_end_clock::TIME;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END;

  -- Equal bounds would describe a window that is either always open or never
  -- open. Never is the safe reading: a typo that paused the league's draft
  -- indefinitely would be far worse than one that did nothing.
  IF v_start = v_end THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_today := (NOW() AT TIME ZONE v_tz)::DATE;
  v_local_now := (NOW() AT TIME ZONE v_tz)::TIME;

  IF v_start < v_end THEN
    IF v_local_now >= v_start AND v_local_now < v_end THEN
      RETURN QUERY SELECT TRUE,
        ((v_today)::TIMESTAMP + v_start) AT TIME ZONE v_tz,
        ((v_today)::TIMESTAMP + v_end) AT TIME ZONE v_tz;
    ELSE
      RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    END IF;
    RETURN;
  END IF;

  -- Wraps past midnight, so the window opened on the previous local day.
  IF v_local_now >= v_start THEN
    RETURN QUERY SELECT TRUE,
      ((v_today)::TIMESTAMP + v_start) AT TIME ZONE v_tz,
      (((v_today + 1))::TIMESTAMP + v_end) AT TIME ZONE v_tz;
  ELSIF v_local_now < v_end THEN
    RETURN QUERY SELECT TRUE,
      (((v_today - 1))::TIMESTAMP + v_start) AT TIME ZONE v_tz,
      ((v_today)::TIMESTAMP + v_end) AT TIME ZONE v_tz;
  ELSE
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.draft_quiet_hours(UUID) FROM PUBLIC;

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
  v_quiet RECORD;
  v_min_roster CONSTANT INTEGER := 6;
BEGIN
  -- The full resolution (fallback scan + bot chain it can spawn) routinely
  -- outruns the anon/authenticated role statement_timeout caps PostgREST
  -- applies to RPCs; a canceled resolve rolls back the pick and hangs the
  -- draft. Lift the budget for this transaction so the pick always commits.
  PERFORM set_config('statement_timeout', '60000', true);
  PERFORM set_config('lock_timeout', '45000', true);

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

  /*
   * Quiet hours hold the draft for the length of the window, and deliberately
   * ignore p_force. The force flag exists so advance_bot_autopicks can settle a
   * bot's turn immediately, and a league that set quiet hours would reasonably
   * expect the bots to be asleep too rather than the window only holding back
   * human timers.
   *
   * A human is still free to pick during quiet hours: make_draft_pick has no gate,
   * because the point of the window is not to be forced to pick, it is not to be
   * made to.
   *
   * The timer is parked at the window's end rather than simply frozen, keeping the
   * pick time the player had left when the window opened, which is the same thing
   * set_draft_paused does on resume. Guarded on the start stamp still being before
   * the window opened, so the shift happens once: after it, the stamp sits at or
   * after window_start and the condition is false, so repeated sweeps cannot walk
   * the deadline further forward on every tick.
   */
  SELECT * INTO v_quiet
  FROM public.draft_quiet_hours(p_season_id := v_turn.season_id);

  IF v_quiet.in_quiet THEN
    IF v_started_at IS NOT NULL AND v_started_at < v_quiet.window_start THEN
      UPDATE public.seasons s
      SET draft_pick_started_at = v_quiet.window_end - GREATEST(
        0::INTERVAL,
        (v_started_at + make_interval(mins => v_limit_minutes)) - v_quiet.window_start
      )
      WHERE s.id = v_turn.season_id;
    END IF;

    RETURN QUERY SELECT v_turn.season_id, 'not_due';
    RETURN;
  END IF;

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
REVOKE ALL ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) TO authenticated;

-- Force PostgREST to pick up the new function bodies immediately.
NOTIFY pgrst, 'reload schema';