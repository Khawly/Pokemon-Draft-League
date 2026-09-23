-- Schedule page (spec section 10)
--
-- The Schedule page needs season-wide schedule configuration, match writes, and
-- a playoff bracket, none of which existing policies allow from the client
-- (`matches`, `match_results`, and `notifications` have no client write
-- policies). This migration:
--   - adds schedule config columns and transient playoff bracket state to
--     league_settings, plus `notes`/`bracket_phase` columns to matches
--   - adds standings + participant helper functions
--   - adds RPCs for every schedule write: generate_schedule (owner),
--     generate_playoff_round (owner, single or double elimination),
--     update_match_schedule, submit_game_result, update_game_result (staff),
--     and forfeit_match
--   - creates notification rows for scheduling/result/forfeit events so the
--     opponent is informed per spec 10.2

-- -------- league_settings: schedule configuration --------

-- Season-wide scheduling configuration: regular-season week count, match
-- format, playoff size/format, and transient bracket progress used to replay
-- the bracket between RPC calls.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS regular_season_weeks INTEGER NOT NULL DEFAULT 0 CHECK (regular_season_weeks >= 0),
  ADD COLUMN IF NOT EXISTS match_format TEXT NOT NULL DEFAULT 'best_of_3' CHECK (match_format IN ('single','best_of_3')),
  ADD COLUMN IF NOT EXISTS playoff_team_count INTEGER NOT NULL DEFAULT 0 CHECK (playoff_team_count >= 0),
  ADD COLUMN IF NOT EXISTS playoff_match_format TEXT NOT NULL DEFAULT 'best_of_3' CHECK (playoff_match_format IN ('single','best_of_3')),
  ADD COLUMN IF NOT EXISTS playoff_format TEXT NOT NULL DEFAULT 'single_elimination' CHECK (playoff_format IN ('single_elimination','double_elimination')),
  ADD COLUMN IF NOT EXISTS playoff_state_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Matches: free-text scheduling notes (spec 10.2) and the bracket phase that
-- distinguishes regular/upper/lower/grand-final playoff matches so the bracket
-- can be rendered and advanced incrementally.
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS bracket_phase TEXT CHECK (bracket_phase IS NULL OR bracket_phase IN ('upper','lower','gf'));

-- -------- helper functions --------

