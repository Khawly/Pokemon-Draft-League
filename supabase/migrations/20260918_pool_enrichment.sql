-- Draft pool enrichment columns
--
-- Adds columns to draft_pool_pokemon so the draft pool page can display Type,
-- BST, and Generation alongside the existing tier/status columns and round-trip
-- optional trainer notes. Values are captured from the PokeAPI at add/import
-- time and are display metadata, not reference-stable foreign keys.

-- Enrichment + notes columns for pool Pokémon. type_primary/secondary hold the
-- normalized type names, bst the sum of the six base stats, generation a label
-- like "Gen 1", and notes free-form trainer notes that survive CSV export/import.
ALTER TABLE public.draft_pool_pokemon
  ADD COLUMN IF NOT EXISTS type_primary TEXT,
  ADD COLUMN IF NOT EXISTS type_secondary TEXT,
  ADD COLUMN IF NOT EXISTS bst INTEGER,
  ADD COLUMN IF NOT EXISTS generation TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;