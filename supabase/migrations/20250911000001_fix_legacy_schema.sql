-- Fix stale updated_at trigger behavior on tables that may not yet have an updated_at column.
--
-- Replacement migration: redefines the update_updated_at trigger function so
-- it only stamps updated_at when the firing table actually has that column,
-- then drops and recreates the per-table triggers to retire the older,
-- unconditionally-stamping behavior.

DROP TRIGGER IF EXISTS leagues_updated_at ON public.leagues;
DROP TRIGGER IF EXISTS seasons_updated_at ON public.seasons;
DROP TRIGGER IF EXISTS league_settings_updated_at ON public.league_settings;
DROP TRIGGER IF EXISTS draft_pools_updated_at ON public.draft_pools;
DROP TRIGGER IF EXISTS draft_pool_pokemon_updated_at ON public.draft_pool_pokemon;
DROP TRIGGER IF EXISTS matches_updated_at ON public.matches;
DROP TRIGGER IF EXISTS trades_updated_at ON public.trades;
DROP TRIGGER IF EXISTS rules_documents_updated_at ON public.rules_documents;

-- Generic BEFORE UPDATE trigger function: sets NEW.updated_at = NOW() when the
-- firing table has an updated_at column, so it is safe to run on legacy tables
-- that lack that column.
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = TG_TABLE_NAME
      AND column_name = 'updated_at'
  ) THEN
    NEW.updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the updated_at trigger on every table that carries the column.
CREATE TRIGGER leagues_updated_at
BEFORE UPDATE ON public.leagues
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER seasons_updated_at
BEFORE UPDATE ON public.seasons
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER league_settings_updated_at
BEFORE UPDATE ON public.league_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER draft_pools_updated_at
BEFORE UPDATE ON public.draft_pools
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER draft_pool_pokemon_updated_at
BEFORE UPDATE ON public.draft_pool_pokemon
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER matches_updated_at
BEFORE UPDATE ON public.matches
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER trades_updated_at
BEFORE UPDATE ON public.trades
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER rules_documents_updated_at
BEFORE UPDATE ON public.rules_documents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
