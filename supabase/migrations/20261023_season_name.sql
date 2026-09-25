-- Adds an optional display name to seasons plus the owner-only RPC that sets it.
--
-- Existing rows keep name = NULL and keep rendering as "Season <number>", so this
-- migration is additive and safe to run on a live league mid-season. Saving a
-- blank name clears it back to the numbered fallback.

-- Optional display name for the season. NULL means "fall back to the season number".
ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS name TEXT;

COMMENT ON COLUMN public.seasons.name IS
  'Optional owner-set display name for the season. NULL falls back to "Season <season_number>".';

-- Blank or oversized names are rejected at the column level as well as in the
-- RPC, because owners can already update seasons directly through the
-- "Owners can update seasons for their leagues" policy. The DO block keeps the
-- constraint addition idempotent (PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seasons_name_not_blank'
      AND conrelid = 'public.seasons'::regclass
  ) THEN
    ALTER TABLE public.seasons
      ADD CONSTRAINT seasons_name_not_blank
      CHECK (
        name IS NULL
        OR (btrim(name) <> '' AND char_length(name) <= 80)
      );
  END IF;
END;
$$;

-- Sets (or clears) the display name of a league's most recent season.
--
-- Parameters:
--   p_league_id - League whose latest season should be renamed.
--   p_name      - Desired name; trimmed, and blank/NULL clears it back to NULL.
--
-- Errors: 'You must be signed in' when unauthenticated, 'Only the league owner'
-- when the caller does not own the league, and the length error when the trimmed
-- name exceeds 80 characters.
CREATE OR REPLACE FUNCTION public.set_season_name(
  p_league_id UUID,
  p_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_name TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to rename a season.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can rename a season.';
  END IF;

  v_name := btrim(p_name);

  IF v_name = '' THEN
    v_name := NULL;
  END IF;

  IF v_name IS NOT NULL AND char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'Season name must be 80 characters or fewer.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  UPDATE public.seasons
  SET name = v_name
  WHERE id = v_season_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_season_name(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_season_name(UUID, TEXT) TO authenticated;
