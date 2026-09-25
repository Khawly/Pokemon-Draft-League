-- Keeps match_results.pokemon_left_alive unsigned so the KO differential cannot
-- invert a team's standings.
--
-- The column records how many Pokemon the *winner* of a game had left standing.
-- The sign of a game's contribution is derived from winner_team_id by
-- season_standings, which adds the count for the winning team and subtracts it
-- for the losing team. A negative value therefore applies the sign twice and
-- silently reverses the differential for both teams: a game that should read
-- "-2" for the loser and "+2" for the winner instead scores the reverse.
--
-- submit_game_result already validates the argument with BETWEEN 0 AND 6, so
-- the bad value can only arrive from a write that bypasses the RPC. This
-- migration normalizes any existing signed values and adds a column-level
-- CHECK as a backstop.

-- Normalize existing rows before adding the constraint, since the constraint
-- would otherwise fail to apply on a league that already holds a negative count.
-- A signed value is repaired rather than rejected: its magnitude is the survivor
-- count the winner's team reported, and the sign is re-derived from the winner.
UPDATE public.match_results
SET pokemon_left_alive = abs(pokemon_left_alive)
WHERE pokemon_left_alive < 0;

-- The DO block keeps the constraint addition idempotent (PostgreSQL has no
-- ADD CONSTRAINT IF NOT EXISTS), matching the seasons_name_not_blank pattern.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'match_results_pokemon_left_alive_unsigned'
      AND conrelid = 'public.match_results'::regclass
  ) THEN
    ALTER TABLE public.match_results
      ADD CONSTRAINT match_results_pokemon_left_alive_unsigned
      CHECK (
        pokemon_left_alive IS NULL
        OR pokemon_left_alive BETWEEN 0 AND 6
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.match_results.pokemon_left_alive IS
  'Pokemon the winning team had left standing (unsigned, 0-6). The differential sign is derived from winner_team_id by season_standings, so this column must never be negative.';
