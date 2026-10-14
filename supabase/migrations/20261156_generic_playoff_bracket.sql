-- Replaces the hand-written twelve-team tree with a bracket engine for any field size.
--
-- The rules this implements, from ai-instructions.md section 10.4:
--
--   * a playoff field may be any size from two teams up to the size of the league,
--     and the league size is the maximum;
--   * with a power-of-two field the top seed meets the bottom seed, the second seed
--     the second from the bottom, and so on;
--   * with a field that is not a power of two the difference gets a bye, so twelve
--     teams fill a sixteen-slot bracket and the top four sit the first round out;
--   * under double elimination every team starts in the winners bracket, winners
--     continue there, losers drop to the losers bracket, and a team that loses there
--     is out;
--   * a team from the winners bracket that loses the grand final triggers a reset,
--     with the same two teams playing again next week.
--
-- What came before only satisfied part of that. `playoff_advance_12` described one
-- fixed tree, and `generate_playoff_round` refused every field size other than eight,
-- twelve or sixteen. Those three sizes were not even handled alike: twelve built a
-- real double-elimination bracket, while eight and sixteen fell through to a loop that
-- only ever inserted `upper` games. It read no losers bracket, produced no grand final
-- and ignored `p_format` entirely, so a league set to double elimination got a single
-- elimination bracket with no reset and no way to notice.
--
-- The tree is now computed rather than written down, and both halves of the feature
-- read it: `playoff_bracket_structure` describes the bracket and `playoff_advance`
-- builds it, so what the bracket preview promises and what the generator creates can no
-- longer drift apart.
--
-- Winners bracket
-- ---------------
-- The seeds are placed one to N, then padded with empty slots out to the next power of
-- two, and every round pairs the list from the outside in -- position i against position
-- length + 1 - i. The first round is the seeds themselves: for twelve teams in sixteen
-- slots the four trailing empty slots meet seeds one to four, so those four get a bye,
-- and the remaining pairings come out 5 v 12, 6 v 11, 7 v 10 and 8 v 9, reversed.
-- Later rounds mirror the games of the round before, which carries the seeding through:
-- round two of that twelve team field is one against the eight-and-nine winner, two
-- against seven-and-ten, three against six-eleven and four against five-twelve.
--
-- Mirroring is the whole construction. The circle method's rotation is the other way to
-- build a bracket, and the regular season generator uses it, but it is wrong for a seeded
-- bracket: it counts a bye as though it held a place in the sequence, which put the top
-- seeds up against each other instead of against the lowest-seeded survivors.
--
-- A padded slot is not a game. No row is written for it and none is created, and the
-- seed it would have carried goes straight into the round it actually plays. Listing the
-- bye as a one-sided game is what put a team in the wrong place: the bracket named seed
-- two as playing a phantom first round game when the game it really plays is the second
-- round game that slot feeds. The slot's label is still consumed, so the numbering of the
-- games that are played does not move when a field is padded.
--
-- Labels are G for the winners bracket, L for the losers bracket and GF for the finals.
-- Every label is unique across the bracket, because a side names the game feeding it by
-- label alone. The finals take GF rather than G for that reason: the winners bracket
-- already owns every G the field size can produce.
--
-- Losers bracket
-- --------------
-- The losers bracket takes, on each round, the survivors of its previous round plus,
-- on the rounds where a drop-in falls due, the losers of a winners round. The drop-in
-- round is one for the first losers round and then every second round, which lines the
-- losers bracket up so the final drop-in is always the grand final's loser:
--
--   LB 1 <- losers of WB 1
--   LB 2 <- LB 1 winners + losers of WB 2
--   LB 3 <- LB 2 winners
--   LB 4 <- LB 3 winners + losers of WB 3
--   ...
--
-- That gives 2 * (rounds - 1) losers rounds, with a floor of one so that a field of two
-- still has a bracket to play in, and the game count works out to the right total on its
-- own: a twelve team field creates 11 winners games and 11 losers games, and those 22
-- are the 2N - 2 of a double-elimination bracket with no reset.
--
-- A losers round with an odd number of inputs gives its last team a bye, and a round with
-- none creates nothing.
--
-- The grand final's double forfeit
-- --------------------------------
-- The rules say a double forfeit gives each side a loss, and the loss totals settle what
-- that means at each stage of the finals.
--
-- In the first grand final the losers bracket finalist arrives having lost once and the
-- winners bracket finalist having lost nothing. A loss each takes the losers finalist to
-- two and eliminates them, and leaves the winners finalist on one with nobody left to
-- play, so the winners finalist is the champion.
--
-- After a bracket reset both finalists are already on one loss, so the same forfeit takes
-- both to two and eliminates both. There is nobody left standing, and the season ends with
-- no champion. That is the rule as written and `playoff_champion` returns NULL for it,
-- rather than promoting whoever happened to win the first final. The same applies when
-- double forfeits wipe out a whole small field before a final is ever reached.
--
-- `playoff_champion` implements this and `reset_playoff_bracket` still clears the lot.

