-- One-pass weakness scoring for the draft auto-pick fallback
--
-- Recreates resolve_draft_timeout with the pool fallback's defensive scoring
-- rewritten from a correlated subquery per available Pokemon to a single
-- pre-aggregated join. Behavior is unchanged: worst_share is still the largest
-- number of the team's drafted Pokemon that share any one of the candidate's
-- weaknesses, and the phase-dependent ORDER BY still leads on tier in rounds one
-- and two and on the weakness bucket from round three.
--
-- Why it matters: on the TL 2.1 pool the old shape ran the inner aggregate about
-- 3,300 times per pick and took roughly 6.7 s against a 1,073-entry pool. A
-- human pick that hands the clock to a run of bots settles those bots inside the
-- same transaction (insert_draft_pick -> advance_bot_autopicks), so eighteen
-- bots at ~7 s each exceeded the resolver's 60 s statement budget. The whole
-- transaction rolled back, including the human pick that triggered it, and every
-- open draft page retried once a second while the heartbeat retried every 15 s,
-- so the resolvers queued behind each other's row locks and the clock froze on
-- that pick. The join form returns the same ranking in ~0.17 s, which keeps a
-- full bot chain inside the budget.
--
-- The body below matches the definition live in the project at the time of the
-- change; only the scored CTE and its supporting team_weakness_counts CTE differ.
CREATE OR REPLACE FUNCTION public.resolve_draft_timeout(p_league_id uuid, p_force boolean DEFAULT false)
 RETURNS TABLE(season_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_tier1_left INTEGER := 0;
  v_cheapest_tier INTEGER;
  v_token_floor INTEGER := 0;
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
   * The timer is parked so the player keeps the pick time they had left when the
   * window opened: R = (started_at + limit) - window_start, and the new deadline
   * is window_end + R. The new start stamp is that deadline minus the limit,
   * because deadline = draft_pick_started_at + limit is how every reader
   * reconstructs it.
   *
   * The guard keys on the deadline rather than on the stamp, which is what makes
   * the shift happen exactly once. window_end + R is never before window_end, so
   * once applied the condition is false and later sweeps inside the same window
   * leave it alone. Guarding on the stamp instead would re-apply the shift every
   * sweep and inflate the remaining time by the window length each time, because
   * each pass would re-read the stamp the previous pass had already moved.
   */
  SELECT * INTO v_quiet
  FROM public.draft_quiet_hours(p_season_id := v_turn.season_id);

  IF v_quiet.in_quiet THEN
    IF v_started_at IS NOT NULL
      AND v_started_at + make_interval(mins => v_limit_minutes) < v_quiet.window_end
    THEN
      UPDATE public.seasons s
      SET draft_pick_started_at = v_quiet.window_end + GREATEST(
        0::INTERVAL,
        (v_started_at + make_interval(mins => v_limit_minutes)) - v_quiet.window_start
      ) - make_interval(mins => v_limit_minutes)
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
     * Reserve, split by phase to match the split in the sort order.
     *
     * Rounds one and two: premium opening. Reserve only the tail, meaning what
     * every remaining pick would cost at the cheapest tier currently in the pool.
     * That is the floor the later picks need, so the opening picks can take the
     * best available without stranding the roster.
     *
     * Round three onward: even pacing. Holding back slots_after / (slots_after+1)
     * of what is left caps this pick at the per-pick rate the remaining budget
     * affords, so spending at or under it keeps the team on pace to fill its
     * roster. Candidates that breach the cap are skipped in favour of cheaper
     * ones, which is how a team that has overspent recovers.
     *
     * Why the opening needed changing: the even pacing cap is a flat
     * budget / total_rounds ceiling, because at round one slots_after is
     * total_rounds - 1. On a 33 token budget over 6 rounds that ceiling is 5.5,
     * so no ordering could have reached tier 11 in the opening rounds. Reserving
     * the tail instead lifts the ceiling to roughly budget minus the cost of
     * picking the rest at the pool's cheapest tier.
     *
     * Integer division floors the pacing reserve, which errs toward letting the
     * pick through; the clamp below catches the cases where that leaves nothing
     * to spend.
     *
     * On the final pick v_slots_after is 0, so the reserve is 0 and the whole
     * remaining budget is spendable.
     */
    IF v_slots_after > 0 THEN
      IF v_turn.round_number <= 2 THEN
        SELECT MIN(dpp.tier_value) INTO v_cheapest_tier
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
          );

        v_reserve := v_slots_after * COALESCE(v_cheapest_tier, 0);
      ELSE
        v_reserve := (v_slots_after * COALESCE(v_remaining, 0)) / (v_slots_after + 1);
      END IF;
    ELSE
      v_reserve := 0;
    END IF;

    /*
     * A tier 1 dependent floor from the third pick on.
     *
     * The pacing reserve above says nothing about the shape of the pool, but the
     * pool decides what the remaining picks cost: while a tier 1 is still waiting
     * for every pick that remains, the endgame is cheap and holding a little back
     * is enough. Once the pool no longer has that much left, the remaining picks
     * are dearer, so bank one more token.
     *
     * Guarded on v_slots_after > 0 because the floor exists to keep the picks
     * still to come affordable. On the final pick there are none, and applying it
     * there would hold tokens back from the one pick that has nothing left to
     * protect, which could cost the roster slot outright.
     */
    IF v_turn.round_number >= 3 AND v_slots_after > 0 THEN
      SELECT COUNT(*)::INTEGER INTO v_tier1_left
      FROM public.draft_pool_pokemon dpp
      JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
      WHERE dp.season_id = v_turn.season_id
        AND dpp.is_in_pool = TRUE
        AND dpp.tier_value = 1
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
        );

      v_token_floor := CASE WHEN v_tier1_left > v_slots_after THEN 3 ELSE 4 END;
      v_reserve := GREATEST(v_reserve, v_token_floor);
    END IF;

    /*
     * Clamp: if honouring the reserve would leave nothing spendable right now,
     * release it so the picker can still take an affordable pick rather than
     * pass. Pacing and the floor are preferences, never a reason to waste a
     * roster slot.
     */
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
  -- when the round's priority list has no remaining candidates ΓÇö the pool
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
        /*
         * The priority list is the player's own ordering, so the token reserve
         * does not apply to it -- only hard affordability does. Applying the
         * reserve here meant a large early reserve rejected every listed Pokemon,
         * and once the whole list was rejected the code fell through to the pool
         * scan below and discarded the list entirely. Requiring only that the
         * pick be affordable matches what the human path (make_draft_pick)
         * enforces, so auto-pick is no longer stricter than picking by hand.
         */
        IF v_cost > COALESCE(v_remaining, 0) THEN
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
      team_weakness_counts AS (
        SELECT weakness_type, COUNT(DISTINCT team_poke) AS share
        FROM team_weakness
        GROUP BY weakness_type
      ),
      scored AS (
        SELECT a.pokemon_id, a.species_name, a.tier_value, a.bst,
          /*
           * How many of the Pokemon the team already drafted share at least one
           * weakness with this candidate -- measured at the candidate's WORST
           * weakness, not its best.
           *
           * Grouping team_weakness by weakness_type inside the subquery gives one
           * count per weakness the candidate has; MAX of those is the worst
           * overlap. 0 means the candidate duplicates nothing on the roster.
           *
           * The previous form joined to candidate_weakness, giving one row per
           * weakness of each candidate, and counted only that row's weakness, so
           * the outer MAX was vacuous and the duplicate rows let the final ORDER
           * BY sort on the candidate's smallest count: a Fire/Water Pokemon that
           * repeated the team's Fire weakness but had an unused Water weakness
           * scored 0 and read as complementary. One row per available Pokemon
           * also keeps a Pokemon with no weaknesses selectable at all, which the
           * inner join had been silently excluding.
           */
          /*
           * How many of the Pokemon the team already drafted share at least one
           * weakness with this candidate -- measured at the candidate's WORST
           * weakness, not its best. MAX of the per-weakness counts is the worst
           * overlap; 0 means the candidate duplicates nothing on the roster.
           *
           * This used to be a correlated subquery per available Pokemon that
           * re-scanned team_weakness for that row's weaknesses. On a 1,000-entry
           * pool it ran about 3,300 times per pick and took seconds; a bot chain
           * then blew past the resolver's 60 s statement budget and rolled the
           * whole transaction back, freezing the draft. Aggregating team_weakness
           * once and joining it gives the same answer in one pass.
           */
          COALESCE(MAX(twc.share), 0) AS worst_share
        FROM available a
        LEFT JOIN candidate_weakness cw ON cw.pokemon_id = a.pokemon_id
        LEFT JOIN team_weakness_counts twc
          ON twc.weakness_type = cw.weakness_type
        GROUP BY a.pokemon_id, a.species_name, a.tier_value, a.bst
      )
      SELECT s.pokemon_id, s.species_name, s.tier_value
      FROM scored s
      ORDER BY
        /*
         * Phase dependent, and this is the whole point of the sort.
         *
         * Rounds one and two emit a constant 0 for every candidate, so the sort
         * degenerates to tier_value DESC with the weakness score as a tie-break:
         * the draft opens on the best Pokemon in the pool, as intended.
         *
         * From round three the weakness bucket leads and tier breaks ties inside
         * it, so the back half of the draft builds a defensive profile instead of
         * repeating one.
         *
         * A bucket of 0 is a candidate that shares no weakness with anything the
         * team already drafted, which also means nothing of the earlier picks'
         * defensive profile is left uncovered.
         */
        (
          CASE
            WHEN v_turn.round_number <= 2 THEN 0
            WHEN s.worst_share = 0 THEN 1
            WHEN s.worst_share = 1 THEN 2
            ELSE 3
          END
        ) ASC,
        s.tier_value DESC,
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
$function$
-- Keep the resolver callable only by signed-in users, as before; the grants are
-- unchanged by CREATE OR REPLACE but restating them keeps a fresh apply correct.
REVOKE ALL ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) TO authenticated;