-- SECURITY DEFINER helpers report league ownership and match participation
-- against auth.uid() so RPCs and (potentially) policies can use them without
-- recursion or RLS bypass concerns.
CREATE OR REPLACE FUNCTION public.is_league_owner(p_league_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = p_league_id AND l.owner_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_league_owner(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.is_match_participant(p_match_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.matches m
    JOIN public.teams tp1 ON tp1.id = m.player_1_team_id
    JOIN public.teams tp2 ON tp2.id = m.player_2_team_id
    WHERE m.id = p_match_id
      AND (tp1.owner_user_id = auth.uid() OR tp2.owner_user_id = auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_match_participant(UUID) FROM PUBLIC;

-- Standard single-elimination seed ordering for a bracket of p_slots (a power
-- of two): returns the seed assigned to each bracket position. Produces e.g.
-- [1,8,4,5,2,7,3,6] for 8 slots so that consecutive-position pairs meet in
-- round one and winners of consecutive pairs meet later (a true bracket tree).
-- Used only inside generate_playoff_round.
CREATE OR REPLACE FUNCTION public.playoff_seed_order(p_slots INTEGER)
RETURNS INTEGER[]
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order INTEGER[] := ARRAY[1]::INTEGER[];
  v_next INTEGER[];
  v_seed INTEGER;
  v_size INTEGER := 1;
BEGIN
  WHILE v_size < p_slots LOOP
    v_next := ARRAY[]::INTEGER[];
    FOREACH v_seed IN ARRAY v_order LOOP
      v_next := v_next || ARRAY[v_seed, p_slots + 1 - v_seed]::INTEGER[];
    END LOOP;
    v_order := v_next;
    v_size := v_size * 2;
  END LOOP;
  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION public.playoff_seed_order(INTEGER) FROM PUBLIC;

-- Ranks every team of the league's latest season by wins, losses, and KO Diff.
-- KO Diff credits a team with the opponent's reported surviving Pokemon for
-- each game it wins and charges it the same count for each game it loses, so
-- the metric is symmetric per game.
CREATE OR REPLACE FUNCTION public.season_standings(p_league_id UUID)
RETURNS TABLE (team_id UUID, team_name TEXT, wins BIGINT, losses BIGINT, ko_diff BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to view standings.';
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
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  RETURN QUERY
  SELECT
    t.id AS team_id,
    t.team_name AS team_name,
    (SELECT COUNT(*)::BIGINT FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.status IN ('completed','forfeit') AND m.winner_team_id = t.id) AS wins,
    (SELECT COUNT(*)::BIGINT FROM public.matches m
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND m.status IN ('completed','forfeit') AND m.winner_team_id IS NOT NULL
        AND m.winner_team_id <> t.id
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS losses,
    (SELECT COALESCE(SUM(CASE WHEN mr.winner_team_id = t.id THEN mr.pokemon_left_alive ELSE -mr.pokemon_left_alive END), 0)::BIGINT
      FROM public.match_results mr
      JOIN public.matches m ON m.id = mr.match_id
      WHERE m.league_id = p_league_id AND m.season_id = v_season_id
        AND mr.pokemon_left_alive IS NOT NULL
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)) AS ko_diff
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id
  ORDER BY wins DESC, losses ASC, ko_diff DESC, t.team_name ASC;
END;
$$;

-- Members read standings through their normal team access; keep the RPC
-- available to signed-in users only.
REVOKE ALL ON FUNCTION public.season_standings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.season_standings(UUID) TO authenticated;

-- Creates a notification for the owner of p_recipient_team_id, so schedule
-- actions can inform the opponent as required by spec 10.2. SECURITY DEFINER
-- because clients have no direct write access to notifications.
CREATE OR REPLACE FUNCTION public.notify_match_actor(
  p_league_id UUID,
  p_season_id UUID,
  p_recipient_team_id UUID,
  p_actor_user_id UUID,
  p_type TEXT,
  p_message TEXT,
  p_entity_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipient UUID;
BEGIN
  SELECT t.owner_user_id INTO v_recipient FROM public.teams t WHERE t.id = p_recipient_team_id;
  IF v_recipient IS NOT NULL THEN
    INSERT INTO public.notifications (league_id, season_id, recipient_user_id, actor_user_id, type, message, related_entity_type, related_entity_id)
    VALUES (p_league_id, p_season_id, v_recipient, p_actor_user_id, p_type, p_message, 'match', p_entity_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_match_actor(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC;

-- Recomputes a match's status/winners from its reported games for the match's
-- format (single: 1 win, best of 3: 2 wins). Returns the resulting status.
CREATE OR REPLACE FUNCTION public.recompute_match_status(p_match_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match RECORD;
  v_p1_wins INTEGER;
  v_p2_wins INTEGER;
  v_format TEXT;
  v_needed INTEGER;
BEGIN
  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RETURN 'scheduled';
  END IF;

  SELECT COALESCE(
    CASE WHEN v_match.is_playoff THEN ls.playoff_match_format ELSE ls.match_format END,
    'best_of_3'
  ) INTO v_format
  FROM public.league_settings ls
  WHERE ls.season_id = v_match.season_id;

  v_needed := CASE WHEN v_format = 'single' THEN 1 ELSE 2 END;

  SELECT
    COUNT(*) FILTER (WHERE winner_team_id = v_match.player_1_team_id),
    COUNT(*) FILTER (WHERE winner_team_id = v_match.player_2_team_id)
  INTO v_p1_wins, v_p2_wins
  FROM public.match_results
  WHERE match_id = p_match_id;

  IF v_p1_wins >= v_needed THEN
    UPDATE public.matches SET status = 'completed', winner_team_id = v_match.player_1_team_id, updated_at = NOW() WHERE id = p_match_id;
    RETURN 'completed';
  ELSIF v_p2_wins >= v_needed THEN
    UPDATE public.matches SET status = 'completed', winner_team_id = v_match.player_2_team_id, updated_at = NOW() WHERE id = p_match_id;
    RETURN 'completed';
  ELSIF v_p1_wins = 0 AND v_p2_wins = 0 THEN
    UPDATE public.matches SET status = 'scheduled', winner_team_id = NULL, updated_at = NOW() WHERE id = p_match_id;
    RETURN 'scheduled';
  ELSE
    UPDATE public.matches SET status = 'in_progress', winner_team_id = NULL, updated_at = NOW() WHERE id = p_match_id;
    RETURN 'in_progress';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_match_status(UUID) FROM PUBLIC;

-- -------- RPC: generate_schedule (owner) --------

-- Owner-only RPC that saves the season's schedule configuration, replaces any
-- prior schedule for the season (results cascade with their matches), and
-- generates the regular-season weeks using a round-robin circle method. With an
-- odd number of teams one team receives a bye each week.
CREATE OR REPLACE FUNCTION public.generate_schedule(
  p_league_id UUID,
  p_weeks INTEGER,
  p_match_format TEXT,
  p_playoff_team_count INTEGER,
  p_playoff_match_format TEXT,
  p_playoff_format TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_teams UUID[];
  v_n INTEGER;
  v_list UUID[];
  v_new UUID[];
  v_left UUID;
  v_right UUID;
  v_created INTEGER := 0;
  v_w INTEGER;
  v_i INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to generate a schedule.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can generate the schedule.';
  END IF;

  IF p_weeks IS NULL OR p_weeks < 1 THEN
    RAISE EXCEPTION 'Regular season weeks must be at least 1.';
  END IF;

  IF p_match_format NOT IN ('single','best_of_3') THEN
    RAISE EXCEPTION 'Invalid regular season match format.';
  END IF;

  IF p_playoff_team_count IS NULL OR p_playoff_team_count < 0 OR p_playoff_team_count > 16 THEN
    RAISE EXCEPTION 'Invalid playoff team count.';
  END IF;

  IF p_playoff_match_format NOT IN ('single','best_of_3') THEN
    RAISE EXCEPTION 'Invalid playoff match format.';
  END IF;

  IF p_playoff_format NOT IN ('single_elimination','double_elimination') THEN
    RAISE EXCEPTION 'Invalid playoff format.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id AND s.status <> 'archived'
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no active season.';
  END IF;

  INSERT INTO public.league_settings (league_id, season_id, regular_season_weeks, match_format, playoff_team_count, playoff_match_format, playoff_format, updated_at)
  VALUES (p_league_id, v_season_id, p_weeks, p_match_format, p_playoff_team_count, p_playoff_match_format, p_playoff_format, NOW())
  ON CONFLICT (league_id, season_id)
  DO UPDATE SET
    regular_season_weeks = EXCLUDED.regular_season_weeks,
    match_format = EXCLUDED.match_format,
    playoff_team_count = EXCLUDED.playoff_team_count,
    playoff_match_format = EXCLUDED.playoff_match_format,
    playoff_format = EXCLUDED.playoff_format,
    updated_at = NOW();

  -- Replace any prior schedule for this season (results cascade with matches).
  DELETE FROM public.matches WHERE league_id = p_league_id AND season_id = v_season_id;
  UPDATE public.league_settings SET playoff_state_json = '{}'::jsonb, updated_at = NOW() WHERE season_id = v_season_id;

  SELECT ARRAY_AGG(t.id ORDER BY t.draft_position NULLS LAST, t.created_at ASC) INTO v_teams
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  IF v_teams IS NULL OR array_length(v_teams, 1) < 2 THEN
    RAISE EXCEPTION 'At least two teams are required to generate a schedule.';
  END IF;

  v_list := v_teams;
  v_n := array_length(v_list, 1);

  -- With an odd number of teams, append a bye sentinel so the circle method
  -- pairs every real team exactly once and one team rests each week.
  IF v_n % 2 = 1 THEN
    v_list := v_list || ARRAY[NULL::uuid];
    v_n := v_n + 1;
  END IF;

  FOR v_w IN 1..p_weeks LOOP
    FOR v_i IN 1..(v_n / 2) LOOP
      v_left := v_list[v_i];
      v_right := v_list[v_n + 1 - v_i];
      IF v_left IS NULL OR v_right IS NULL OR v_left = v_right THEN
        CONTINUE;
      END IF;
      INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES (p_league_id, v_season_id, v_w, FALSE, v_left, v_right, 'scheduled', NULL);
      v_created := v_created + 1;
    END LOOP;

    -- Rotate the list for the next week, keeping the first team fixed.
    v_new := ARRAY[v_list[1]]::uuid[];
    FOR v_i IN 2..v_n LOOP
      IF v_i = 2 THEN v_new := v_new || ARRAY[v_list[v_n]]::uuid[];
      ELSE v_new := v_new || ARRAY[v_list[v_i - 1]]::uuid[];
      END IF;
    END LOOP;
    v_list := v_new;
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT) TO authenticated;

-- -------- RPC: generate_playoff_round (owner) --------

-- Owner-only RPC that advances the playoff bracket one step at a time. The
-- bracket is a standard single-elimination seed tree (top seeds receive
-- calculated first-round byes when the playoff field is not a power of two);
-- for double elimination, a lower bracket collects upper-round losers, and a
-- grand final crowns the champion. Progress is derived from stored results
-- (upper rounds) plus a small JSONB state on league_settings (seeding and the
-- lower bracket), so calls are idempotent: each call creates exactly the next
-- round whose participants are currently known and stops until results fill in.
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
      v_seed_teams := v_seed_teams || ARRAY[(v_state -> 'seeds' -> v_i)::text::uuid]::uuid[];
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
      v_lower_pool := v_lower_pool || ARRAY[(v_state -> 'lower_pool' -> v_i)::text::uuid]::uuid[];
    END LOOP;
  END IF;

  v_wait := NULL;
  IF jsonb_typeof(v_state -> 'wait') = 'array' AND jsonb_array_length(v_state -> 'wait') > 0 THEN
    v_wait := (v_state -> 'wait' -> 0)::text::uuid;
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

REVOKE ALL ON FUNCTION public.generate_playoff_round(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_playoff_round(UUID) TO authenticated;

-- -------- RPC: update_match_schedule (participants) --------

-- Participants may schedule or reschedule their match (date/time + notes);
-- every change notifies the other participant (spec 10.2).
CREATE OR REPLACE FUNCTION public.update_match_schedule(
  p_match_id UUID,
  p_scheduled_at TIMESTAMPTZ,
  p_notes TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_my_team_id UUID;
  v_opponent_team_id UUID;
  v_was_scheduled BOOLEAN;
  v_message TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to schedule a match.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.is_match_participant(p_match_id) THEN
    RAISE EXCEPTION 'Only the participants can schedule a match.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_my_team_id IS NULL THEN
    RAISE EXCEPTION 'Only the participants can schedule a match.';
  END IF;

  v_opponent_team_id := CASE
    WHEN v_match.player_1_team_id = v_my_team_id THEN v_match.player_2_team_id
    ELSE v_match.player_1_team_id
  END;

  v_was_scheduled := v_match.scheduled_at IS NOT NULL;

  UPDATE public.matches
  SET scheduled_at = p_scheduled_at, notes = NULLIF(p_notes, ''), updated_at = NOW()
  WHERE id = p_match_id;

  v_message := 'Your match vs the opposing team was ' || CASE WHEN v_was_scheduled THEN 'updated' ELSE 'scheduled' END || '.';
  PERFORM public.notify_match_actor(
    v_match.league_id, v_match.season_id, v_opponent_team_id, v_user_id,
    CASE WHEN v_was_scheduled THEN 'match_updated' ELSE 'match_scheduled' END,
    v_message, v_match.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_match_schedule(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_match_schedule(UUID, TIMESTAMPTZ, TEXT) TO authenticated;

-- -------- RPC: submit_game_result (participants) --------

-- Participants submit one result per game. Enforces single-submission per game
-- (also a DB unique constraint), one replay link per league filing (rejected
-- with the exact message `Link already submitted`), valid game numbers for the
-- match format, and automatically closes the match once a team reaches the
-- required win count (single: 1, best of 3: 2). Notifies the opponent.
CREATE OR REPLACE FUNCTION public.submit_game_result(
  p_match_id UUID,
  p_game_number INTEGER,
  p_winner_team_id UUID,
  p_replay_url TEXT,
  p_pokemon_left_alive INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_format TEXT;
  v_max_games INTEGER;
  v_status TEXT;
  v_winner_team_id UUID;
  v_my_team_id UUID;
  v_opponent_team_id UUID;
  v_message TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to report a result.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.is_match_participant(p_match_id) THEN
    RAISE EXCEPTION 'Only the participants can report a result.';
  END IF;

  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_my_team_id IS NULL THEN
    RAISE EXCEPTION 'Only the participants can report a result.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  IF p_winner_team_id NOT IN (v_match.player_1_team_id, v_match.player_2_team_id) THEN
    RAISE EXCEPTION 'The winner must be one of the two participants.';
  END IF;

  IF p_game_number IS NULL OR p_game_number < 1 THEN
    RAISE EXCEPTION 'Invalid game number.';
  END IF;

  IF p_pokemon_left_alive IS NOT NULL AND (p_pokemon_left_alive < 0 OR p_pokemon_left_alive > 6) THEN
    RAISE EXCEPTION 'Surviving Pokemon must be between 0 and 6.';
  END IF;

  SELECT COALESCE(CASE WHEN v_match.is_playoff THEN ls.playoff_match_format ELSE ls.match_format END, 'best_of_3')
  INTO v_format
  FROM public.league_settings ls
  WHERE ls.season_id = v_match.season_id;

  v_max_games := CASE WHEN v_format = 'single' THEN 1 ELSE 3 END;

  IF p_game_number > v_max_games THEN
    RAISE EXCEPTION 'That game is outside this match format.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.match_results
    WHERE match_id = p_match_id AND game_number = p_game_number
  ) THEN
    RAISE EXCEPTION 'A result for this game has already been submitted.';
  END IF;

  IF p_replay_url IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.match_results mr
    WHERE mr.replay_url = p_replay_url AND mr.match_id <> p_match_id
  ) THEN
    RAISE EXCEPTION 'Link already submitted';
  END IF;

  INSERT INTO public.match_results (match_id, reporter_user_id, winner_team_id, replay_url, game_number, pokemon_left_alive, is_manual)
  VALUES (p_match_id, v_user_id, p_winner_team_id, NULLIF(p_replay_url, ''), p_game_number, p_pokemon_left_alive, FALSE);

  v_status := public.recompute_match_status(p_match_id);
  SELECT winner_team_id INTO v_winner_team_id FROM public.matches WHERE id = p_match_id;

  v_opponent_team_id := CASE
    WHEN v_match.player_1_team_id = v_my_team_id THEN v_match.player_2_team_id
    ELSE v_match.player_1_team_id
  END;
  v_message := 'A result was filed for your match (game ' || p_game_number || ').';
  PERFORM public.notify_match_actor(
    v_match.league_id, v_match.season_id, v_opponent_team_id, v_user_id,
    CASE WHEN v_status = 'completed' THEN 'match_completed' ELSE 'match_result' END,
    v_message, v_match.id
  );

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_game_result(UUID, INTEGER, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_game_result(UUID, INTEGER, UUID, TEXT, INTEGER) TO authenticated;

-- -------- RPC: update_game_result (owner/admin) --------

-- Owners and admins may correct a reported game (winner, replay link, or
-- surviving count); the match status is recomputed afterwards (spec 10.3).
CREATE OR REPLACE FUNCTION public.update_game_result(
  p_result_id UUID,
  p_winner_team_id UUID,
  p_replay_url TEXT,
  p_pokemon_left_alive INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_league_id UUID;
  v_match_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  SELECT mr.match_id, m.league_id INTO v_match_id, v_league_id
  FROM public.match_results mr
  JOIN public.matches m ON m.id = mr.match_id
  WHERE mr.id = p_result_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That game result does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = v_league_id AND lm.user_id = v_user_id AND lm.is_active = TRUE
      AND lm.role IN ('owner','admin')
  ) THEN
    RAISE EXCEPTION 'Only owners and admins can edit game results.';
  END IF;

  UPDATE public.match_results
  SET winner_team_id = p_winner_team_id, replay_url = NULLIF(p_replay_url, ''), pokemon_left_alive = p_pokemon_left_alive
  WHERE id = p_result_id;

  RETURN public.recompute_match_status(v_match_id);
END;
$$;

REVOKE ALL ON FUNCTION public.update_game_result(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_game_result(UUID, UUID, TEXT, INTEGER) TO authenticated;

-- -------- RPC: forfeit_match (participants) --------

-- A participant forfeits the match to their opponent, which closes the match
-- with the opponent as winner and notifies them.
CREATE OR REPLACE FUNCTION public.forfeit_match(p_match_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_match RECORD;
  v_my_team_id UUID;
  v_winner_team_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to forfeit.';
  END IF;

  SELECT m.* INTO v_match FROM public.matches m WHERE m.id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match does not exist.';
  END IF;

  IF NOT public.is_match_participant(p_match_id) THEN
    RAISE EXCEPTION 'Only the participants can forfeit a match.';
  END IF;

  IF v_match.status IN ('completed','forfeit','cancelled') THEN
    RAISE EXCEPTION 'This match is already closed.';
  END IF;

  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.id IN (v_match.player_1_team_id, v_match.player_2_team_id)
    AND t.owner_user_id = v_user_id
  LIMIT 1;

  v_winner_team_id := CASE
    WHEN v_match.player_1_team_id = v_my_team_id THEN v_match.player_2_team_id
    ELSE v_match.player_1_team_id
  END;

  UPDATE public.matches
  SET status = 'forfeit', winner_team_id = v_winner_team_id, updated_at = NOW()
  WHERE id = p_match_id;

  PERFORM public.notify_match_actor(
    v_match.league_id, v_match.season_id, v_winner_team_id, v_user_id,
    'match_forfeit', 'Your opponent forfeited the match.', v_match.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.forfeit_match(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forfeit_match(UUID) TO authenticated;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';