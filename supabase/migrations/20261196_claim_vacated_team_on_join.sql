-- Reuses a departed member's team when a replacement joins after the draft.
--
-- Teams are minted when a member joins a still-pending season (20261193), but a
-- member can leave after the draft has started. Their team row has to stay: the
-- draft pick ledger, rosters, schedule and match results all reference its id,
-- and the team carries the draft position the season was built around. Joining
-- after the draft deliberately created no new team for the same reason, which
-- left the league with an ownerless team and the replacement with none.
--
-- This re-issues join_league_by_invite so a post-draft joiner claims a team
-- whose owner is no longer an active member. A vacancy is a team whose owner has
-- no active league_members row, so leaving a league is all that has to happen
-- to free the slot; no separate flag has to be written by leave_league.
--
-- A rejoining member already owns their old team and is left alone. Joining
-- before the draft still creates a fresh empty team. If the league has no
-- vacated team after the draft, no team is invented: the season's schedule does
-- not know about it.

-- One-time repair for leagues already in this state: pair each active member
-- who has no team in the newest, already-drafted season with the vacated team
-- at the same ordinal position. Both lists are ordered deterministically, so
-- running this against a healthy league (where the counts are equal) changes
-- nothing. It only fills members who have no team and teams no member owns.
WITH newest_seasons AS (
  SELECT s.id, s.league_id
  FROM public.seasons s
  WHERE s.status IN ('draft_active', 'draft_complete')
    AND s.season_number = (
      SELECT MAX(s2.season_number)
      FROM public.seasons s2
      WHERE s2.league_id = s.league_id
    )
),
vacant_teams AS (
  SELECT
    t.id,
    t.league_id,
    t.season_id,
    ROW_NUMBER() OVER (
      PARTITION BY t.league_id, t.season_id
      ORDER BY t.draft_position ASC NULLS LAST, t.created_at ASC
    ) AS slot
  FROM public.teams t
  JOIN newest_seasons s ON s.id = t.season_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.league_members lm
    WHERE lm.league_id = t.league_id
      AND lm.user_id = t.owner_user_id
      AND lm.is_active = TRUE
  )
),
unassigned_members AS (
  SELECT
    lm.league_id,
    s.id AS season_id,
    lm.user_id,
    ROW_NUMBER() OVER (
      PARTITION BY lm.league_id, s.id
      ORDER BY lm.joined_at ASC, lm.user_id ASC
    ) AS slot
  FROM public.league_members lm
  JOIN newest_seasons s ON s.league_id = lm.league_id
  WHERE lm.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM public.teams t
      WHERE t.league_id = lm.league_id
        AND t.season_id = s.id
        AND t.owner_user_id = lm.user_id
    )
),
handovers AS (
  SELECT v.id AS team_id, u.user_id
  FROM vacant_teams v
  JOIN unassigned_members u
    ON u.league_id = v.league_id
   AND u.season_id = v.season_id
   AND u.slot = v.slot
)
UPDATE public.teams t
SET owner_user_id = h.user_id,
    team_name = COALESCE(
      (SELECT p.display_name FROM public.profiles p WHERE p.id = h.user_id),
      t.team_name
    )
FROM handovers h
WHERE t.id = h.team_id;

