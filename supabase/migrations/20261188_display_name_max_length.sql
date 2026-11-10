-- Enforce a 32-character maximum on member display names
--
-- The profile page, sign-up form, and auth helpers already cap the field in the
-- client. This migration makes the limit a database rule as well, so a stale or
-- custom client cannot write a name longer than every page's layout expects.
--
-- Names already longer than the limit are truncated rather than rejected: the
-- alternative is a migration that fails to apply because of existing data.

-- Bring existing rows inside the new limit first.
UPDATE public.profiles
SET display_name = LEFT(display_name, 32)
WHERE display_name IS NOT NULL
  AND char_length(display_name) > 32;

-- The one place the limit is enforced for every writer.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_display_name_length;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_display_name_length
  CHECK (display_name IS NULL OR char_length(display_name) <= 32);

-- The sign-up trigger reads the name straight from auth metadata, so cap it
-- there too. Without this, a sign-up with a longer metadata value would fail
-- the new constraint while the auth user is being provisioned.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    LEFT(
      COALESCE(
        NEW.raw_user_meta_data->>'display_name',
        split_part(NEW.email, '@', 1)
      ),
      32
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';
