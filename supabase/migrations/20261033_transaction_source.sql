-- Classifies each roster move in the `transactions` ledger by what caused it.
--
-- The Pokemon page's transaction panel has to show league-wide activity while
-- leaving the draft itself out. A draft pick and a free agent pickup are
-- otherwise indistinguishable: both are an `added` row with the same cost
-- semantics, and the only thing separating them was the free-text note
-- ('Draft pick' against 'Picked up from the free agents'). Filtering a ledger on
-- prose means a reworded string silently starts showing every draft pick in the
-- panel, so the distinction is promoted to a real column.
--
-- The vocabulary names the ledger event rather than how the Pokemon was
-- acquired, which is deliberately not a copy of `team_roster.source` ('draft',
-- 'pickup', 'trade'). A release needs its own value: the roster row it came from
-- is already deleted by the time the ledger row is written, so the acquisition
-- path is unrecoverable and claiming one would be a guess. Naming the event
-- keeps every row honestly classifiable.
--
--   draft_pick         - added by the draft engine, for any team
--   free_agent_pickup  - added from the free agent pool
--   trade              - moved by a completed trade, in either direction
--   release            - dropped from a roster
--
-- Trades are listed because the schema has always allowed `trade_in` and
-- `trade_out` and the panel is specified to show them, even though no trade has
-- completed yet: the classification is ready for the first one.

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS source TEXT;

-- One-time classification of the rows that already exist. The note is the only
-- evidence available retroactively, which is precisely why the column exists.
UPDATE public.transactions
SET source = CASE
  WHEN action = 'dropped' THEN 'release'
  WHEN action IN ('trade_in', 'trade_out') THEN 'trade'
  WHEN note = 'Draft pick' THEN 'draft_pick'
  ELSE 'free_agent_pickup'
END
WHERE source IS NULL;

ALTER TABLE public.transactions ALTER COLUMN source SET NOT NULL;

-- Postgres applies a NOT NULL check after BEFORE triggers, so the trigger below
-- can still populate the column for inserts that do not name it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_source_check'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_source_check
      CHECK (source IN ('draft_pick', 'free_agent_pickup', 'trade', 'release'));
  END IF;
END;
$$;

-- Classifies future rows in one place, so the three functions that write the
-- ledger (insert_draft_pick, pickup_roster_pokemon, drop_roster_pokemon) need no
-- change and a future trade writer cannot forget the column.
CREATE OR REPLACE FUNCTION public.classify_transaction_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_roster_source TEXT;
BEGIN
  -- A caller that states its own source is taken at its word; this is only the
  -- fallback for the writers that predate the column.
  IF NEW.source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.action = 'dropped' THEN
    NEW.source := 'release';
    RETURN NEW;
  END IF;

  IF NEW.action IN ('trade_in', 'trade_out') THEN
    NEW.source := 'trade';
    RETURN NEW;
  END IF;

  -- The roster row is inserted in the same transaction immediately before the
  -- ledger row, and records how the Pokemon was acquired, so it is the authority
  -- on whether an `added` came from the draft or the free agent pool. This keys
  -- off a real column rather than a note that can be reworded.
  SELECT r.source INTO v_roster_source
  FROM public.team_roster r
  WHERE r.team_id = NEW.team_id
    AND r.pokemon_id = NEW.pokemon_id;

  NEW.source := CASE v_roster_source
    WHEN 'draft' THEN 'draft_pick'
    WHEN 'trade' THEN 'trade'
    ELSE 'free_agent_pickup'
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.classify_transaction_source() FROM PUBLIC;

DROP TRIGGER IF EXISTS transactions_classify_source ON public.transactions;

CREATE TRIGGER transactions_classify_source
BEFORE INSERT ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.classify_transaction_source();

-- The Pokemon page reads this ledger league-wide, newest first, and the existing
-- primary key on (id) cannot serve either the filter or the ordering.
CREATE INDEX IF NOT EXISTS transactions_league_season_created_idx
  ON public.transactions (league_id, season_id, created_at DESC);

-- Force PostgREST to pick up the new column up.
NOTIFY pgrst, 'reload schema';