-- Re-issued invite join with the same membership rules, plus the post-draft
-- team handover. SECURITY DEFINER because the joining user cannot update a team
-- row they do not yet own; the function checks the invite, capacity and
-- membership itself before any write.
CREATE OR REPLACE FUNCTION public.join_league_by_invite(
  p_token TEXT
)
RETURNS TABLE (league_id UUID, league_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_league_id UUID;
  v_league_name TEXT;
  v_member_count INTEGER;
  v_max_players INTEGER;
  v_season_id UUID;
  v_season_status TEXT;
  v_vacated_team_id UUID;
  v_display_name TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to join a league.';
  END IF;

  SELECT li.league_id, l.name, l.number_of_players
    INTO v_league_id, v_league_name, v_max_players
  FROM public.league_invites li
  JOIN public.leagues l ON l.id = li.league_id
  WHERE li.token = p_token
  LIMIT 1;

  IF v_league_id IS NULL THEN
    RAISE EXCEPTION 'This invite link is invalid or has been revoked.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.league_invites li
    WHERE li.token = p_token AND li.expires_at IS NOT NULL AND li.expires_at < NOW()
  ) THEN
    RAISE EXCEPTION 'This invite link has expired.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = v_league_id AND lm.user_id = v_user_id AND lm.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'You are already a member of this league.';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_member_count
  FROM public.league_members lm
  WHERE lm.league_id = v_league_id AND lm.is_active = TRUE;

  IF v_member_count >= v_max_players THEN
    RAISE EXCEPTION 'This league already has the maximum number of players.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, is_active)
  VALUES (v_league_id, v_user_id, 'member', TRUE)
  ON CONFLICT (league_id, user_id)
  DO UPDATE SET is_active = TRUE, joined_at = NOW();

  SELECT s.id, s.status
    INTO v_season_id, v_season_status
  FROM public.seasons s
  WHERE s.league_id = v_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  /*
   * A rejoining member still owns the team they had before leaving, so there is
   * nothing to hand over. This also keeps the pre-draft insert below from
   * minting a duplicate team for a member who is returning.
   */
  IF v_season_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.teams t
       WHERE t.league_id = v_league_id
         AND t.season_id = v_season_id
         AND t.owner_user_id = v_user_id
     )
  THEN
    IF v_season_status = 'draft_pending' THEN
      INSERT INTO public.teams (
        league_id, season_id, owner_user_id, team_name, draft_position
      )
      SELECT
        v_league_id,
        s.id,
        v_user_id,
        COALESCE(p.display_name, 'Player ' || substr(v_user_id::text, 1, 8)),
        lm.draft_position
      FROM public.seasons s
      JOIN public.league_members lm
        ON lm.league_id = s.league_id
       AND lm.user_id = v_user_id
      LEFT JOIN public.profiles p ON p.id = v_user_id
      WHERE s.league_id = v_league_id
        AND s.id = v_season_id
        AND NOT EXISTS (
          SELECT 1 FROM public.teams t
          WHERE t.league_id = v_league_id
            AND t.season_id = s.id
            AND t.owner_user_id = v_user_id
        );
    ELSIF v_season_status IN ('draft_active', 'draft_complete') THEN
      /*
       * Post-draft intake. Archived seasons are deliberately excluded: they are
       * historical records, so a new member is never written into one.
       *
       * The lowest draft position wins when more than one member has left, so
       * the assignment is deterministic. The row is locked with SKIP LOCKED so
       * two simultaneous joiners cannot claim the same vacated team and leave
       * one of them empty-handed by overwriting the other's handover.
       */
      SELECT t.id
        INTO v_vacated_team_id
      FROM public.teams t
      WHERE t.league_id = v_league_id
        AND t.season_id = v_season_id
        AND NOT EXISTS (
          SELECT 1 FROM public.league_members lm
          WHERE lm.league_id = v_league_id
            AND lm.user_id = t.owner_user_id
            AND lm.is_active = TRUE
        )
      ORDER BY t.draft_position ASC NULLS LAST, t.created_at ASC
      LIMIT 1
      FOR UPDATE OF t SKIP LOCKED;

      IF v_vacated_team_id IS NOT NULL THEN
        SELECT COALESCE(
          p.display_name,
          'Player ' || substr(v_user_id::text, 1, 8)
        )
          INTO v_display_name
        FROM public.profiles p
        WHERE p.id = v_user_id;

        v_display_name := COALESCE(
          v_display_name,
          'Player ' || substr(v_user_id::text, 1, 8)
        );

        UPDATE public.teams
        SET owner_user_id = v_user_id,
            team_name = v_display_name
        WHERE id = v_vacated_team_id;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_league_id, v_league_name;
END;
$$;

REVOKE ALL ON FUNCTION public.join_league_by_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_league_by_invite(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
