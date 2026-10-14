-- Adds the letters a member chose to show in their avatar when they have no picture.
--
-- The settings page has always had a "Default avatar initials" field, but the value
-- only ever lived in that page's React state: updateUserProfile had no parameter for
-- it, so saving threw it away and reloading re-derived the letters from the display
-- name. The field looked saved and was not, which is why a member's chosen initials
-- showed on the settings page and nowhere else.
--
-- Nullable, so a member who has not chosen anything reads as "no choice" and gets
-- the shared derivation from their display name. Storing an empty string instead
-- would make "deliberately blank" indistinguishable from "never set", and blank is
-- not something an avatar can usefully show.
--
-- Length is capped in the app layer rather than here. A CHECK on length would stop
-- the column storing an over-long value, but the column would still accept values
-- containing emoji or punctuation, so the constraint would be partial while still
-- needing a migration to widen. normalizeAvatarInitials is the single place that
-- decides what a valid set of initials is.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_initials TEXT;

-- PostgREST caches the relation metadata, so a new column is invisible to the API
-- until the schema cache is reloaded. Matching the convention the other migrations
-- use for this.
NOTIFY pgrst, 'reload schema';