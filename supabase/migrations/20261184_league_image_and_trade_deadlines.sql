-- League images and season trade / free agency deadlines
--
-- Adds a per-league image shown beside the league name, and two optional
-- per-season deadlines that close trading and free agent pickups. The deadlines
-- are stored as instants (TIMESTAMPTZ) so they do not drift with daylight saving
-- after the owner saves them; NULL means the deadline is off.
--
-- Enforcement lives in database triggers rather than in each UI action: every
-- trade and every free agent pickup already runs through a small set of paths,
-- and a stale page must not be able to place a transaction after the owner has
-- closed the window. League owners keep their existing override for free agent
-- adds, which is why the pickup trigger checks ownership directly rather than
-- applying to every roster insert.

-- Image shown to the left of the league name on the dashboard. Null means no
-- image was uploaded, and the dashboard renders no placeholder.
ALTER TABLE public.leagues
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- When trading closes for the season. Null means trading stays open.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS trade_deadline_at TIMESTAMPTZ;

-- When free agent pickups close for the season. Null means pickups stay open.
ALTER TABLE public.league_settings
  ADD COLUMN IF NOT EXISTS free_agency_deadline_at TIMESTAMPTZ;

-- Public bucket for league images. Objects are stored as <league_id>/image.webp
-- so the policies below can resolve the owning league from the first path segment.
INSERT INTO storage.buckets (id, name, public)
VALUES ('league-images', 'league-images', TRUE)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Public read: the dashboard renders the image without an authenticated storage
-- call, and league images are league branding rather than private data.
DROP POLICY IF EXISTS "League images are publicly readable" ON storage.objects;
CREATE POLICY "League images are publicly readable"
ON storage.objects
FOR SELECT
USING (bucket_id = 'league-images');

-- Only the league owner may write or delete the league's own image. The path's
-- first segment is the league id, so a member cannot overwrite another league's
-- branding by naming its id.
DROP POLICY IF EXISTS "League owners can upload league images" ON storage.objects;
CREATE POLICY "League owners can upload league images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(name))[1]
      AND l.owner_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "League owners can update league images" ON storage.objects;
CREATE POLICY "League owners can update league images"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(name))[1]
      AND l.owner_id = auth.uid()
  )
)
WITH CHECK (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(name))[1]
      AND l.owner_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "League owners can delete league images" ON storage.objects;
CREATE POLICY "League owners can delete league images"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(name))[1]
      AND l.owner_id = auth.uid()
  )
);

-- Blocks trade creation and forward progress once the season's trade deadline
-- has passed. Declining, withdrawing, cancelling, and rejecting remain allowed:
-- those settle a card without moving Pokémon between teams.
CREATE OR REPLACE FUNCTION public.enforce_trade_deadline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deadline TIMESTAMPTZ;
BEGIN
  SELECT ls.trade_deadline_at INTO v_deadline
  FROM public.league_settings ls
  WHERE ls.season_id = NEW.season_id;

  IF v_deadline IS NULL OR NOW() < v_deadline THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'The trade deadline has passed.';
  END IF;

  /*
   * Only transitions that move the trade toward completion are blocked. A
   * cancellation or rejection is still meaningful after the deadline, and
   * leaving it possible lets members clear a stale card.
   */
  IF NEW.status IN ('pending_approval', 'approved', 'completed')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'The trade deadline has passed.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trades_enforce_deadline ON public.trades;
CREATE TRIGGER trades_enforce_deadline
BEFORE INSERT OR UPDATE OF status ON public.trades
FOR EACH ROW
EXECUTE FUNCTION public.enforce_trade_deadline();

-- Blocks free agent pickups after the free agency deadline for everyone except
-- the league owner. Draft picks and trade movements insert roster rows too, but
-- carry different sources, so they are deliberately outside this trigger.
CREATE OR REPLACE FUNCTION public.enforce_free_agency_deadline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league_id UUID;
  v_season_id UUID;
  v_deadline TIMESTAMPTZ;
BEGIN
  IF NEW.source IS DISTINCT FROM 'pickup' THEN
    RETURN NEW;
  END IF;

  SELECT t.league_id, t.season_id
  INTO v_league_id, v_season_id
  FROM public.teams t
  WHERE t.id = NEW.team_id;

  SELECT ls.free_agency_deadline_at INTO v_deadline
  FROM public.league_settings ls
  WHERE ls.season_id = v_season_id;

  IF v_deadline IS NOT NULL
     AND NOW() >= v_deadline
     AND NOT public.is_league_owner(v_league_id) THEN
    RAISE EXCEPTION 'The free agency deadline has passed.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_roster_enforce_free_agency_deadline
  ON public.team_roster;
CREATE TRIGGER team_roster_enforce_free_agency_deadline
BEFORE INSERT ON public.team_roster
FOR EACH ROW
EXECUTE FUNCTION public.enforce_free_agency_deadline();

REVOKE ALL ON FUNCTION public.enforce_trade_deadline() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_free_agency_deadline() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
