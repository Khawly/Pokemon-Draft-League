-- Auto-draft paces its spending so a team can still afford every roster slot.
--
-- Symptom: in a 20 player league with enable_pokemon_costs on, six teams never
-- picked in round 5 and ended short. The tier 1 Pokemon were still sitting in the
-- pool, unclaimed -- the teams simply could not afford them by then, having spent
-- their budget on premium tiers in rounds 1 to 4.
--
-- Cause: the reserve was "one token per roster slot still to come",
--     v_reserve := GREATEST(0, v_min_roster - (v_roster_count + 1))
-- and a flat three token cushion (the preceding migration) is the wrong shape of
-- rule for the same reason. A fixed amount says nothing about whether the budget
-- as a whole can still fund the picks that remain: it is far too small when the
-- roster is expensive to fill, and far too large when the budget is tight.
--
-- Fix: derive the reserve from the budget's own pacing instead of a constant.
-- With v_slots_after picks still to come out of v_remaining tokens, hold back
--
--     v_reserve := v_slots_after * v_remaining / (v_slots_after + 1)
--
-- which caps this pick at exactly the per-pick rate the remaining budget already
-- affords. Spend at or under that rate and the team stays on pace to fill its
-- roster; spend over it and the rest of the draft is behind. Because the gate
-- rejects an over-rate candidate and the loop CONTINUEs to cheaper ones, a team
-- that is behind pace automatically starts taking cheaper picks instead of
-- premium ones it cannot carry.
--
-- This deliberately reads nothing about tiers. It never assumes a tier 1 Pokemon
-- is still available, which is what the flat cushion effectively did.
--
-- On the final pick v_slots_after is 0, so the reserve is 0 and the whole
-- remaining budget is spendable.
--
-- "Slots behind this pick" comes from the league's own total_rounds rather than a
-- hard-coded 6, so a league drafting fewer rounds does not reserve against slots
-- that do not exist.
--
-- The clamp below the reserve is unchanged and still does the important part: if
-- honouring the reserve would leave nothing spendable right now, it is released
-- so the picker can still take an affordable pick rather than pass. Pacing is a
-- preference, never a reason to waste a roster slot.

-- Owner/auto-pick turn resolver: decides whether the on-clock pick is due, then
-- picks for it.
--
-- Budget safety: every pick except the last one is capped at the per-pick rate the
-- team's remaining budget affords (clamped down when even the cheapest pick would
-- breach it), so a team cannot buy a premium early and be unable to field a full
-- roster later. On the final pick the reserve is zero and the full remaining
-- budget is spendable. Both rules apply only when
-- league_settings.enable_pokemon_costs is true; with costs off the affordability
-- gate is skipped entirely, as before.
--
-- Selection order while auto-pick is on: the on-turn player's priority list for
-- this round in slot order, then -- only if nothing there is usable -- a
-- weakness-aware scan of the whole pool (highest tier first, then least overlap
-- with the weaknesses of what the team already drafted, then BST, then name).
-- Each candidate is skipped while it would breach the reserve, so a cheaper pick
-- further down the list wins over an expensive one that would break the cushion.
--
-- p_league_id  league whose turn is resolved.
-- p_force      resolve now regardless of the timer, pause state, or the round
--               flags. Quiet hours still hold; the caller is advance_bot_autopicks.
--
-- Returns the season id and the resulting season status, or 'not_due'.
--
-- SECURITY DEFINER because the on-turn player may be anyone in the league while
-- the writes (draft_picks, team_roster, transactions, seasons) have no client
-- policies.
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
  v_total_rounds INTEGER;
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
  v_slots_after INTEGER := 0;
  v_reserve INTEGER := 0;
  v_quiet RECORD;
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
    COALESCE(ls.auto_pick_on_timeout, FALSE),
    COALESCE(ls.total_rounds, 6)
  INTO v_limit_minutes, v_enable_costs, v_per_team, v_auto_pick, v_total_rounds
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

    /*
     * How many picks this team still gets after the one being resolved.
     * round_number is already this team's Nth pick (get_draft_turn derives it
     * from the overall pick), and total_rounds is the league's own draft
     * length, so this is 0 on the final pick whatever the league's round count
     * is -- which the previous hard-coded six could not guarantee.
     */
    v_slots_after := GREATEST(0, v_total_rounds - v_turn.round_number);

    /*
     * Hold back the share of what is left that the picks still to come need:
     * v_slots_after / (v_slots_after + 1) of it. That caps this pick at the
     * per-pick rate the remaining budget already affords, so spending at or under
     * the cap keeps the team on pace to fill its roster and spending over it puts
     * the rest of the draft behind. Candidates that breach the cap are skipped in
     * favour of cheaper ones, which is how a team that has overspent starts
     * recovering its roster.
     *
     * Integer division floors the reserve, which errs toward letting the pick
     * through; the clamp below catches the cases where that leaves nothing to
     * spend.
     *
     * On the final pick v_slots_after is 0, so the reserve is 0 and the whole
     * remaining budget is spendable. If honouring the reserve would leave nothing
     * spendable right now, clamp it down to release it: pacing is a preference,
     * and the picker must still take an affordable pick rather than pass.
     */
    IF v_slots_after > 0 THEN
      v_reserve := (v_slots_after * COALESCE(v_remaining, 0)) / (v_slots_after + 1);
    ELSE
      v_reserve := 0;
    END IF;
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