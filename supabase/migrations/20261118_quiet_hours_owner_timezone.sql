-- Makes the league owner's profile time zone authoritative for quiet hours
--
-- 20261117 backfilled league_settings.quiet_hours_timezone from the owner's profile
-- zone and then let the stored column win from then on. That froze the window: the
-- owner changed their zone in user settings and neither the draft settings page nor
-- the draft engine moved, because both were reading the value captured at migration
-- time.
--
-- The intent behind the feature is that a window means "these hours where I am", so
-- the profile zone has to be the live source. It is resolved per call here rather
-- than copied into the row, which is what makes a zone change take effect on the
-- next sweep without anyone re-saving draft settings.
--
-- The column stays as the fallback for a league whose owner has no usable profile
-- zone, so a missing profile cannot leave the window undefined.

-- Re-issues draft_quiet_hours with the zone resolved from the league owner's
-- profile first.
--
-- Everything else is carried over from 20261117 verbatim: the enabled/clocks
-- guards, the malformed-clock guard, the equal-bounds guard, the single-day branch,
-- and the wrap-past-midnight branch with its previous-day anchoring.
--
-- @param p_season_id - The season whose league settings carry the window.
-- @returns in_quiet, plus window_start/window_end as instants, all NULL when out.
CREATE OR REPLACE FUNCTION public.draft_quiet_hours(
  p_season_id UUID
)
RETURNS TABLE (in_quiet BOOLEAN, window_start TIMESTAMPTZ, window_end TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_start_clock TEXT;
  v_end_clock TEXT;
  v_tz TEXT;
  v_start TIME;
  v_end TIME;
  v_today DATE;
  v_local_now TIME;
BEGIN
  /*
   * leagues.id and profiles.id are both primary keys, so the two joins cannot
   * multiply the settings row.
   */
  SELECT
    COALESCE(ls.quiet_hours_enabled, FALSE),
    NULLIF(BTRIM(ls.quiet_hours_start_est), ''),
    NULLIF(BTRIM(ls.quiet_hours_end_est), ''),
    COALESCE(
      NULLIF(BTRIM(pr.timezone), ''),
      NULLIF(BTRIM(ls.quiet_hours_timezone), ''),
      'UTC'
    )
  INTO v_enabled, v_start_clock, v_end_clock, v_tz
  FROM public.league_settings ls
  JOIN public.leagues l ON l.id = ls.league_id
  LEFT JOIN public.profiles pr ON pr.id = l.owner_id
  WHERE ls.season_id = p_season_id;

  IF NOT v_enabled OR v_start_clock IS NULL OR v_end_clock IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- A malformed clock must not take the draft engine down with it, and must not
  -- silently read as "always quiet" either.
  BEGIN
    v_start := v_start_clock::TIME;
    v_end := v_end_clock::TIME;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END;

  -- Equal bounds would describe a window that is either always open or never
  -- open. Never is the safe reading: a typo that paused the league's draft
  -- indefinitely would be far worse than one that did nothing.
  IF v_start = v_end THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_today := (NOW() AT TIME ZONE v_tz)::DATE;
  v_local_now := (NOW() AT TIME ZONE v_tz)::TIME;

  IF v_start < v_end THEN
    IF v_local_now >= v_start AND v_local_now < v_end THEN
      RETURN QUERY SELECT TRUE,
        ((v_today)::TIMESTAMP + v_start) AT TIME ZONE v_tz,
        ((v_today)::TIMESTAMP + v_end) AT TIME ZONE v_tz;
    ELSE
      RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    END IF;
    RETURN;
  END IF;

  -- Wraps past midnight, so the window opened on the previous local day.
  IF v_local_now >= v_start THEN
    RETURN QUERY SELECT TRUE,
      ((v_today)::TIMESTAMP + v_start) AT TIME ZONE v_tz,
      (((v_today + 1))::TIMESTAMP + v_end) AT TIME ZONE v_tz;
  ELSIF v_local_now < v_end THEN
    RETURN QUERY SELECT TRUE,
      (((v_today - 1))::TIMESTAMP + v_start) AT TIME ZONE v_tz,
      ((v_today)::TIMESTAMP + v_end) AT TIME ZONE v_tz;
  ELSE
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.draft_quiet_hours(UUID) FROM PUBLIC;

-- Force PostgREST to pick up the new function body immediately.
NOTIFY pgrst, 'reload schema';