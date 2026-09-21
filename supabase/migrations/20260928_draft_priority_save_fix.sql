-- Repairs `save_priority_list` introduced in 20260927.
--
-- The previous version used MIN(auto_pick) / MIN(skip_pick) when snapshotting
-- a round's flags. PostgreSQL has no aggregate function named min(boolean), so
-- every call raised "function min(boolean) does not exist" and priority list
-- saves never persisted. This redefines the function with bool_or (the correct
-- boolean aggregate) to keep flags through the DELETE + INSERT rewrite.

-- Atomically replaces the calling user's priority list for the season from a
-- JSON payload of {round_number, pokemon_id} entries, in display order. The
-- leftmost entry in a round becomes the highest priority (slot_index 0). A
-- Pokemon may appear in multiple rounds but never twice within one round, and
-- every entry must be a Pokemon from the season's draft pool.
--
-- Security: SECURITY DEFINER, keyed to auth.uid(), so one member can never
-- read or clobber another member's list. Per-round auto_pick / skip_pick
-- flags already stored on the user's rows are carried into the rewritten rows.
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

  -- Snapshot the per-round flags before the rows are deleted below. Every row
  -- of a round's band carries the same flag pair, so one row per round.
  -- (bool_or is used because PostgreSQL has no MIN/MAX aggregate for boolean.)
  CREATE TEMP TABLE tmp_priority_round_flags
  ON COMMIT DROP AS
  SELECT round_number, bool_or(auto_pick) AS auto_pick, bool_or(skip_pick) AS skip_pick
  FROM public.draft_priority_lists
  WHERE season_id = v_season_id AND user_id = v_user_id
  GROUP BY round_number;

  DELETE FROM public.draft_priority_lists
  WHERE season_id = v_season_id AND user_id = v_user_id;

  INSERT INTO public.draft_priority_lists
    (league_id, season_id, user_id, round_number, slot_index, pokemon_id, auto_pick, skip_pick)
  SELECT
    p_league_id,
    v_season_id,
    v_user_id,
    (entry->>'round_number')::INTEGER AS round_number,
    ROW_NUMBER() OVER (
      PARTITION BY entry->>'round_number' ORDER BY ordinality
    ) - 1 AS slot_index,
    entry->>'pokemon_id' AS pokemon_id,
    COALESCE(f.auto_pick, FALSE) AS auto_pick,
    COALESCE(f.skip_pick, FALSE) AS skip_pick
  FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS entries(entry, ordinality)
  LEFT JOIN tmp_priority_round_flags f
    ON f.round_number = (entry->>'round_number')::INTEGER
  WHERE entry->>'pokemon_id' IS NOT NULL AND entry->>'round_number' IS NOT NULL
  ORDER BY ordinality;

  GET DIAGNOSTICS v_entries_count = ROW_COUNT;

  RETURN v_entries_count;
END;
$$;