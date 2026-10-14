-- Describes the whole bracket before any of it has been played.
--
-- generate_playoff_round creates one round at a time, because a later round cannot be
-- inserted until its feeders have produced winners: a matches row needs two real team
-- ids. The consequence on the schedule page was that the playoffs tab could only ever
-- render rounds that already existed, so a fresh bracket showed one round and an empty
-- page afterwards, and a member had no way to see the shape of the tournament, where
-- their byes landed, or how far a loser had to go.
--
-- This returns the bracket's skeleton instead: every game that will ever be played, in
-- order, with each side described by what feeds it. A side is a seed, a reference to
-- another game's winner or loser, or a bye.
--
-- The pairings live here rather than in TypeScript so the template and the generator
-- read from one place. playoff_advance_12 states the same tree; both were written from
-- the league's twelve-team bracket, and duplicating the structure client-side would let
-- what is promised and what is generated drift apart.
--
-- Every game is listed unconditionally, including the grand final and the reset match
-- that only happens if the lower-bracket champion loses. Showing them from the start is
-- the point: a member should be able to see the whole road, not just the round they
-- happen to be in.

CREATE OR REPLACE FUNCTION public.playoff_bracket_template(p_league_id UUID)
RETURNS TABLE (
  game_label TEXT,
  phase TEXT,
  round_no INTEGER,
  week INTEGER,
  -- Each side is rendered as text the client shows verbatim in an empty slot.
  feeder_a TEXT,
  feeder_b TEXT,
  -- The team id behind a side, when that side is already a known seed. NULL for a
  -- side that depends on an earlier game, or a bye.
  team_a UUID,
  team_b UUID,
  is_grand_final BOOLEAN,
  -- True for the reset match, which only exists if the grand final goes to a full
  -- three games. Still listed so the bracket reads as complete.
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
  v_base INTEGER;
  v_template JSONB;
  v_row JSONB;
  v_state JSONB;
  i INTEGER;
BEGIN
  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  SELECT COALESCE(regular_season_weeks, 0) INTO v_base
  FROM public.league_settings
  WHERE season_id = v_season_id;

  -- Seeds are read straight from the frozen list when there is one, so the template
  -- names the same teams the generator will use. Before the first advance there is
  -- nothing frozen yet and seed slots simply have no team id.
  v_seeds := ARRAY[]::uuid[];
  SELECT COALESCE(playoff_state_json, '{}'::jsonb)
  INTO v_state
  FROM public.league_settings
  WHERE season_id = v_season_id;

  IF jsonb_typeof(v_state -> 'seeds') = 'array' THEN
    FOR i IN 0..(jsonb_array_length(v_state -> 'seeds') - 1) LOOP
      v_seeds := v_seeds || ARRAY[(v_state -> 'seeds' ->> i)::uuid]::uuid[];
    END LOOP;
  END IF;

  v_template := jsonb_build_array(
    -- Upper bracket. Seeds one to four sit out round one and are matched against
    -- specific round-one winners, so they surface here rather than as absences.
    jsonb_build_object('label','G1',   'phase','upper','round',1,'week',v_base+1,'a','seed 11','b','seed 12','as',11,'bs',12),
    jsonb_build_object('label','G2',   'phase','upper','round',1,'week',v_base+1,'a','seed 9', 'b','seed 10','as',9, 'bs',10),
    jsonb_build_object('label','G3',   'phase','upper','round',1,'week',v_base+1,'a','seed 7', 'b','seed 8', 'as',7, 'bs',8),
    jsonb_build_object('label','G4',   'phase','upper','round',1,'week',v_base+1,'a','seed 5', 'b','seed 6', 'as',5, 'bs',6),
    jsonb_build_object('label','G5',   'phase','upper','round',2,'week',v_base+2,'a','seed 1', 'b','W(G1)'),
    jsonb_build_object('label','G6',   'phase','upper','round',2,'week',v_base+2,'a','seed 2', 'b','W(G2)'),
    jsonb_build_object('label','G7',   'phase','upper','round',2,'week',v_base+2,'a','seed 3', 'b','W(G3)'),
    jsonb_build_object('label','G8',   'phase','upper','round',2,'week',v_base+2,'a','seed 4', 'b','W(G4)'),
    jsonb_build_object('label','G15',  'phase','upper','round',3,'week',v_base+3,'a','W(G5)', 'b','W(G6)'),
    jsonb_build_object('label','G16',  'phase','upper','round',3,'week',v_base+3,'a','W(G7)', 'b','W(G8)'),
    jsonb_build_object('label','G19',  'phase','upper','round',4,'week',v_base+4,'a','W(G15)','b','W(G16)'),

    -- Lower bracket. Round one pairs each first-round loser against a second-round
    -- loser, which is what lets all eight resolve at once.
    jsonb_build_object('label','G9',   'phase','lower','round',5,'week',v_base+3,'a','L(G1)', 'b','L(G8)'),
    jsonb_build_object('label','G10',  'phase','lower','round',5,'week',v_base+3,'a','L(G2)', 'b','L(G7)'),
    jsonb_build_object('label','G11',  'phase','lower','round',5,'week',v_base+3,'a','L(G3)', 'b','L(G6)'),
    jsonb_build_object('label','G12',  'phase','lower','round',5,'week',v_base+3,'a','L(G4)', 'b','L(G5)'),
    jsonb_build_object('label','G13',  'phase','lower','round',6,'week',v_base+4,'a','W(G9)', 'b','W(G10)'),
    jsonb_build_object('label','G14',  'phase','lower','round',6,'week',v_base+4,'a','W(G11)','b','W(G12)'),
    jsonb_build_object('label','G20',  'phase','lower','round',7,'week',v_base+5,'a','W(G13)','b','L(G15)'),
    jsonb_build_object('label','G21',  'phase','lower','round',7,'week',v_base+5,'a','W(G14)','b','L(G16)'),
    jsonb_build_object('label','G22',  'phase','lower','round',8,'week',v_base+6,'a','W(G20)','b','W(G21)'),
    jsonb_build_object('label','G23',  'phase','lower','round',9,'week',v_base+7,'a','L(G19)','b','W(G22)'),

    -- Grand final, then the reset that only happens if it goes long.
    jsonb_build_object('label','G24',  'phase','gf','round',10,'week',v_base+8,'a','W(G23)','b','W(G19)','gf',true),
    jsonb_build_object('label','G25',  'phase','gf','round',11,'week',v_base+9,'a','W(G24)','b','L(G24)','gf',true,'reset',true)
  );

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_template) LOOP
    game_label := v_row ->> 'label';
    phase := v_row ->> 'phase';
    round_no := (v_row ->> 'round')::INTEGER;
    week := (v_row ->> 'week')::INTEGER;
    feeder_a := v_row ->> 'a';
    feeder_b := v_row ->> 'b';
    is_grand_final := COALESCE((v_row ->> 'gf')::BOOLEAN, FALSE);
    is_reset := COALESCE((v_row ->> 'reset')::BOOLEAN, FALSE);

    -- Seeds resolve to a team once the list is frozen; everything else depends on a
    -- game that has not been played yet and stays NULL for the client to fill in.
    team_a := CASE
      WHEN v_row ? 'as' AND array_length(v_seeds, 1) >= (v_row ->> 'as')::INTEGER
        THEN v_seeds[(v_row ->> 'as')::INTEGER]
    END;
    team_b := CASE
      WHEN v_row ? 'bs' AND array_length(v_seeds, 1) >= (v_row ->> 'bs')::INTEGER
        THEN v_seeds[(v_row ->> 'bs')::INTEGER]
    END;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.playoff_bracket_template(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_bracket_template(UUID) TO authenticated;