-- The smallest power of two at or above a value.
--
-- Written as a loop rather than a log() because LOG(2, 8) is not guaranteed to come back
-- as exactly 3, and a value that rounds up to 4 would put a twelve team field in a
-- thirty-two slot bracket.
--
-- @param p_value - Size to round up.
-- @returns A power of two, never below 1.
CREATE OR REPLACE FUNCTION public.playoff_next_power_of_two(p_value INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_result INTEGER := 1;
BEGIN
  WHILE v_result < GREATEST(COALESCE(p_value, 1), 1) LOOP
    v_result := v_result * 2;
  END LOOP;

  RETURN v_result;
END;
$$;

-- Describes the whole bracket before any of it has been played.
--
-- Every game the tournament can contain, in the order they become playable, with each
-- side described by what feeds it. The generator walks this same list, so a slot the
-- preview shows and a game the generator creates are the same row.
--
-- A side is a seed, a reference to another game's winner or loser, or empty. Games are
-- labelled U1.. for the winners bracket, L1.. for the losers bracket and G1.. for the
-- finals, which is what lets a side refer to the game feeding it.
--
-- Rounds are numbered continuously across phases so a caller can order by round and get
-- the dependency order, and so the bracket preview can lay the rounds out in columns.
-- Weeks are sequential: the winners bracket, then the losers bracket, then the finals.
--
-- @param p_field_size - Teams in the field, from 2 up to the size of the league.
-- @param p_base_week  - Last regular-season week, which the bracket continues from.
-- @param p_format     - 'single_elimination' or 'double_elimination'.
CREATE OR REPLACE FUNCTION public.playoff_bracket_structure(
  p_field_size INTEGER,
  p_base_week INTEGER,
  p_format TEXT
)
RETURNS TABLE (
  game_label TEXT,
  phase TEXT,
  round_no INTEGER,
  slot INTEGER,
  week INTEGER,
  -- 'seed' with the seed number in the ref, 'winner' or 'loser' with a game label, or
  -- 'empty' when nothing can feed that side.
  feeder_a_kind TEXT,
  feeder_a_ref TEXT,
  feeder_b_kind TEXT,
  feeder_b_ref TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_size INTEGER;
  v_wb_rounds INTEGER;
  v_lb_rounds INTEGER;
  v_i INTEGER;
  v_j INTEGER;
  v_r INTEGER;
  v_label TEXT;
  v_feeder_a JSONB;
  v_feeder_b JSONB;
  -- Winners bracket geometry, held as arithmetic rather than as a list of games.
  -- Round r plays size / 2^r games and its labels start at size - (size / 2^(r-1)) + 1,
  -- so any game's label follows from its round and slot alone. The losers bracket needs
  -- to name the losers of a winners round it has not built, and this is what lets it do
  -- that without the function carrying a list of every game it has already described.
  v_prev_m INTEGER;
  v_prev_first INTEGER;
  v_prev_count INTEGER;
  v_first INTEGER;
  v_idx_a INTEGER;
  v_idx_b INTEGER;
  -- The seeds on the two sides of the first round pairing being built.
  v_seed_a INTEGER;
  v_seed_b INTEGER;
  v_k INTEGER;
  -- How many seeds the field cannot place, and so how many sit the first round out.
  v_byes INTEGER;
  -- Which games in each winners round are byes, one boolean list per round.
  --
  -- A winners game is a bye when one of its sides has no seed behind it, and a game fed
  -- by a bye is a bye itself. Byes are not listed and not created, so the losers bracket
  -- has to skip them when it collects that round's losers: a bye has a loser column with
  -- nobody in it, and feeding it into a losers game would leave a slot that can never
  -- fill.
  v_flags BOOLEAN[] := ARRAY[]::BOOLEAN[];
  v_ub_bye JSONB[] := ARRAY[]::JSONB[];
  -- The seed standing in for a bye, per game, so the next round can take it directly
  -- instead of waiting on a game that will never exist.
  v_carry INTEGER[] := ARRAY[]::INTEGER[];
  v_prev_carry INTEGER[] := ARRAY[]::INTEGER[];
  -- Counted across the whole bracket rather than per round. Labels have to be unique
  -- throughout: a side refers to the game feeding it by label alone, so a losers bracket
  -- that restarted at L1 each round would have every round's first game pointing at
  -- itself and the bracket would never advance past the second round.
  v_lb_counter INTEGER := 0;
  v_lb_labels TEXT[] := ARRAY[]::TEXT[];
  v_inputs JSONB[] := ARRAY[]::JSONB[];
  v_compact JSONB[] := ARRAY[]::JSONB[];
BEGIN
  IF p_field_size < 2 THEN
    RETURN;
  END IF;

  v_size := public.playoff_next_power_of_two(p_field_size);

  v_wb_rounds := 0;
  WHILE (1 << v_wb_rounds) < v_size LOOP
    v_wb_rounds := v_wb_rounds + 1;
  END LOOP;

  -- Two rounds of losers bracket for every pair of winners rounds, with a floor of one.
  --
  -- The floor is for a field of two, where the formula would otherwise leave the losers
  -- bracket empty. A two-team double elimination is not a single game: the loser is not
  -- out, they get the rematch. With one losers round the loser of the only winners game
  -- takes a bye through it and meets the winner in the final, which is exactly the
  -- two-game bracket the format describes.
  v_lb_rounds := CASE
    WHEN p_format = 'double_elimination'
      THEN GREATEST((v_wb_rounds - 1) * 2, 1)
    ELSE 0
  END;

  -- Winners bracket, round one: position i against position size + 1 - i.
  --
  -- Which seeds occupy those two slots depends on whether the field fills the bracket.
  --
  -- A full bracket is seeded in reverse: position i against N + 1 - i, so the top seed
  -- meets the bottom seed and the second meets the second from the bottom. That is the
  -- rule for a power-of-two field, and it is what the bracket sheet has always shown.
  --
  -- A padded bracket seeds differently, because the seeds given a bye are the ones that
  -- would otherwise play the weakest. The top S - N seeds sit out round one and the rest
  -- pair off from the bottom up, so the top seed then meets the winner of the bottom two,
  -- the second seed the winner of the third and fourth from the bottom, and so on. For
  -- twelve teams that is a first round of 5 v 6, 7 v 8, 9 v 10 and 11 v 12, with the four
  -- byed seeds meeting those four winners in that order.
  --
  -- Pairing the rest in reverse instead -- 5 v 12, 6 v 11 and so on -- is the obvious
  -- choice and is the wrong one here: it leaves the top seed facing the winner of the two
  -- seeds just below the byes rather than the bottom of the field, which is the weaker of
  -- the two opponents it could get.
  --
  -- The later rounds mirror this list, so the byed seeds land in opposite halves and the
  -- top two can only meet in the winners final.
  v_flags := ARRAY[]::BOOLEAN[];
  v_carry := ARRAY[]::INTEGER[];
  v_byes := v_size - p_field_size;

  FOR v_i IN 1..(v_size / 2) LOOP
    v_label := 'G' || v_i;

    IF v_byes = 0 THEN
      v_seed_a := v_i;
      v_seed_b := p_field_size + 1 - v_i;
    ELSIF v_i <= v_byes THEN
      v_seed_a := v_i;
      v_seed_b := NULL;
    ELSE
      v_k := v_i - v_byes;
      v_seed_a := v_byes + (2 * v_k) - 1;
      v_seed_b := v_byes + (2 * v_k);
    END IF;

    IF v_seed_a IS NULL THEN
      v_feeder_a := jsonb_build_object('kind', 'empty', 'ref', NULL);
    ELSE
      v_feeder_a := jsonb_build_object('kind', 'seed', 'ref', v_seed_a::TEXT);
    END IF;

    IF v_seed_b IS NULL THEN
      v_feeder_b := jsonb_build_object('kind', 'empty', 'ref', NULL);
    ELSE
      v_feeder_b := jsonb_build_object('kind', 'seed', 'ref', v_seed_b::TEXT);
    END IF;

    IF (v_feeder_a ->> 'kind') = 'empty' OR (v_feeder_b ->> 'kind') = 'empty' THEN
      -- A padded slot with no opponent. No game is played, so none is listed and none is
      -- created; the seed carries straight into the round it would have played. The label
      -- is still consumed, so the numbering of the games that are played does not move
      -- when a field is padded.
      --
      -- Listing the bye as a game of its own is what put a team in the wrong place. The
      -- bracket named seed two as playing a one-sided first round game, when the game it
      -- actually plays is the second round game that slot feeds.
      v_flags := v_flags || ARRAY[TRUE];
      v_carry := v_carry || ARRAY[
        CASE
          WHEN (v_feeder_a ->> 'kind') = 'seed' THEN (v_feeder_a ->> 'ref')::INTEGER
          ELSE (v_feeder_b ->> 'ref')::INTEGER
        END
      ];
    ELSE
      v_flags := v_flags || ARRAY[FALSE];
      v_carry := v_carry || ARRAY[0];

      game_label := v_label;
      phase := 'upper';
      round_no := 1;
      slot := v_i;
      week := p_base_week + 1;
      feeder_a_kind := v_feeder_a ->> 'kind';
      feeder_a_ref := v_feeder_a ->> 'ref';
      feeder_b_kind := v_feeder_b ->> 'kind';
      feeder_b_ref := v_feeder_b ->> 'ref';
      RETURN NEXT;
    END IF;
  END LOOP;

  v_ub_bye := array_append(v_ub_bye, to_jsonb(v_flags));
  v_prev_carry := v_carry;
  v_prev_first := 1;
  v_prev_count := v_size / 2;

  -- Winners bracket, the remaining rounds.
  --
  -- Every round pairs the previous round's games from the outside in, the same mirror the
  -- first round uses on the seeds. A rotation is the other way to build a bracket, and is
  -- what the regular season generator does, but it is wrong here: it treats a bye as
  -- though it occupied a place in the sequence, which pushed the top seeds into each
  -- other. Mirroring keeps the seeding intact. With seeds one to four carrying a bye and
  -- the rest meeting in reverse, round two comes out as one against the eight-and-nine
  -- winner, two against seven-and-ten, three against six-eleven and four against
  -- five-twelve, which is the bracket the seeding calls for.
  FOR v_r IN 2..v_wb_rounds LOOP
    v_flags := ARRAY[]::BOOLEAN[];
    v_carry := ARRAY[]::INTEGER[];

    FOR v_i IN 1..(v_prev_count / 2) LOOP
      v_label := 'G' || (v_size - v_prev_count + v_i);

      v_idx_a := v_i;
      v_idx_b := v_prev_count + 1 - v_i;

      -- A side fed by a bye takes that bye's seed directly instead of a winner, which is
      -- what places a top seed in the round it actually plays rather than in a game of
      -- its own in the round before.
      IF v_prev_carry[v_idx_a] > 0 THEN
        v_feeder_a := jsonb_build_object('kind', 'seed', 'ref', v_prev_carry[v_idx_a]::TEXT);
      ELSE
        v_feeder_a := jsonb_build_object('kind', 'winner', 'ref', 'G' || (v_prev_first + v_idx_a - 1));
      END IF;

      IF v_prev_carry[v_idx_b] > 0 THEN
        v_feeder_b := jsonb_build_object('kind', 'seed', 'ref', v_prev_carry[v_idx_b]::TEXT);
      ELSE
        v_feeder_b := jsonb_build_object('kind', 'winner', 'ref', 'G' || (v_prev_first + v_idx_b - 1));
      END IF;

      IF (v_feeder_a ->> 'kind') = 'empty' OR (v_feeder_b ->> 'kind') = 'empty' THEN
        v_flags := v_flags || ARRAY[TRUE];
        v_carry := v_carry || ARRAY[
          CASE
            WHEN (v_feeder_a ->> 'kind') = 'seed' THEN (v_feeder_a ->> 'ref')::INTEGER
            ELSE (v_feeder_b ->> 'ref')::INTEGER
          END
        ];
      ELSE
        v_flags := v_flags || ARRAY[FALSE];
        v_carry := v_carry || ARRAY[0];

        game_label := v_label;
        phase := 'upper';
        round_no := v_r;
        slot := v_i;
        week := p_base_week + v_r;
        feeder_a_kind := v_feeder_a ->> 'kind';
        feeder_a_ref := v_feeder_a ->> 'ref';
        feeder_b_kind := v_feeder_b ->> 'kind';
        feeder_b_ref := v_feeder_b ->> 'ref';
        RETURN NEXT;
      END IF;
    END LOOP;

    v_ub_bye := array_append(v_ub_bye, to_jsonb(v_flags));
    v_prev_carry := v_carry;
    v_prev_first := v_size - v_prev_count + 1;
    v_prev_count := v_prev_count / 2;
  END LOOP;

  -- Losers bracket. Survivors first, then any drop-in that falls due this round, then
  -- the inputs are paired in order.
  v_lb_labels := ARRAY[]::TEXT[];

  FOR v_j IN 1..v_lb_rounds LOOP
    v_inputs := ARRAY[]::JSONB[];

    IF v_j > 1 THEN
      FOR v_i IN 1..COALESCE(array_length(v_lb_labels, 1), 0) LOOP
        v_inputs := v_inputs || ARRAY[jsonb_build_object('kind', 'winner', 'ref', v_lb_labels[v_i])];
      END LOOP;
    END IF;

    -- A drop-in falls due on the first losers round and on every second one after that,
    -- which lines the losers bracket up so the last drop-in is always the grand final's
    -- loser. The matching winners round is named the same way: round 1 first, then
    -- round j / 2 + 1.
    IF v_j = 1 OR v_j % 2 = 0 THEN
      v_r := CASE WHEN v_j = 1 THEN 1 ELSE (v_j / 2) + 1 END;

      FOR v_i IN 1..(v_size / (1 << v_r)) LOOP
        -- Byes are skipped rather than fed in. They have a loser column with nobody in
        -- it, and a losers game built from it would be a slot that can never fill.
        IF NOT COALESCE((v_ub_bye[v_r] ->> (v_i - 1))::BOOLEAN, FALSE) THEN
          v_label := 'G' || (v_size - (v_size / (1 << (v_r - 1))) + v_i);
          v_inputs := v_inputs || ARRAY[jsonb_build_object('kind', 'loser', 'ref', v_label)];
        END IF;
      END LOOP;
    END IF;

    -- Sides that resolved to nothing are dropped before pairing. A double forfeit
    -- leaves a hole, and pairing across a hole would hand one of the real teams a free
    -- walk to the next round in place of a game nobody played.
    v_compact := ARRAY[]::JSONB[];

    FOR v_i IN 1..COALESCE(array_length(v_inputs, 1), 0) LOOP
      IF v_inputs[v_i] ->> 'kind' <> 'empty' THEN
        v_compact := v_compact || ARRAY[v_inputs[v_i]];
      END IF;
    END LOOP;

    v_first := COALESCE(array_length(v_compact, 1), 0);
    v_lb_labels := ARRAY[]::TEXT[];

    FOR v_i IN 1..CEIL(v_first / 2.0)::INTEGER LOOP
      v_lb_counter := v_lb_counter + 1;
      v_label := 'L' || v_lb_counter::TEXT;
      v_feeder_a := v_compact[(2 * v_i) - 1];

      IF (2 * v_i) <= v_first THEN
        v_feeder_b := v_compact[2 * v_i];
      ELSE
        -- An odd number of inputs, so the last one takes a bye.
        v_feeder_b := jsonb_build_object('kind', 'empty', 'ref', NULL);
      END IF;

      game_label := v_label;
      phase := 'lower';
      round_no := v_wb_rounds + v_j;
      slot := v_i;
      week := p_base_week + v_wb_rounds + v_j;
      feeder_a_kind := v_feeder_a ->> 'kind';
      feeder_a_ref := v_feeder_a ->> 'ref';
      feeder_b_kind := v_feeder_b ->> 'kind';
      feeder_b_ref := v_feeder_b ->> 'ref';
      RETURN NEXT;

      v_lb_labels := v_lb_labels || ARRAY[v_label]::TEXT[];
    END LOOP;
  END LOOP;

  -- Finals. A single elimination bracket has no losers bracket and so nothing for a
  -- final to sit above: the last winners game settles it.
  IF v_lb_rounds > 0 THEN
    game_label := 'GF1';
    phase := 'gf';
    round_no := v_wb_rounds + v_lb_rounds + 1;
    slot := 1;
    week := p_base_week + v_wb_rounds + v_lb_rounds + 1;
    -- Losers bracket champion first, winners bracket champion second. The order is what
    -- lets playoff_champion name the winners finalist when a grand final ends with
    -- neither side winning. The last winners game is the only game in the last winners
    -- round, so its label follows from the round alone.
    feeder_a_kind := 'winner';
    feeder_a_ref := v_lb_labels[COALESCE(array_length(v_lb_labels, 1), 0)];
    feeder_b_kind := 'winner';
    feeder_b_ref := 'G' || (v_size - (v_size / (1 << (v_wb_rounds - 1))) + 1);
    RETURN NEXT;

    -- The reset: the same two teams again, because the team that came through the
    -- winners bracket lost the first final and has a life left.
    game_label := 'GF2';
    phase := 'gf';
    round_no := v_wb_rounds + v_lb_rounds + 2;
    slot := 1;
    week := p_base_week + v_wb_rounds + v_lb_rounds + 2;
    feeder_a_kind := 'winner';
    feeder_a_ref := 'GF1';
    feeder_b_kind := 'loser';
    feeder_b_ref := 'GF1';
    RETURN NEXT;
  END IF;
END;
$$;

-- True when a bracket game is settled, or will never exist.
--
-- The second case is the one that matters. A game is not created when both its feeders
-- resolved to nothing, which is what a double forfeit upstream produces: the feeding
-- game finished with no winner, so the team that would have advanced does not exist. That
-- game is absent from the matches table for good, and every round referring to it has to
-- treat it as resolved rather than pending. Reading its absence as "not played yet" is
-- what would strand the bracket: the round after the skipped one waits on a game that is
-- never coming.
--
-- Recurses through the structure, so a game whose own feeders are still being played
-- correctly reports as pending. The depth is the length of the bracket.
CREATE OR REPLACE FUNCTION public.playoff_game_resolved(
  p_league_id UUID,
  p_season_id UUID,
  p_seeds UUID[],
  p_field_size INTEGER,
  p_base_weeks INTEGER,
  p_format TEXT,
  p_label TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_status TEXT;
  v_a_ready BOOLEAN;
  v_b_ready BOOLEAN;
BEGIN
  SELECT * INTO v_row
  FROM public.playoff_bracket_structure(p_field_size, p_base_weeks, p_format)
  WHERE game_label = p_label;

  IF NOT FOUND THEN
    -- An unknown label means the game is not part of this bracket at all, such as the
    -- reset in a bracket whose grand final was never needed.
    RETURN FALSE;
  END IF;

  SELECT m.status INTO v_status
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.bracket_phase = v_row.phase
    AND m.week_number = v_row.week
    AND m.bracket_slot = v_row.slot;

  IF v_status IS NOT NULL THEN
    RETURN v_status IN ('completed', 'forfeit', 'cancelled');
  END IF;

  -- No row, so the game was never created. That is only legitimate once its own feeders
  -- have finished.
  SELECT f.ready INTO v_a_ready
  FROM public.playoff_feeder_team(
    p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks, p_format,
    v_row.feeder_a_kind, v_row.feeder_a_ref
  ) f;

  SELECT f.ready INTO v_b_ready
  FROM public.playoff_feeder_team(
    p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks, p_format,
    v_row.feeder_b_kind, v_row.feeder_b_ref
  ) f;

  RETURN COALESCE(v_a_ready, FALSE) AND COALESCE(v_b_ready, FALSE);
END;
$$;

-- Resolves one side of a bracket game to the team standing in it.
--
-- Readiness and the team are returned together because they answer different questions.
-- A side is ready when the game feeding it is settled, or is never going to exist; the
-- team it holds is then the winner, the loser, or nothing at all when that game was a
-- double forfeit or was itself skipped.
--
-- @returns The team in the side, and whether the side can be resolved yet.
CREATE OR REPLACE FUNCTION public.playoff_feeder_team(
  p_league_id UUID,
  p_season_id UUID,
  p_seeds UUID[],
  p_field_size INTEGER,
  p_base_weeks INTEGER,
  p_format TEXT,
  p_kind TEXT,
  p_ref TEXT
)
RETURNS TABLE (team UUID, ready BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winner UUID;
  v_p1 UUID;
  v_p2 UUID;
  v_status TEXT;
BEGIN
  IF p_kind = 'seed' THEN
    -- Seed numbers are one based, matching how the standings are ordered and labelled.
    RETURN QUERY SELECT p_seeds[p_ref::INTEGER], TRUE;
    RETURN;
  END IF;

  IF p_kind = 'empty' THEN
    RETURN QUERY SELECT NULL::UUID, TRUE;
    RETURN;
  END IF;

  IF NOT public.playoff_game_resolved(
    p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks, p_format, p_ref
  ) THEN
    RETURN QUERY SELECT NULL::UUID, FALSE;
    RETURN;
  END IF;

  -- The game either finished or was skipped, and a skipped game has no sides to read.
  SELECT m.winner_team_id, m.player_1_team_id, m.player_2_team_id, m.status
  INTO v_winner, v_p1, v_p2, v_status
  FROM public.playoff_bracket_structure(p_field_size, p_base_weeks, p_format) src
  JOIN public.matches m
    ON m.league_id = p_league_id
   AND m.season_id = p_season_id
   AND m.is_playoff
   AND m.bracket_phase = src.phase
   AND m.week_number = src.week
   AND m.bracket_slot = src.slot
  WHERE src.game_label = p_ref
  LIMIT 1;

  IF v_status IS NULL THEN
    -- Resolved, but the game itself was never created, so nothing advanced out of it.
    RETURN QUERY SELECT NULL::UUID, TRUE;
    RETURN;
  END IF;

  IF p_kind = 'winner' THEN
    RETURN QUERY SELECT v_winner, TRUE;
  ELSIF v_winner IS NULL THEN
    -- The game settled without a winner, which is what a double forfeit records. Nothing
    -- advanced out of it and both sides took a loss, so there is no loser to send down.
    -- Returning the first side here would put a team that is already out back into the
    -- bracket, which is how an eliminated side used to reappear several rounds later.
    RETURN QUERY SELECT NULL::UUID, TRUE;
  ELSE
    RETURN QUERY SELECT (CASE WHEN v_winner = v_p1 THEN v_p2 ELSE v_p1 END), TRUE;
  END IF;
END;
$$;

-- How many playoff games a team has lost.
--
-- A double forfeit counts as a loss for both sides, since the rule is that each takes
-- one. So the test is "was on the losing side", which is anything that is not the winner,
-- rather than anything with no winner.
--
-- @returns The team's playoff losses, which is what decides elimination.
CREATE OR REPLACE FUNCTION public.playoff_side_losses(
  p_league_id UUID,
  p_season_id UUID,
  p_team UUID
) RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.status IN ('completed', 'forfeit', 'cancelled')
    AND p_team IN (m.player_1_team_id, m.player_2_team_id)
    AND (m.winner_team_id IS NULL OR m.winner_team_id <> p_team);
$$;

-- True when a team's only double forfeit has already put it out of the tournament.
--
-- A double forfeit charges both sides a loss, but it does not send them anywhere: a team
-- sitting on one loss has lost once and would normally be in the losers bracket, whereas a
-- team that lost because neither side turned up is out. The loss count alone cannot tell
-- the two apart, since both leave exactly one loss on the team's record, so this is what
-- separates them.
--
-- Used wherever "still in the tournament" is being decided: the losers bracket pool and
-- the last team standing. Without it a team knocked out in the winners bracket keeps
-- looking alive, which is what let a bracket that had barely started crown a champion.
--
-- @returns True when the team is on the losing side of a playoff game nobody won.
CREATE OR REPLACE FUNCTION public.playoff_double_forfeited(
  p_league_id UUID,
  p_season_id UUID,
  p_team UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.matches m
    WHERE m.league_id = p_league_id
      AND m.season_id = p_season_id
      AND m.is_playoff
      AND m.status IN ('completed', 'forfeit', 'cancelled')
      AND m.winner_team_id IS NULL
      AND p_team IN (m.player_1_team_id, m.player_2_team_id)
  );
$$;

-- The one team still on no losses, if there is exactly one.
--
-- More than one means the winners bracket is still running; none means every finalist has
-- taken a loss somewhere, which a double forfeit in the winners bracket final can do. The
-- grand final is played only when both this and playoff_one_loss return a team, because
-- the final is between the last side standing on no losses and the last on one.
--
-- HAVING over the whole result set returns the row only when exactly one team qualifies,
-- which is what "the one team" means here. A team that has not played yet is excluded, so
-- an untouched roster cannot be mistaken for an undefeated finalist.
CREATE OR REPLACE FUNCTION public.playoff_undefeated(
  p_league_id UUID,
  p_season_id UUID
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- min() over a uuid is not defined, and comparing uuid has no ordering that helps, so the
  -- single qualifying team is picked by the count instead: the query only returns when
  -- exactly one team matched, and any() then has only one value to choose from.
  SELECT (array_agg(t.id))[1]
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND public.playoff_side_losses(p_league_id, p_season_id, t.id) = 0
    AND EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.league_id = p_league_id
        AND m.season_id = p_season_id
        AND m.is_playoff
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)
    )
  HAVING COUNT(*) = 1;
$$;

-- The one team on exactly one loss, if there is exactly one.
--
-- A team on one loss has lost once and is still in the tournament, so this is the last
-- side standing in the losers bracket. A team knocked out by a double forfeit is excluded:
-- it also sits on one loss, but it is out rather than waiting to be knocked out again.
CREATE OR REPLACE FUNCTION public.playoff_one_loss(
  p_league_id UUID,
  p_season_id UUID
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (array_agg(t.id))[1]
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND public.playoff_side_losses(p_league_id, p_season_id, t.id) = 1
    AND NOT public.playoff_double_forfeited(p_league_id, p_season_id, t.id)
  HAVING COUNT(*) = 1;
$$;

-- True when the grand final needs a reset, meaning it was played and the winners
-- bracket finalist lost it.
--
-- A grand final that ended with neither side winning is deliberately not a reset. In the
-- first final that leaves the winners bracket finalist as the last side standing; after a
-- reset both finalists are eliminated and the season ends with no champion.
--
-- Who the winners bracket finalist was has to be read from the losers bracket's last game
-- rather than from the loss totals, because those cannot answer it any more. The final is
-- between the winners bracket champion and the losers bracket champion, and the losers
-- bracket champion is whoever won the final losers game, so that game names the finalists
-- directly. Asking "who is still on no losses" looks like the same question and is not:
-- once the first final has been played both finalists are on one loss, there is nobody on
-- zero, and the answer came back empty, so the reset was never due and the losers bracket
-- champion was crowned after losing the bracket's own deciding rule.
--
-- @returns TRUE when the two finalists must play each other again.
CREATE OR REPLACE FUNCTION public.playoff_reset_due(
  p_league_id UUID,
  p_season_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gf RECORD;
  v_gf_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_gf_count
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.bracket_phase = 'gf';

  -- No final at all, or the reset has already been played. A bracket reset is a single
  -- extra game and never a third one, so once both finals exist there is nothing left to
  -- decide. The first final is the one whose answer this function reads, so a second one
  -- would only ever be asked about itself and would keep answering yes.
  IF v_gf_count = 0 OR v_gf_count > 1 THEN
    RETURN FALSE;
  END IF;

  SELECT m.winner_team_id, m.player_1_team_id, m.player_2_team_id, m.status
  INTO v_gf
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.bracket_phase = 'gf'
  ORDER BY m.week_number ASC, m.bracket_slot ASC
  LIMIT 1;

  -- The first final is still to be played.
  IF v_gf.status IS NULL OR v_gf.status NOT IN ('completed', 'forfeit', 'cancelled') THEN
    RETURN FALSE;
  END IF;

  -- Nobody won it, so both finalists took a loss and neither is owed another game.
  IF v_gf.winner_team_id IS NULL THEN
    RETURN FALSE;
  END IF;

  /*
   * The final is written with the losers bracket champion first and the winners bracket
   * champion second, so the loser of it is always the side that came through undefeated.
   * That side has now taken a loss and still has a life, so the final is replayed exactly
   * when the side that had already lost is the one that won.
   */
  RETURN v_gf.winner_team_id = v_gf.player_1_team_id;
END;
$$;

-- Creates every bracket game whose feeders have all finished.
--
-- Every game in the winners and losers brackets comes from the declared structure, which
-- names who feeds each one, so it describes both exactly and walking it in round order is
-- the dependency order.
--
-- A double forfeit resolves to an empty side rather than to a team, and that is what makes
-- the structure work unchanged here. L1 is fed by the losers of G5 and G6; when G5 was a
-- double forfeit neither of its sides is coming down, so L1 has one side and the other team
-- takes the bye. Nothing has to be predicted about how many teams will arrive in a round,
-- and a round with an odd number of teams needs no special case -- the structure's own
-- "Bye" feeder is what says so.
--
-- Ordering the losers bracket by loss total instead -- pairing the pool of teams sitting on
-- one loss, in team id order -- produced real games but broke the correspondence with the
-- sheet. The bracket draws one card per labelled game and fills it from the game in the same
-- slot, so a pool-ordered game landing in the right slot is still the wrong game for the
-- card whose feeder names something else. That is how two cards came to show the same
-- matchup while the game actually feeding them was a third one.
--
-- The finals are the exception and are resolved below, from loss totals rather than from two
-- particular games.
--
-- A game whose feeders are not ready is skipped rather than ending the pass. After the first
-- winners round is played the second winners round and the first losers round are ready at the
-- same time -- the losers round reads the first round's losers, not the second round's -- but
-- the third winners round is not, because it needs winners that do not exist yet. Ending the
-- pass there meant the first losers round was never reached, and the bracket came back with an
-- empty losers tab and a full winners one.
--
-- @returns How many games were created, which is zero when there was nothing ready.
CREATE OR REPLACE FUNCTION public.playoff_advance(
  p_league_id UUID,
  p_season_id UUID,
  p_base_weeks INTEGER,
  p_seeds UUID[],
  p_field_size INTEGER,
  p_format TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_a UUID;
  v_b UUID;
  v_a_ready BOOLEAN;
  v_b_ready BOOLEAN;
  v_count INTEGER := 0;
  v_reset_due BOOLEAN := FALSE;
  v_size INTEGER;
  v_wb_rounds INTEGER;
  v_lb_rounds INTEGER;
  v_week INTEGER;
  v_winner_bracket_champion UUID;
  v_losers_bracket_champion UUID;
  v_press INTEGER;
BEGIN
  IF p_field_size < 2 THEN
    RETURN 0;
  END IF;

  v_size := public.playoff_next_power_of_two(p_field_size);
  v_wb_rounds := 0;
  WHILE (1 << v_wb_rounds) < v_size LOOP
    v_wb_rounds := v_wb_rounds + 1;
  END LOOP;

  v_lb_rounds := CASE
    WHEN p_format = 'double_elimination' THEN GREATEST((v_wb_rounds - 1) * 2, 1)
    ELSE 0
  END;

  /*
   * The bracket round number this press will stamp on everything it creates.
   *
   * One press writes several rounds at once -- the next winners round and the next losers
   * round land together, because both become ready from the same results -- so they all
   * carry one number. That is the whole point of numbering by press rather than by week:
   * a member sees one set of new matchups appear, and it should read as one round.
   */
  SELECT COALESCE(MAX(m.playoff_round_no), 0) + 1 INTO v_press
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff;

  -- Winners bracket and losers bracket, both from the declared structure.
  --
  -- The structure names who feeds every game in both brackets, so it describes both
  -- exactly, and walking it in round order is the dependency order. A losers game whose
  -- feeding game was a double forfeit resolves to an empty side, which is the bye: the
  -- game is created with one side and the other advances. Ordering the losers bracket by
  -- loss total instead is what broke this -- it paired the pool by team id, so the games
  -- it produced stopped corresponding to the cards the bracket sheet draws for them, and
  -- a card could show one matchup while the labelled game it fed was a different one.
  FOR v_row IN
    SELECT *
    FROM public.playoff_bracket_structure(p_field_size, p_base_weeks, p_format)
    WHERE phase IN ('upper', 'lower')
    ORDER BY round_no, slot
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.matches m
      WHERE m.league_id = p_league_id
        AND m.season_id = p_season_id
        AND m.is_playoff
        AND m.bracket_phase = v_row.phase
        AND m.week_number = v_row.week
        AND m.bracket_slot = v_row.slot
    ) THEN
      CONTINUE;
    END IF;

    SELECT f.team, f.ready INTO v_a, v_a_ready
    FROM public.playoff_feeder_team(
      p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks, p_format,
      v_row.feeder_a_kind, v_row.feeder_a_ref
    ) f;

    SELECT f.team, f.ready INTO v_b, v_b_ready
    FROM public.playoff_feeder_team(
      p_league_id, p_season_id, p_seeds, p_field_size, p_base_weeks, p_format,
      v_row.feeder_b_kind, v_row.feeder_b_ref
    ) f;

    -- Skipped, not fatal. A later round in the same pass may still be ready.
    IF NOT (v_a_ready AND v_b_ready) THEN
      CONTINUE;
    END IF;

    -- Both sides empty means the feeding games both ended without a winner, so there is
    -- nobody to advance and no game to record.
    IF v_a IS NOT NULL OR v_b IS NOT NULL THEN
      IF public.playoff_insert_game(
        p_league_id, p_season_id, v_row.week, v_a, v_b, v_row.phase, v_row.slot, v_press
      ) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  -- Finals, and only once both sides of them are settled.
  --
  -- Resolved from the loss totals rather than from two particular games: the final is the
  -- last team on no losses against the last team on one, which is not the same as "the
  -- winners of two games". A losers game that was never created leaves the bracket
  -- champion standing in a game that does not exist, and a final fed off that game would
  -- hand the title over without being played.
  --
  -- Losers bracket champion first, winners bracket champion second. That order is not
  -- cosmetic: the second side is the one that arrived undefeated, and losing the final is
  -- what means the pair has to play again. Both playoff_reset_due and playoff_champion read
  -- it that way.
  v_week := p_base_weeks + v_wb_rounds + v_lb_rounds + 1;

  IF v_lb_rounds > 0 AND NOT EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.league_id = p_league_id
      AND m.season_id = p_season_id
      AND m.is_playoff
      AND m.bracket_phase = 'gf'
      AND m.week_number = v_week
  ) THEN
    v_winner_bracket_champion := public.playoff_undefeated(p_league_id, p_season_id);
    v_losers_bracket_champion := public.playoff_one_loss(p_league_id, p_season_id);

    IF v_winner_bracket_champion IS NOT NULL AND v_losers_bracket_champion IS NOT NULL THEN
      IF public.playoff_insert_game(
        p_league_id, p_season_id, v_week, v_losers_bracket_champion, v_winner_bracket_champion, 'gf', 1, v_press
      ) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END IF;

  /*
   * The reset: the same two teams again, once, and only when the first final was won by the
   * losers bracket finalist.
   *
   * It replays the two sides of the first final in the order they had there, rather than
   * resolving them again. Re-resolving is how this went wrong once: the loss totals answer
   * a different question the moment the first final is played -- both finalists are on one
   * loss afterwards, so "the last team on no losses" is empty -- and reading them a second
   * time to build a second game can answer differently than they did for the first. Both
   * sides are already known here, and reusing them is the only way the replay is
   * guaranteed to be the same matchup.
   */
  v_week := p_base_weeks + v_wb_rounds + v_lb_rounds + 2;

  IF v_lb_rounds > 0 AND NOT EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.league_id = p_league_id
      AND m.season_id = p_season_id
      AND m.is_playoff
      AND m.bracket_phase = 'gf'
      AND m.week_number = v_week
  ) THEN
    v_reset_due := public.playoff_reset_due(p_league_id, p_season_id);

    IF v_reset_due THEN
      SELECT m.player_1_team_id, m.player_2_team_id
      INTO v_a, v_b
      FROM public.matches m
      WHERE m.league_id = p_league_id
        AND m.season_id = p_season_id
        AND m.is_playoff
        AND m.bracket_phase = 'gf'
      ORDER BY m.week_number ASC, m.bracket_slot ASC
      LIMIT 1;

      IF public.playoff_insert_game(
        p_league_id, p_season_id, v_week, v_a, v_b, 'gf', 1, v_press
      ) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END IF;

  RETURN v_count;
END;
$$;

-- The last team in the tournament, if there is exactly one.
--
-- A team is out on two losses, or on one loss taken as a double forfeit, so this is the
-- only side still standing when exactly one team is left under that. It covers the
-- endings the finals do not reach: a bracket that never got a final because a double
-- forfeit in the winners bracket final took a loss off both finalists, leaving nobody
-- undefeated and so nobody for a final to be against.
--
-- The double forfeit test is what stops a team knocked out mid-bracket being reported as
-- the last side standing, which is how a bracket one round in could name a champion.
--
-- NULL when nobody or several teams qualify, which is the ordinary state of a tournament
-- still running.
CREATE OR REPLACE FUNCTION public.playoff_last_standing(
  p_league_id UUID,
  p_season_id UUID
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (array_agg(t.id))[1]
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = p_season_id
    AND public.playoff_side_losses(p_league_id, p_season_id, t.id) < 2
    AND NOT public.playoff_double_forfeited(p_league_id, p_season_id, t.id)
    AND EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.league_id = p_league_id
        AND m.season_id = p_season_id
        AND m.is_playoff
        AND t.id IN (m.player_1_team_id, m.player_2_team_id)
    )
  HAVING COUNT(*) = 1;
$$;

-- The league champion, or NULL while the bracket is still running.
--
-- The final decides it whenever a final was played, produced a winner, and settled the
-- tournament. Everywhere else the champion is the last team standing on fewer than two
-- losses, which is the rule the bracket has used throughout and which covers the endings no
-- final reaches.
--
-- A first final won by the losers bracket champion is the case that is decided but not
-- settled: the winners bracket finalist lost having never been beaten, so the pair owe a
-- replay and there is no champion until it is played. Asking whether the reset is owed is
-- delegated to playoff_reset_due so that the rule allowing the replay and the rule
-- withholding the crown are one decision rather than two that can drift apart.
--
-- A final nobody won is settled by the loss rule rather than by a special case. In the
-- first final the losers bracket finalist is already on one loss, so a loss each takes them
-- to two and eliminates them, leaving the winners bracket finalist on one as the last side
-- standing. After a reset both finalists are already on one, so a loss each takes both to
-- two and the season ends with no champion at all, which is the rule as written rather than a
-- judgement call about who to promote.
CREATE OR REPLACE FUNCTION public.playoff_champion(
  p_league_id UUID,
  p_season_id UUID
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last RECORD;
  v_format TEXT;
BEGIN
  -- The two formats are out on a different number of losses, so they cannot share an
  -- ending. Single elimination is out on one, which means most of the field is still
  -- under the double elimination threshold of two when the bracket ends, and the last
  -- winners game is the only thing that can name a champion. Double elimination is out on
  -- two, where the last side standing is exactly the side on fewer than two.
  SELECT s.playoff_format INTO v_format
  FROM public.league_settings s
  WHERE s.season_id = p_season_id
  LIMIT 1;

  IF v_format IS DISTINCT FROM 'double_elimination' THEN
    SELECT m.winner_team_id, m.status
    INTO v_last
    FROM public.matches m
    WHERE m.league_id = p_league_id
      AND m.season_id = p_season_id
      AND m.is_playoff
      AND m.bracket_phase = 'upper'
    ORDER BY m.week_number DESC, m.bracket_slot DESC
    LIMIT 1;

    IF FOUND AND v_last.status IN ('completed', 'forfeit', 'cancelled') THEN
      RETURN v_last.winner_team_id;
    END IF;

    RETURN NULL;
  END IF;

  SELECT m.winner_team_id, m.status
  INTO v_last
  FROM public.matches m
  WHERE m.league_id = p_league_id
    AND m.season_id = p_season_id
    AND m.is_playoff
    AND m.bracket_phase = 'gf'
  ORDER BY m.week_number DESC, m.bracket_slot DESC
  LIMIT 1;

  IF FOUND
     AND v_last.status IN ('completed', 'forfeit', 'cancelled')
     AND v_last.winner_team_id IS NOT NULL THEN
    -- The losers bracket champion winning the first final does not crown anyone: the
    -- winners bracket finalist lost having never been beaten, and owes a replay. Reporting
    -- a champion here crowned them the moment GF1 was submitted, before anyone pressed
    -- Advance, which is precisely the gap the reset exists to cover.
    --
    -- Read from playoff_reset_due rather than re-derived, so the test that allows the replay
    -- and the test that withholds the crown can never disagree about the same game.
    IF public.playoff_reset_due(p_league_id, p_season_id) THEN
      RETURN NULL;
    END IF;

    RETURN v_last.winner_team_id;
  END IF;

  -- No final, or a final nobody won: whoever is left on fewer than two losses.
  RETURN public.playoff_last_standing(p_league_id, p_season_id);
END;
$$;

-- Generates the bracket from the standings, and advances it one ready step per call.
--
-- The field may be any size from two up to the number of teams in the league, and the
-- league size is the maximum. Seeds freeze on the first call, so results landing later
-- cannot reshuffle the tree.
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
  v_team_count INTEGER;
  v_state JSONB;
  v_seeds UUID[];
  v_j INTEGER;
  v_count INTEGER;
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

  SELECT COALESCE(playoff_team_count, 0),
         COALESCE(playoff_format, 'single_elimination'),
         COALESCE(regular_season_weeks, 0)
  INTO v_playoff_teams, v_playoff_format, v_base_weeks
  FROM public.league_settings
  WHERE season_id = v_season_id;

  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams
  WHERE league_id = p_league_id AND season_id = v_season_id;

  IF v_playoff_teams < 2 THEN
    RAISE EXCEPTION 'A playoff bracket needs at least 2 teams; this league is configured for %.', v_playoff_teams;
  END IF;

  IF v_playoff_teams > v_team_count THEN
    RAISE EXCEPTION 'A playoff bracket cannot be larger than the league; this league has % teams and is configured for %.', v_team_count, v_playoff_teams;
  END IF;

  v_state := COALESCE(
    (SELECT playoff_state_json FROM public.league_settings WHERE season_id = v_season_id),
    '{}'::jsonb
  );

  -- Seeds freeze on first run so later results cannot reshuffle the tree.
  v_seeds := ARRAY[]::UUID[];

  IF jsonb_typeof(v_state -> 'seeds') = 'array'
     AND jsonb_array_length(v_state -> 'seeds') >= v_playoff_teams THEN
    FOR v_j IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seeds := v_seeds || ARRAY[(v_state -> 'seeds' ->> v_j)::UUID]::UUID[];
    END LOOP;
  END IF;

  IF array_length(v_seeds, 1) IS NULL THEN
    SELECT ARRAY_AGG(st.team_id ORDER BY st.wins DESC, st.losses ASC, st.ko_diff DESC, st.team_name ASC)
    INTO v_seeds
    FROM public.season_standings(p_league_id) st;

    IF v_seeds IS NULL OR array_length(v_seeds, 1) < v_playoff_teams THEN
      RAISE EXCEPTION 'The bracket needs at least % teams with a record.', v_playoff_teams;
    END IF;

    v_seeds := v_seeds[1:v_playoff_teams];
    v_state := jsonb_set(v_state, '{seeds}', to_jsonb(v_seeds));
    UPDATE public.league_settings
    SET playoff_state_json = v_state, updated_at = NOW()
    WHERE season_id = v_season_id;
  END IF;

  v_count := public.playoff_advance(
    p_league_id, v_season_id, v_base_weeks, v_seeds, v_playoff_teams, v_playoff_format
  );

  -- A bye has no result to wait for, so it is settled here rather than left for a member
  -- to submit. Left unsettled the round it belongs to could never complete.
  PERFORM public.playoff_settle_pending_byes(p_league_id, v_season_id);

  RETURN v_count;
END;
$$;

-- Lifts the sixteen team ceiling off the playoff field.
--
-- The rules allow any field from two teams up to the size of the league, with the league
-- size as the maximum. The cap existed because only three bracket sizes had been written
-- by hand; the bracket is computed now, so the ceiling is the league itself.
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
  v_team_count INTEGER;
  v_n INTEGER;
  v_cycle INTEGER;
  v_list UUID[];
  v_new UUID[];
  v_pair_a UUID[];
  v_pair_b UUID[];
  v_last_keys TEXT[];
  v_keys TEXT[];
  v_attempt INTEGER;
  v_created INTEGER := 0;
  v_repeat BOOLEAN;
  v_a UUID;
  v_b UUID;
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

  IF p_match_format NOT IN ('single', 'best_of_3') THEN
    RAISE EXCEPTION 'Invalid regular season match format.';
  END IF;

  IF p_playoff_team_count IS NULL OR p_playoff_team_count < 0 THEN
    RAISE EXCEPTION 'Invalid playoff team count.';
  END IF;

  IF p_playoff_match_format NOT IN ('single', 'best_of_3') THEN
    RAISE EXCEPTION 'Invalid playoff match format.';
  END IF;

  IF p_playoff_format NOT IN ('single_elimination', 'double_elimination') THEN
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

  -- Checked against the league rather than a fixed ceiling, since a field cannot be
  -- larger than the number of teams available to fill it.
  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams
  WHERE league_id = p_league_id AND season_id = v_season_id;

  IF p_playoff_team_count > v_team_count THEN
    RAISE EXCEPTION 'Playoff teams cannot exceed the league size of %.', v_team_count;
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

  SELECT ARRAY_AGG(t.id) INTO v_teams
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_season_id;

  IF v_teams IS NULL OR array_length(v_teams, 1) < 2 THEN
    RAISE EXCEPTION 'At least two teams are required to generate a schedule.';
  END IF;

  v_list := v_teams;
  v_n := array_length(v_list, 1);

  -- With an odd number of teams, append a bye sentinel so the circle method
  -- pairs every real team exactly once and one team rests each week. Because the
  -- list is shuffled, the bye walks around the league rather than always falling
  -- to the same team.
  IF v_n % 2 = 1 THEN
    v_list := v_list || ARRAY[NULL::UUID];
    v_n := v_n + 1;
  END IF;

  -- A full round-robin over v_n slots takes v_n - 1 weeks and then the rotation
  -- returns to where it started, so anything beyond that is a repeat pass.
  v_cycle := v_n - 1;
  v_last_keys := ARRAY[]::TEXT[];

  FOR v_w IN 1..p_weeks LOOP
    -- Re-draw the arrangement at the start of every cycle so repeat passes
    -- produce different pairings rather than replaying the same week set.
    IF (v_w - 1) % v_cycle = 0 THEN
      v_list := public.shuffle_uuid_array(v_list);
    END IF;

    -- Draw a week whose matchups do not repeat the previous week's. Within a
    -- cycle the circle method never repeats a pair, so this only bites when the
    -- rotation wraps, and twelve re-draws make a repeat vanishingly unlikely.
    v_attempt := 0;
    LOOP
      v_pair_a := ARRAY[]::UUID[];
      v_pair_b := ARRAY[]::UUID[];
      v_keys := ARRAY[]::TEXT[];

      FOR v_i IN 1..(v_n / 2) LOOP
        v_a := v_list[v_i];
        v_b := v_list[v_n + 1 - v_i];
        IF v_a IS NULL OR v_b IS NULL OR v_a = v_b THEN
          CONTINUE;
        END IF;
        v_pair_a := array_append(v_pair_a, v_a);
        v_pair_b := array_append(v_pair_b, v_b);
        v_keys := v_keys || ARRAY[
          LEAST(v_a::TEXT, v_b::TEXT) || '~' || GREATEST(v_a::TEXT, v_b::TEXT)
        ];
      END LOOP;

      SELECT EXISTS (
        SELECT 1 FROM unnest(v_keys) k WHERE k = ANY (v_last_keys)
      ) INTO v_repeat;

      v_attempt := v_attempt + 1;
      EXIT WHEN NOT v_repeat OR v_attempt >= 12;

      v_list := public.shuffle_uuid_array(v_list);
    END LOOP;

    FOR v_i IN 1..array_length(v_pair_a, 1) LOOP
      v_a := v_pair_a[v_i];
      v_b := v_pair_b[v_i];

      -- Coin flip the home/away side so no team is permanently the guest.
      IF random() >= 0.5 THEN
        v_a := v_pair_b[v_i];
        v_b := v_pair_a[v_i];
      END IF;

      INSERT INTO public.matches (league_id, season_id, week_number, is_playoff, player_1_team_id, player_2_team_id, status, bracket_phase)
      VALUES (p_league_id, v_season_id, v_w, FALSE, v_a, v_b, 'scheduled', NULL);
      v_created := v_created + 1;
    END LOOP;

    v_last_keys := v_keys;

    -- Rotate the arrangement for the next week, holding position 1 fixed so the
    -- mirror pairing visits a fresh opponent every week within a cycle.
    v_new := ARRAY[v_list[1], v_list[v_n]]::UUID[];
    IF v_n > 2 THEN
      FOR v_i IN 2..(v_n - 1) LOOP
        v_new := v_new || ARRAY[v_list[v_i]]::UUID[];
      END LOOP;
    END IF;
    v_list := v_new;
  END LOOP;

  RETURN v_created;
END;
$$;

-- Dropped rather than replaced, because the slot column below changes the row type and
-- Postgres refuses to alter the return type of an existing function in place. The grants
-- at the end of this migration put the permissions back.
DROP FUNCTION IF EXISTS public.playoff_bracket_template(UUID);

-- Lists every game the bracket will contain, for the preview on the schedule page.
--
-- Read from the same structure the generator uses, so the sheet a member looks at
-- before the draft finishes and the games that actually get created cannot disagree.
-- A side that is a known seed resolves to a team id once the seed list is frozen;
-- everything else depends on a game that has not been played and stays null for the
-- client to fill in from the matches that do exist.
CREATE OR REPLACE FUNCTION public.playoff_bracket_template(p_league_id UUID)
RETURNS TABLE (
  game_label TEXT,
  phase TEXT,
  round_no INTEGER,
  week INTEGER,
  -- The game's position within its round, which is the number the generator stores as
  -- bracket_slot. The client joins preview rows to real matches on this, so it has to be
  -- exposed: the numbering is not always a plain 1..n, because a round padded out for
  -- byes keeps the padded positions. A twelve team field's first round, where four seeds
  -- hold byes, runs G5 to G8 and not G1 to G4, and pairing rows to games by their position
  -- in the list instead of by this number drew every first round game twice -- once as the
  -- preview and again as an extra card.
  slot INTEGER,
  -- Each side is rendered as text the client shows verbatim in an empty slot.
  feeder_a TEXT,
  feeder_b TEXT,
  -- The team id behind a side, when that side is already a known seed.
  team_a UUID,
  team_b UUID,
  is_grand_final BOOLEAN,
  -- True for the reset match, which only exists if the grand final goes long.
  is_reset BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id UUID;
  v_seeds UUID[];
  v_field INTEGER;
  v_base INTEGER;
  v_format TEXT;
  v_state JSONB;
  v_row RECORD;
  v_i INTEGER;
  v_ref TEXT;
  v_kind TEXT;
BEGIN
  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  SELECT COALESCE(regular_season_weeks, 0),
         COALESCE(playoff_team_count, 0),
         COALESCE(playoff_format, 'single_elimination')
  INTO v_base, v_field, v_format
  FROM public.league_settings
  WHERE season_id = v_season_id;

  IF v_field < 2 THEN
    RETURN;
  END IF;

  -- Seeds are read straight from the frozen list when there is one, so the template
  -- names the same teams the generator will use. Before the first advance there is
  -- nothing frozen yet and seed slots simply have no team id.
  v_seeds := ARRAY[]::UUID[];
  SELECT COALESCE(playoff_state_json, '{}'::JSONB) INTO v_state
  FROM public.league_settings
  WHERE season_id = v_season_id;

  IF jsonb_typeof(v_state -> 'seeds') = 'array' THEN
    FOR v_i IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seeds := v_seeds || ARRAY[(v_state -> 'seeds' ->> v_i)::UUID]::UUID[];
    END LOOP;
  END IF;

  FOR v_row IN
    SELECT * FROM public.playoff_bracket_structure(v_field, v_base, v_format)
    ORDER BY round_no, slot
  LOOP
    game_label := v_row.game_label;
    phase := v_row.phase;
    round_no := v_row.round_no;
    week := v_row.week;
    slot := v_row.slot;
    is_grand_final := v_row.phase = 'gf';
    is_reset := v_row.game_label = 'GF2';

    v_kind := v_row.feeder_a_kind;
    v_ref := v_row.feeder_a_ref;

    IF v_kind = 'seed' THEN
      feeder_a := 'seed ' || v_ref;
    ELSIF v_kind = 'winner' THEN
      feeder_a := 'W(' || v_ref || ')';
    ELSIF v_kind = 'loser' THEN
      feeder_a := 'L(' || v_ref || ')';
    ELSE
      feeder_a := 'Bye';
    END IF;

    v_kind := v_row.feeder_b_kind;
    v_ref := v_row.feeder_b_ref;

    IF v_kind = 'seed' THEN
      feeder_b := 'seed ' || v_ref;
    ELSIF v_kind = 'winner' THEN
      feeder_b := 'W(' || v_ref || ')';
    ELSIF v_kind = 'loser' THEN
      feeder_b := 'L(' || v_ref || ')';
    ELSE
      feeder_b := 'Bye';
    END IF;

    team_a := CASE
      WHEN v_row.feeder_a_kind = 'seed'
       AND array_length(v_seeds, 1) >= v_row.feeder_a_ref::INTEGER
        THEN v_seeds[v_row.feeder_a_ref::INTEGER]
    END;

    team_b := CASE
      WHEN v_row.feeder_b_kind = 'seed'
       AND array_length(v_seeds, 1) >= v_row.feeder_b_ref::INTEGER
        THEN v_seeds[v_row.feeder_b_ref::INTEGER]
    END;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.playoff_next_power_of_two(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_bracket_structure(INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_side_losses(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_double_forfeited(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_undefeated(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_one_loss(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_side_losses(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_double_forfeited(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_undefeated(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_one_loss(UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.playoff_feeder_team(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_game_resolved(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_reset_due(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_round_number(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_insert_game(UUID, UUID, INTEGER, UUID, UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_round_number(UUID, UUID, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_insert_game(UUID, UUID, INTEGER, UUID, UUID, TEXT, INTEGER, INTEGER) TO authenticated;

REVOKE ALL ON FUNCTION public.playoff_advance(UUID, UUID, INTEGER, UUID[], INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_champion(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_last_standing(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_champion(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_last_standing(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.generate_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_playoff_round(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playoff_bracket_template(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.playoff_next_power_of_two(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_bracket_structure(INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_feeder_team(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_game_resolved(UUID, UUID, UUID[], INTEGER, INTEGER, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_reset_due(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_advance(UUID, UUID, INTEGER, UUID[], INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_last_standing(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_schedule(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_playoff_round(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playoff_bracket_template(UUID) TO authenticated;