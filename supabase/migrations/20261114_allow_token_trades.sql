-- Allows tokens to be traded, behind an owner setting that is off by default.
--
-- There was no way to move tokens at all. `transactions` is the single authority
-- every salary figure in the app sums (see team_salary_totals, and the client
-- mirrors in trades.ts/teams.ts), and it could not express one: `pokemon_id` was
-- NOT NULL and `action` was constrained to the four roster moves, so a trade had
-- no place to record "these tokens changed hands". complete_trade derived every
-- token movement from team_roster.tier_value and wrote paired mirrored rows whose
-- cost deltas summed to zero league-wide, which is correct for Pokemon and wrong
-- for cash.
--
-- This migration only opens the door; propose_trade and complete_trade are
-- re-issued in the migrations that follow.

-- Owner setting gating token trades. Per-season, alongside enable_pokemon_costs,
-- which it only means anything when is on.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS allow_token_trades BOOLEAN NOT NULL DEFAULT FALSE;

-- The token amounts each side is putting into a trade, mirroring the way
-- trade_items holds the Pokemon each side is offering. A side sends the amount it
-- gives away, so proposer_token_amount is tokens moving from the proposer to the
-- recipient. Two integers rather than a token item table because there is exactly
-- one amount per side: a side either attaches a number or it does not, so a row
-- per token entry would have nothing to enumerate.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS proposer_token_amount INTEGER NOT NULL DEFAULT 0
    CHECK (proposer_token_amount >= 0),
  ADD COLUMN IF NOT EXISTS recipient_token_amount INTEGER NOT NULL DEFAULT 0
    CHECK (recipient_token_amount >= 0);

-- Lets the ledger record a token movement that carries no Pokemon. A token row
-- has no species to name, so pokemon_id has to be nullable for it to exist at all.
ALTER TABLE public.transactions
  ALTER COLUMN pokemon_id DROP NOT NULL;

-- Widens the action vocabulary with the one event that moves value without a
-- roster change. The existing rows are all unaffected; the constraint is dropped
-- and re-added rather than altered because CHECK constraints cannot be widened in
-- place. The name is the one Postgres generated from the inline constraint in
-- 20250911, so this replaces that check rather than adding a second one.
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_action_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_action_check
  CHECK (action IN ('added', 'dropped', 'trade_in', 'trade_out', 'token_transfer'));

-- The transactions select policy filters on league_id only, so a null pokemon_id
-- does not need a policy change.

-- Force PostgREST to pick up the new columns immediately.
NOTIFY pgrst, 'reload schema';