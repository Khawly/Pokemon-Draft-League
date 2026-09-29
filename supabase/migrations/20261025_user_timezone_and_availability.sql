-- Adds a per-user display time zone and a weekly match availability schedule.
--
-- profiles.timezone is a display preference only: it never changes what is
-- stored, and every timestamp in the database stays UTC. League pages render
-- those timestamps in the signed-in user's chosen zone so two members in
-- different regions read the same match in their own local time.
--
-- user_availability stores one row per weekday per user. Each window is a
-- wall-clock range expressed in the owner's own time zone, so showing it to
-- another member is a matter of projecting it into the viewer's zone. No
-- ordering constraint is placed on start/end: a range whose end is not after its
-- start is read as wrapping past midnight (for example 22:00 to 02:00).

-- The IANA zone the user wants league dates and times rendered in. 'UTC' is the
-- neutral default for rows created before the column existed and for accounts
-- that have never opened their settings page.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- One availability window per user per weekday. day_of_week follows
-- Date#getDay (0 = Sunday), matching what the client derives from a zoned date.
-- The composite primary key makes the settings page's seven-row upsert
-- idempotent, and the row disappears with the profile.
CREATE TABLE IF NOT EXISTS public.user_availability (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL,
  is_unavailable BOOLEAN NOT NULL DEFAULT FALSE,
  start_time TEXT NOT NULL DEFAULT '18:00',
  end_time TEXT NOT NULL DEFAULT '23:00',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_availability_pkey PRIMARY KEY (user_id, day_of_week),
  CONSTRAINT user_availability_day_of_week_range CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT user_availability_start_time_format CHECK (
    start_time ~ '^(2[0-3]|[01][0-9]):[0-5][0-9]$'
  ),
  CONSTRAINT user_availability_end_time_format CHECK (
    end_time ~ '^(2[0-3]|[01][0-9]):[0-5][0-9]$'
  )
);

-- Speeds up the "which leagues does this user belong to" lookup that the
-- peer-visibility policy below performs. The existing uniqueness constraint on
-- league_members leads with league_id, so it cannot serve a user_id probe.
CREATE INDEX IF NOT EXISTS league_members_user_id_idx
ON public.league_members (user_id);

ALTER TABLE public.user_availability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own availability" ON public.user_availability;
DROP POLICY IF EXISTS "League peers can view availability" ON public.user_availability;

-- A user always sees, creates, edits, and deletes their own week. This single
-- policy covers every command, so no separate self-read policy is needed.
CREATE POLICY "Users can manage their own availability"
ON public.user_availability
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Peers share a league with the viewer may read a member's week so the schedule
-- page can show an opponent's free time; nothing else is exposed. The membership
-- check runs through the SECURITY DEFINER helper, which keeps this policy from
-- re-entering league_members' own policies.
CREATE POLICY "League peers can view availability"
ON public.user_availability
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.league_members member
    WHERE member.user_id = user_availability.user_id
      AND member.is_active = TRUE
      AND public.is_active_league_member(member.league_id)
  )
);

-- Keep updated_at meaningful for auditing when a member edits their week.
DROP TRIGGER IF EXISTS user_availability_updated_at ON public.user_availability;
CREATE TRIGGER user_availability_updated_at
BEFORE UPDATE ON public.user_availability
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
