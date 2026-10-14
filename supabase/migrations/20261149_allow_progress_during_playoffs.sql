-- Lets the owner progress the bracket from the Progress week button.
--
-- The button was gated on can_progress, which the week progress state defined as:
--
--   regular_season_completed_at IS NULL AND total_weeks >= week
--
-- The first term goes false the moment the regular season is frozen, which is
-- exactly when the playoffs open, so the button disabled itself for the whole
-- postseason. The backend was never the obstacle: progress_league_week delegates to
-- advance_league_week_deadline, which already recognises playoff rounds and advances
-- the bracket. The owner simply had no way to reach it except waiting for the weekly
-- deadline sweep.
--
-- can_progress now also holds while any playoff game is unplayed. It retires on its
-- own once every playoff game is reported, so the button does not hang around after
-- the tournament is decided.
--
-- playoffs_active is reported alongside it so the UI can say "Advance bracket" rather
-- than "Progress week" when that is what pressing the button will do.

CREATE OR REPLACE FUNCTION public.week_progress_state(p_league_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_settings public.league_settings%ROWTYPE;
  v_latest public.week_progress_log%ROWTYPE;
  v_season_id UUID;
  v_week INTEGER;
  v_total_weeks INTEGER;
  v_unreported INTEGER := 0;
  v_playoff_matches INTEGER := 0;
  v_offset INTEGER;
  v_deadline TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to view week progress.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT ls.* INTO v_settings
  FROM public.league_settings ls
  JOIN public.seasons s ON s.id = ls.season_id
  WHERE ls.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_settings');
  END IF;

  v_season_id := v_settings.season_id;
  v_total_weeks := COALESCE(v_settings.regular_season_weeks, 0);
  v_week := GREATEST(COALESCE(v_settings.current_week, 0), 1);

  IF v_settings.week_deadline_anchor_date IS NOT NULL THEN
    v_offset := GREATEST(0, (((NOW() AT TIME ZONE v_settings.week_deadline_timezone)::DATE - v_settings.week_deadline_anchor_date) / 7));
    v_deadline := public.week_deadline_instant(
      v_settings.week_deadline_anchor_date,
      v_settings.week_deadline_time,
      v_settings.week_deadline_timezone,
      v_offset
    );
  END IF;

  SELECT COUNT(*) INTO v_unreported
  FROM public.matches m
  WHERE m.season_id = v_season_id
    AND m.week_number = v_week
    AND NOT m.is_playoff
    AND m.status NOT IN ('completed','forfeit','cancelled');

  SELECT COUNT(*) INTO v_playoff_matches
  FROM public.matches m
  WHERE m.season_id = v_season_id AND m.is_playoff;

  SELECT * INTO v_latest
  FROM public.week_progress_log
  WHERE league_id = p_league_id
    AND season_id = v_season_id
    AND undone_at IS NULL
  ORDER BY id DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'ok',
    'current_week', v_week,
    'total_weeks', v_total_weeks,
    'unreported_matches', v_unreported,
    'regular_season_completed', v_settings.regular_season_completed_at IS NOT NULL,
    'playoffs_started', v_playoff_matches > 0,
    'deadline_enabled', v_settings.week_deadline_enabled,
    'deadline_paused', v_settings.week_deadline_paused,
    'next_deadline', v_deadline,
    -- Nothing to progress once the regular season is frozen or the schedule has
    -- no weeks left.
          -- Progress stays available during the playoffs. Once the regular season is
      -- frozen the old condition went false and the owner had no way to move the
      -- bracket on except waiting for the deadline sweep, even though
      -- advance_league_week_deadline already handled bracket rounds.
      --
      -- The second term is true while any playoff game is still unplayed, and false
      -- once every one is reported, so the button retires by itself at the end.
      'can_progress',
        (v_settings.regular_season_completed_at IS NULL AND v_total_weeks >= v_week)
        OR EXISTS (
          SELECT 1 FROM public.matches m
          WHERE m.season_id = v_season_id
            AND m.is_playoff
            AND (m.status <> 'completed' OR m.winner_team_id IS NULL)
        ),
      -- Lets the UI relabel the button: the action is identical but what it moves
      -- changes from a regular week to the bracket.
      'playoffs_active',
        EXISTS (
          SELECT 1 FROM public.matches m
          WHERE m.season_id = v_season_id AND m.is_playoff
        ),
    'can_undo', v_latest.id IS NOT NULL,
    'latest_progress', CASE
      WHEN v_latest.id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'id', v_latest.id,
        'source', v_latest.source,
        'from_week', v_latest.from_week,
        'to_week', v_latest.to_week,
        'settled_count', v_latest.settled_count,
        'advanced_at', v_latest.advanced_at,
        'playoff_matches', COALESCE(array_length(v_latest.created_playoff_matches, 1), 0)
      )
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.week_progress_state(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.week_progress_state(UUID) TO authenticated;
