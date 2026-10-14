-- Makes "Advance playoffs" actually build a bracket.
--
-- playoff_seed_order mirrored each seed against the FINAL bracket size:
--
--   v_next := v_next || ARRAY[v_seed, p_slots + 1 - v_seed]
--
-- The mirror has to be against the bracket as grown so far, not the bracket it will
-- eventually reach. Mirroring against p_slots from the very first iteration collapses
-- every position onto the two ends, so for a 16-slot bracket it returned:
--
--   1, 16, 16, 1, 16, 1, 1, 16, 16, 1, 1, 16, 1, 16, 16, 1
--
-- Positions 2 through 15 are never produced at any bracket size. Only seed 1 and a
-- beyond-the-field slot are ever addressed.
--
-- generate_playoff_round maps that order onto the seeded teams, so for a 12-team
-- field in a 16-slot bracket the survivor list became:
--
--   seed1, NULL, NULL, seed1, NULL, seed1, seed1, NULL, NULL, seed1, seed1, NULL,
--   seed1, NULL, NULL, seed1
--
-- Every adjacent pair had a NULL in it, and the creation loop skips those:
--
--   IF v_team_a IS NULL OR v_team_b IS NULL THEN CONTINUE;
--
-- so every pairing was skipped, v_count stayed 0, and the function returned 0 having
-- written nothing. No error, no exception, just an empty result -- which is why the
-- button appeared to do nothing at all.
--
-- Mirroring against 2 * <current length> + 1 grows the bracket correctly:
--
--   1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11
--
-- which is the standard seed order, pairing 1v16, 8v9, 4v13, 5v12 and so on. With a
-- 12-team field the four pairings involving slots 13-16 have a NULL and correctly
-- become byes, leaving four real first-round matches.

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
      v_mirror INTEGER;
    BEGIN
      WHILE v_size < p_slots LOOP
        v_next := ARRAY[]::INTEGER[];
        -- Mirrors the half that already exists, not the final bracket. Using
        -- p_slots here is what collapsed every slot onto the two ends.
        v_mirror := (v_size * 2) + 1;
        FOREACH v_seed IN ARRAY v_order LOOP
          v_next := v_next || ARRAY[v_seed, v_mirror - v_seed]::INTEGER[];
        END LOOP;
        v_order := v_next;
        v_size := v_size * 2;
      END LOOP;
      RETURN v_order;
    END;
$$;

-- Re-issued so the migration is self-contained on a fresh replay.
REVOKE ALL ON FUNCTION public.playoff_seed_order(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playoff_seed_order(INTEGER) TO authenticated;