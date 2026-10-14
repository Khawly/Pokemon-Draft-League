-- Lets generate_playoff_round read its own frozen bracket back out of JSON.
--
-- The function stores its seeded teams, losers' pool and waiting champion in
-- league_settings.playoff_state_json as a jsonb array of UUIDs, written with
-- to_jsonb(uuid[]). Reading them back went through:
--
--   (v_state -> 'seeds' -> v_i)::text::uuid
--
-- '->' with an integer subscript yields jsonb, not text, and casting jsonb to text
-- returns the value's JSON representation -- so the quotes stayed on. The cast then
-- tried to parse the string "c4f08220-..." including its quote characters:
--
--   invalid input syntax for type uuid: ""c4f08220-2625-4745-9e64-8cd470e24848""
--
-- The branch is only reached once the seeds have been written, which is why the
-- first "Advance playoffs" click succeeded and every one after it failed. Only the
-- seeding path was exercised in testing; reading a frozen bracket back was not.
--
-- Three sites had it, not one. Seeds is the upper bracket, but this league runs
-- double_elimination, where 'lower_pool' and 'wait' are read on later rounds and
-- would have failed the same way partway through the bracket.
--
-- '->>' is the operator that extracts a jsonb scalar as SQL text, so the quotes are
-- gone before the cast ever sees the value. The JSON is unchanged, so brackets seeded
-- by the broken version read back correctly with no data repair needed.

