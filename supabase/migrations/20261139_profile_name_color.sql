-- Adds the colour a member has chosen for their display name.
--
-- Nullable rather than NOT NULL DEFAULT 'default': "default" means "inherit the
-- colour of whatever the name is rendered in", which is exactly what a member with
-- no choice recorded should get. A NOT NULL DEFAULT would also have to be backfilled
-- here for no benefit, since NULL already reads as default everywhere it is consumed.
--
-- Deliberately no CHECK constraint on the value. The set of colours lives in
-- src/lib/name-colors.ts and is validated by normalizeNameColor on read and write,
-- so adding a colour to the palette later is an application change rather than a
-- migration against every existing profile row. The same tradeoff was made for
-- profiles.timezone, which is likewise validated in the app layer.
--
-- Stored on profiles rather than league_members because a member's name colour is
-- theirs, not a per-league setting: it should follow them into every league they
-- join, the same way display_name does.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS name_color TEXT;

-- PostgREST caches the relation metadata, so a new column is invisible to the API
-- until the schema cache is reloaded. Matching the convention the other migrations
-- use for this.
NOTIFY pgrst, 'reload schema';