-- Auto-draft: restore tier-first picking in the first two rounds, and fix the
-- weakness-overlap score that decides which Pokemon are compatible.
--
-- Two changes to the pool scan in the resolver. Both apply only in leagues with
-- enable_pokemon_costs on, and neither touches the priority list path.
--
-- 1. Rounds one and two go for the highest tier again.
--    20261123 made the weakness bucket the primary sort key for every round, on
--    the reading that typing should lead everywhere. That is right for the back
--    half of a draft and wrong for the opening: in round two a tier 2 Pokemon
--    with no shared weakness outranked a tier 11 one that shared a single
--    weakness, so the picker stopped taking the best available picks early. The
--    first sort key is now phase dependent. Rounds one and two sort a constant
--    key first and so degenerate to tier_value DESC with the weakness score as
--    the tie-break, which is the intended "take the best available early". From
--    round three the weakness bucket leads and tier breaks ties inside it, so the
--    second half of the draft keeps building a defensive profile instead of
--    repeating one.
--
-- 2. worst_share now measures the candidate's worst weakness, not its best.
--    The scored CTE joined available to candidate_weakness, which yields one row
--    per weakness of each candidate, and the correlated subquery counted only
--    the team Pokemon sharing that particular weakness:
--
--        SELECT MAX(shared) FROM (
--          SELECT COUNT(DISTINCT tw.team_poke) AS shared
--          FROM team_weakness tw
--          WHERE tw.weakness_type = cw.weakness_type
--        ) s
--
--    The inner query aggregates without GROUP BY, so it returns exactly one row
--    and the outer MAX is vacuous. Worse, the duplicate rows meant the final
--    ORDER BY saw the candidate once per weakness and sorted on the smallest of
--    those counts, so a Pokemon that badly duplicated one weakness was judged by
--    whatever other weakness of its happened to be unused by the team. A Fire /
--    Water Pokemon whose Fire weakness repeated the roster but whose Water
--    weakness nobody shared scored 0 and was treated as perfectly complementary,
--    which is how rosters ended up with three Pokemon sharing a weakness.
--
--    The rewrite aggregates per weakness type inside the subquery and takes the
--    MAX of those, so the score is the worst overlap across the candidate's own
--    weaknesses. It also drops the join to candidate_weakness, which returns one
--    row per available Pokemon: a Pokemon with no weaknesses at all now scores 0
--    and stays selectable instead of being excluded by the inner join.
--
-- The priority list path, the pacing reserve, the tier 1 dependent token floor and
-- the clamp are all unchanged from 20261123. One consequence worth knowing: the
-- pool scan's token reserve can still push the picker onto a cheaper, worse-typed
-- Pokemon when the well-typed option is out of budget. That is the roster-fill
-- guarantee doing its job, and it is the reason to raise a league's budget
-- rather than to relax the typing rule.

-- Owner/auto-pick turn resolver: decides whether the on-clock pick is due, then
-- picks for it.
--
-- Selection order while auto-pick is on: the on-turn player's priority list for
-- this round in slot order, skipping only entries the team cannot afford, then --
-- only if nothing there is usable -- a scan of the whole pool. The pool scan is
-- phase dependent: rounds one and two take the highest tier available, with the
-- defensive weakness score only breaking ties, so the draft opens on the best
-- Pokemon in the pool. From round three the weakness score leads and tier breaks
-- ties inside each bucket, so later picks avoid repeating the weaknesses already
-- on the roster. Remaining ties fall back to BST, then name.
--
-- Budget safety, both applied only when league_settings.enable_pokemon_costs is
-- true: the pool scan is capped at the per-pick rate the team's remaining budget
-- affords, and from round three it also holds a 3 or 4 token floor depending on
-- how many unclaimed tier 1 Pokemon are left. With costs off the affordability
-- gate is skipped entirely, as before.
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
  v_tier1_left INTEGER := 0;
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
          COALESCE((
            SELECT MAX(share)
            FROM (
              SELECT COUNT(DISTINCT tw.team_poke) AS share
              FROM team_weakness tw
              WHERE tw.weakness_type IN (
                SELECT cw.weakness_type
                FROM candidate_weakness cw
                WHERE cw.pokemon_id = a.pokemon_id
              )
              GROUP BY tw.weakness_type
            ) s
          ), 0) AS worst_share
        FROM available a
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
$$;
REVOKE ALL ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_draft_timeout(UUID, BOOLEAN) TO authenticated;

-- Force PostgREST to pick up the new function bodies immediately.
NOTIFY pgrst, 'reload schema';