CREATE OR REPLACE FUNCTION public.generate_playoff_round(p_league_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_season_status TEXT;
  v_playoff_teams INTEGER;
  v_playoff_format TEXT;
  v_base_weeks INTEGER;
  v_bracket INTEGER;
  v_rounds INTEGER;
  v_pool_count INTEGER;
  v_seed_order INTEGER[];
  v_seed_position INTEGER;
  v_seed_teams UUID[];
  v_state JSONB;
  v_survivors UUID[];
  v_survivors_next UUID[];
  v_r INTEGER;
  v_i INTEGER;
  v_j INTEGER;
  v_count INTEGER := 0;
  v_slot UUID;
  v_num_pairs INTEGER;
  v_winner UUID;
  v_team_a UUID;
  v_team_b UUID;
  v_week INTEGER;
  v_existing INTEGER;
  v_lower_seq INTEGER;
  v_lower_pool UUID[];
  v_pending INTEGER;
  v_wait UUID;
  v_last_consumed INTEGER;
  v_new_losers UUID[];
  v_combined UUID[];
  v_pair_list UUID[];
  v_upper_champion UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to manage the playoff bracket.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can manage the playoff bracket.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_season_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  IF v_season_status <> 'draft_complete' THEN
    RAISE EXCEPTION 'The playoff bracket unlocks once the draft is complete.';
  END IF;

  SELECT COALESCE(playoff_team_count, 0), COALESCE(playoff_format, 'single_elimination'), COALESCE(regular_season_weeks, 0)
  INTO v_playoff_teams, v_playoff_format, v_base_weeks
  FROM public.league_settings
  WHERE season_id = v_season_id;

  IF v_playoff_teams < 2 THEN
    RAISE EXCEPTION 'Configure playoff teams before generating the bracket.';
  END IF;

  -- Bracket size is the next power of two above the playoff field; rounds are
  -- log2 of that size (upper rounds 1..R, round R is the winner's final).
  v_bracket := 1;
  WHILE v_bracket < v_playoff_teams LOOP
    v_bracket := v_bracket * 2;
  END LOOP;
  v_rounds := 0;
  v_pool_count := v_bracket;
  WHILE v_pool_count > 1 LOOP
    v_pool_count := v_pool_count / 2;
    v_rounds := v_rounds + 1;
  END LOOP;

  v_state := COALESCE(
    (SELECT playoff_state_json FROM public.league_settings WHERE season_id = v_season_id),
    '{}'::jsonb
  );

  -- Seed the bracket from standings once; freeze it so later results cannot
  -- reshuffle the tree mid-playoffs.
  v_seed_teams := ARRAY[]::uuid[];
  IF jsonb_typeof(v_state -> 'seeds') = 'array' AND jsonb_array_length(v_state -> 'seeds') >= v_playoff_teams THEN
    FOR v_i IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seed_teams := v_seed_teams || ARRAY[(v_state -> 'seeds' ->> v_i)::uuid]::uuid[];
    END LOOP;
  END IF;

  IF array_length(v_seed_teams, 1) IS NULL THEN
    SELECT ARRAY_AGG(st.team_id ORDER BY st.wins DESC, st.losses ASC, st.ko_diff DESC, st.team_name ASC) INTO v_seed_teams
    FROM public.season_standings(p_league_id) st;

    IF v_seed_teams IS NULL THEN
      RAISE EXCEPTION 'No teams exist to seed the playoff bracket.';
    END IF;

    IF array_length(v_seed_teams, 1) < v_playoff_teams THEN
      RAISE EXCEPTION 'The playoffs need at least % teams with a record.', v_playoff_teams;
    END IF;

    v_seed_teams := v_seed_teams[1:v_playoff_teams];
    v_state := jsonb_set(v_state, '{seeds}', to_jsonb(v_seed_teams));
  END IF;

  v_seed_order := public.playoff_seed_order(v_bracket);

  -- -------- upper bracket --------
  v_survivors := ARRAY[]::uuid[];
  FOR v_r IN 1..v_rounds LOOP
    v_week := v_base_weeks + v_r;

    IF v_r = 1 THEN
      -- Round one participants are the seeded teams at their bracket
      -- positions; positions beyond the field are first-round byes.
      v_survivors := ARRAY[]::uuid[];
      FOR v_i IN 1..v_bracket LOOP
        v_seed_position := v_seed_order[v_i];
        IF v_seed_position <= v_playoff_teams THEN v_slot := v_seed_teams[v_seed_position];
        ELSE v_slot := NULL;
        END IF;
        v_survivors := array_append(v_survivors, v_slot);
      END LOOP;
    ELSIF EXISTS (SELECT 1 FROM unnest(v_survivors) u WHERE u IS NULL) THEN
      EXIT;
    END IF;

    SELECT COUNT(*) INTO v_existing
    FROM public.matches m
    WHERE m.league_id = p_league_id AND m.season_id = v_season_id
      AND m.is_playoff AND m.bracket_phase = 'upper' AND m.week_number = v_week;

    IF v_existing > 0 THEN
      -- Wait for this round to finish before advancing survivors.
      IF EXISTS (
        SELECT 1 FROM public.matches m
        WHERE m.league_id = p_league_id AND m.season_id = v_season_id
          AND m.is_playoff AND m.bracket_phase = 'upper' AND m.week_number = v_week
          AND (m.status <> 'completed' OR m.winner_team_id IS NULL)
      ) THEN
        EXIT;
      END IF;

      v_survivors_next := ARRAY[]::uuid[];
      v_num_pairs := array_length(v_survivors, 1) / 2;
      FOR v_j IN 1..v_num_pairs LOOP
        v_team_a := v_survivors[2 * v_j - 1];
        v_team_b := v_survivors[2 * v_j];
        IF v_team_a IS NOT NULL AND v_team_b IS NOT NULL THEN
          SELECT m2.winner_team_id INTO v_winner
          FROM public.matches m2
          WHERE m2.league_id = p_league_id AND m2.season_id = v_season_id
            AND m2.is_playoff AND m2.bracket_phase = 'upper' AND m2.week_number = v_week
            AND ((m2.player_1_team_id = v_team_a AND m2.player_2_team_id = v_team_b)
              OR (m2.player_1_team_id = v_team_b AND m2.player_2_team_id = v_team_a))
          LIMIT 1;
          v_survivors_next := array_append(v_survivors_next, v_winner);
        ELSE
          -- A first-round bye simply advances its team.
          v_survivors_next := array_append(v_survivors_next, COALESCE(v_team_a, v_team_b));
        END IF;
      END LOOP;
      v_survivors := v_survivors_next;
      CONTINUE;
    END IF;

    -- Create this round from the current survivors, then stop for results.
    v_num_pairs := array_length(v_survivors, 1) / 2;
    FOR v_j IN 1..v_num_pairs LOOP
      v_team_a := v_survivors[2 * v_j - 1];
      v_team_b := v_survivors[2 * v_j];
      IF v_team_a IS NULL OR v_team_b IS NULL THEN
        CONTINUE;
      END IF;
      INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES (p_league_id, v_season_id, v_week, TRUE, v_team_a, v_team_b, 'scheduled', 'upper');
      v_count := v_count + 1;
    END LOOP;

    UPDATE public.league_settings SET playoff_state_json = v_state, updated_at = NOW() WHERE season_id = v_season_id;
    RETURN v_count;
  END LOOP;

  -- -------- single elimination is complete here --------
  IF v_playoff_format = 'single_elimination' THEN
    UPDATE public.league_settings SET playoff_state_json = v_state, updated_at = NOW() WHERE season_id = v_season_id;
    RETURN v_count;
  END IF;

  -- -------- double elimination: lower bracket + grand final --------
  v_lower_seq := 0;
  v_pending := 0;
  v_last_consumed := 0;
  IF jsonb_typeof(v_state -> 'lower_seq') = 'number' THEN v_lower_seq := (v_state -> 'lower_seq')::int; END IF;
  IF jsonb_typeof(v_state -> 'pending') = 'number' THEN v_pending := (v_state -> 'pending')::int; END IF;
  IF jsonb_typeof(v_state -> 'last_consumed') = 'number' THEN v_last_consumed := (v_state -> 'last_consumed')::int; END IF;

  v_lower_pool := ARRAY[]::uuid[];
  IF jsonb_typeof(v_state -> 'lower_pool') = 'array' THEN
    FOR v_i IN 0..(jsonb_array_length(v_state -> 'lower_pool') - 1) LOOP
      v_lower_pool := v_lower_pool || ARRAY[(v_state -> 'lower_pool' ->> v_i)::uuid]::uuid[];
    END LOOP;
  END IF;

  v_wait := NULL;
  IF jsonb_typeof(v_state -> 'wait') = 'array' AND jsonb_array_length(v_state -> 'wait') > 0 THEN
    v_wait := (v_state -> 'wait' ->> 0)::uuid;
  END IF;

  -- Resolve a pending (previously created) lower round before scheduling more.
  IF v_pending > 0 THEN
    v_week := v_base_weeks + v_rounds + v_pending;
    IF EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.is_playoff AND m.bracket_phase = 'lower' AND m.week_number = v_week
        AND (m.status <> 'completed' OR m.winner_team_id IS NULL)
    ) THEN
      UPDATE public.league_settings SET playoff_state_json = v_state, updated_at = NOW() WHERE season_id = v_season_id;
      RETURN v_count;
    END IF;

    SELECT ARRAY_AGG(m.winner_team_id ORDER BY m.created_at ASC) INTO v_lower_pool
    FROM public.matches m
    WHERE m.league_id = p_league_id AND m.season_id = v_season_id
      AND m.is_playoff AND m.bracket_phase = 'lower' AND m.week_number = v_week
      AND m.winner_team_id IS NOT NULL;

    IF v_lower_pool IS NULL THEN v_lower_pool := ARRAY[]::uuid[]; END IF;
    IF v_wait IS NOT NULL THEN
      v_lower_pool := v_lower_pool || ARRAY[v_wait]::uuid[];
    END IF;
    v_wait := NULL;
    v_pending := 0;
  END IF;

  -- Digest each newly completed upper round's losers into the lower bracket.
  FOR v_r IN (v_last_consumed + 1)..v_rounds LOOP
    IF EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.is_playoff AND m.bracket_phase = 'upper' AND m.week_number = v_base_weeks + v_r
        AND (m.status <> 'completed' OR m.winner_team_id IS NULL)
    ) THEN
      EXIT;
    END IF;

    SELECT ARRAY_AGG(
      CASE WHEN m.player_1_team_id = m.winner_team_id THEN m.player_2_team_id
           WHEN m.player_2_team_id = m.winner_team_id THEN m.player_1_team_id END
      ORDER BY m.created_at ASC) INTO v_new_losers
    FROM public.matches m
    WHERE m.league_id = p_league_id AND m.season_id = v_season_id
      AND m.is_playoff AND m.bracket_phase = 'upper' AND m.week_number = v_base_weeks + v_r;

    v_new_losers := COALESCE(v_new_losers, ARRAY[]::uuid[]);
    v_combined := v_lower_pool || v_new_losers;

    IF array_length(v_combined, 1) < 2 THEN
      v_lower_pool := v_combined;
      v_last_consumed := v_r;
      CONTINUE;
    END IF;

    v_pair_list := ARRAY[]::uuid[];
    IF array_length(v_combined, 1) % 2 = 1 THEN
      -- Odd group: keep the newest arrival waiting while the rest pair off.
      v_wait := v_combined[array_length(v_combined, 1)];
      FOR v_i IN 1..(array_length(v_combined, 1) - 1) LOOP
        v_pair_list := array_append(v_pair_list, v_combined[v_i]);
      END LOOP;
    ELSE
      v_pair_list := v_combined;
    END IF;

    v_lower_seq := v_lower_seq + 1;
    v_week := v_base_weeks + v_rounds + v_lower_seq;
    FOR v_i IN 1..(array_length(v_pair_list, 1) / 2) LOOP
      v_team_a := v_pair_list[2 * v_i - 1];
      v_team_b := v_pair_list[2 * v_i];
      INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES (p_league_id, v_season_id, v_week, TRUE, v_team_a, v_team_b, 'scheduled', 'lower');
      v_count := v_count + 1;
    END LOOP;

    v_pending := v_lower_seq;
    v_last_consumed := v_r;
    v_lower_pool := ARRAY[]::uuid[];

    v_state := jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
      v_state,
      '{lower_seq}', to_jsonb(v_lower_seq)),
      '{pending}', to_jsonb(v_pending)),
      '{last_consumed}', to_jsonb(v_last_consumed)),
      '{lower_pool}', to_jsonb(v_lower_pool)),
      '{wait}', CASE WHEN v_wait IS NULL THEN '[]'::jsonb ELSE to_jsonb(ARRAY[v_wait::text]) END);

    UPDATE public.league_settings SET playoff_state_json = v_state, updated_at = NOW() WHERE season_id = v_season_id;
    RETURN v_count;
  END LOOP;

  -- When all upper rounds are consumed, pair off any leftover lower survivors,
  -- then crown the grand final between the upper and lower champions.
  IF v_last_consumed >= v_rounds AND v_pending = 0 THEN
    IF array_length(v_lower_pool, 1) >= 2 THEN
      v_lower_seq := v_lower_seq + 1;
      v_week := v_base_weeks + v_rounds + v_lower_seq;
      v_num_pairs := array_length(v_lower_pool, 1) / 2;
      IF array_length(v_lower_pool, 1) % 2 = 1 THEN
        -- Defensive: keep the odd team out waiting so it pairs next call.
        v_wait := v_lower_pool[array_length(v_lower_pool, 1)];
        v_num_pairs := (array_length(v_lower_pool, 1) - 1) / 2;
      END IF;
      FOR v_i IN 1..v_num_pairs LOOP
        v_team_a := v_lower_pool[2 * v_i - 1];
        v_team_b := v_lower_pool[2 * v_i];
        INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
        VALUES (p_league_id, v_season_id, v_week, TRUE, v_team_a, v_team_b, 'scheduled', 'lower');
        v_count := v_count + 1;
      END LOOP;
      v_pending := v_lower_seq;
      v_lower_pool := ARRAY[]::uuid[];
    ELSIF array_length(v_lower_pool, 1) = 1 THEN
      SELECT m.winner_team_id INTO v_upper_champion
      FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.is_playoff AND m.bracket_phase = 'upper' AND m.week_number = v_base_weeks + v_rounds
      LIMIT 1;

      IF EXISTS (
        SELECT 1 FROM public.matches m
        WHERE m.league_id = p_league_id AND m.season_id = v_season_id
          AND m.is_playoff AND m.bracket_phase = 'gf'
      ) THEN
        UPDATE public.league_settings SET playoff_state_json = v_state, updated_at = NOW() WHERE season_id = v_season_id;
        RETURN v_count;
      END IF;

      INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES (p_league_id, v_season_id, v_base_weeks + v_rounds + v_lower_seq + 1, TRUE, v_upper_champion, v_lower_pool[1], 'scheduled', 'gf');
      v_count := v_count + 1;
      v_lower_pool := ARRAY[]::uuid[];
    END IF;
  END IF;

  v_state := jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    v_state,
    '{lower_seq}', to_jsonb(v_lower_seq)),
    '{pending}', to_jsonb(v_pending)),
    '{last_consumed}', to_jsonb(v_last_consumed)),
    '{lower_pool}', to_jsonb(v_lower_pool)),
    '{wait}', CASE WHEN v_wait IS NULL THEN '[]'::jsonb ELSE to_jsonb(ARRAY[v_wait::text]) END);

  UPDATE public.league_settings SET playoff_state_json = v_state, updated_at = NOW() WHERE season_id = v_season_id;

  RETURN v_count;
END;
$$;

-- Re-issued so the migration is self-contained. CREATE OR REPLACE preserves the
-- grants an existing function already has, so this only matters on a fresh replay.
REVOKE ALL ON FUNCTION public.generate_playoff_round(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_playoff_round(UUID) TO authenticated;
