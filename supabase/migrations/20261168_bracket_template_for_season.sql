-- Draws a bracket's sheet for a named season rather than for whichever season is newest.
--
-- Both template functions resolved the league's latest season themselves. That is right for
-- the live Playoffs tab and wrong for one looking back: a past season's page would draw the
-- current season's tree, with the current season's seeds, over the past season's results.
--
-- The two existing functions keep their signatures and now delegate, so there is one
-- implementation of each sheet. A NULL season means "the newest", which is what every
-- existing caller gets without changing.

/*
 * The playoff sheet for one season.
 *
 * Read from the same structure the generator uses, so the sheet a member looks at and the
 * games that actually get created cannot disagree. A side that is a known seed resolves to
 * a team id once the seed list is frozen; everything else depends on a game that has not
 * been played and stays null for the client to fill in from the matches that do exist.
 *
 * @param p_league_id - The league the season belongs to.
 * @param p_season_id - The season to draw, or NULL for the league's newest.
 * @returns One row per game the bracket will contain.
 */
CREATE OR REPLACE FUNCTION public.playoff_bracket_template_for(
  p_league_id UUID,
  p_season_id UUID
)
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
  IF p_season_id IS NULL THEN
    SELECT s.id INTO v_season_id
    FROM public.seasons s
    WHERE s.league_id = p_league_id
    ORDER BY s.season_number DESC
    LIMIT 1;

    IF v_season_id IS NULL THEN
      RAISE EXCEPTION 'This league has no seasons yet.';
    END IF;
  ELSE
    SELECT s.id INTO v_season_id
    FROM public.seasons s
    WHERE s.id = p_season_id
      AND s.league_id = p_league_id;

    IF v_season_id IS NULL THEN
      RAISE EXCEPTION 'That season does not belong to this league.';
    END IF;
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

/*
 * The toilet sheet for one season.
 *
 * Same shape as the playoff sheet so the client can merge the two lists and draw them with
 * one component. Returns nothing when the setting is off or nobody missed the playoffs,
 * which is what lets the client call it unconditionally.
 *
 * @param p_league_id - The league the season belongs to.
 * @param p_season_id - The season to draw, or NULL for the league's newest.
 * @returns One row per consolation game, labelled T<n>.
 */
CREATE OR REPLACE FUNCTION public.toilet_bracket_template_for(
  p_league_id UUID,
  p_season_id UUID
)
RETURNS TABLE (
  game_label TEXT,
  phase TEXT,
  round_no INTEGER,
  week INTEGER,
  slot INTEGER,
  feeder_a TEXT,
  feeder_b TEXT,
  team_a UUID,
  team_b UUID,
  is_grand_final BOOLEAN,
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
  v_playoff_teams INTEGER;
  v_enabled BOOLEAN;
  v_row RECORD;
  v_kind TEXT;
  v_ref TEXT;
BEGIN
  IF p_season_id IS NULL THEN
    SELECT s.id INTO v_season_id
    FROM public.seasons s
    WHERE s.league_id = p_league_id
    ORDER BY s.season_number DESC
    LIMIT 1;
  ELSE
    SELECT s.id INTO v_season_id
    FROM public.seasons s
    WHERE s.id = p_season_id
      AND s.league_id = p_league_id;

    IF v_season_id IS NULL THEN
      RAISE EXCEPTION 'That season does not belong to this league.';
    END IF;
  END IF;

  IF v_season_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(ls.enable_toilet_bowl, FALSE),
         COALESCE(ls.playoff_team_count, 0),
         COALESCE(ls.regular_season_weeks, 0)
  INTO v_enabled, v_playoff_teams, v_base
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  IF NOT COALESCE(v_enabled, FALSE) THEN
    RETURN;
  END IF;

  v_seeds := public.toilet_seeds(p_league_id, v_season_id, v_playoff_teams);
  v_field := COALESCE(array_length(v_seeds, 1), 0);

  IF v_field < 2 THEN
    RETURN;
  END IF;

  FOR v_row IN
    SELECT src.*
    FROM public.playoff_bracket_structure(v_field, v_base, 'single_elimination') AS src
    WHERE src.phase = 'upper'
    ORDER BY src.round_no, src.slot
  LOOP
    /*
     * Toilet games carry their own labels.
     *
     * The structure numbers every bracket's games from G1, so reusing its labels here put
     * G5, G6 and G7 in the winners bracket and the Toilet Bowl at the same time. Relabelling
     * to T<n> keeps them distinct, and the feeder references below are rewritten to match so
     * a game still points at the game that feeds it.
     */
    game_label := 'T' || substring(v_row.game_label FROM 2);
    phase := 'toilet';
    round_no := v_row.round_no;
    week := v_row.week;
    slot := v_row.slot;
    is_grand_final := FALSE;
    is_reset := FALSE;

    v_kind := v_row.feeder_a_kind;
    v_ref := v_row.feeder_a_ref;

    IF v_kind = 'seed' THEN
      feeder_a := 'seed ' || v_ref;
    ELSIF v_kind = 'winner' THEN
      feeder_a := 'W(T' || substring(v_ref FROM 2) || ')';
    ELSE
      feeder_a := 'Bye';
    END IF;

    v_kind := v_row.feeder_b_kind;
    v_ref := v_row.feeder_b_ref;

    IF v_kind = 'seed' THEN
      feeder_b := 'seed ' || v_ref;
    ELSIF v_kind = 'winner' THEN
      feeder_b := 'W(T' || substring(v_ref FROM 2) || ')';
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

-- The originals keep their signatures and now mean "the newest season", so every existing
-- caller keeps working and there is still only one implementation of each sheet.

CREATE OR REPLACE FUNCTION public.playoff_bracket_template(p_league_id UUID)
RETURNS TABLE (
  game_label TEXT,
  phase TEXT,
  round_no INTEGER,
  week INTEGER,
  slot INTEGER,
  feeder_a TEXT,
  feeder_b TEXT,
  team_a UUID,
  team_b UUID,
  is_grand_final BOOLEAN,
  is_reset BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.playoff_bracket_template_for(p_league_id, NULL::UUID);
$$;

CREATE OR REPLACE FUNCTION public.toilet_bracket_template(p_league_id UUID)
RETURNS TABLE (
  game_label TEXT,
  phase TEXT,
  round_no INTEGER,
  week INTEGER,
  slot INTEGER,
  feeder_a TEXT,
  feeder_b TEXT,
  team_a UUID,
  team_b UUID,
  is_grand_final BOOLEAN,
  is_reset BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.toilet_bracket_template_for(p_league_id, NULL::UUID);
$$;

REVOKE ALL ON FUNCTION public.playoff_bracket_template_for(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toilet_bracket_template_for(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_bracket_template_for(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toilet_bracket_template_for(UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.playoff_bracket_template(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toilet_bracket_template(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_bracket_template(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toilet_bracket_template(UUID) TO authenticated;
