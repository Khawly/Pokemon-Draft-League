-- Carries a team's season history across a post-draft ownership handover.
--
-- season_standings_for credits a correct prediction to the team whose current
-- owner made it (`match_predictions.user_id = teams.owner_user_id`). When a
-- replacement claims a vacated team, the wins, losses and KO differential
-- already follow the team id, but the PP total did not: the previous owner's
-- picks still carried their user id, so the new owner started on zero.
--
-- The handover now moves the previous owner's predictions for that season to the
-- new owner as part of the same transaction. A pick the new owner has already
-- made for a match is kept as their own; the departing member's pick for that
-- match is not copied over it.
--
-- Token budget follows the team row and its transaction ledger, so the current
-- season's balance already carries over. league_members.total_token_salary is
-- the template the next season copies from, though, so it is copied to the
-- joining member as well; otherwise starting the next draft would sync the new
-- member's blank template back onto the inherited team and wipe its override.
--
-- Re-issues join_league_by_invite with the same membership, capacity and
-- vacated-team rules as 20261196.

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
  v_previous_owner_id UUID;
  v_inherited_salary INTEGER;
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
      SELECT t.id, t.owner_user_id
        INTO v_vacated_team_id, v_previous_owner_id
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
        /*
         * The team row keeps its total_salary_override and its transaction
         * ledger, so the current season's budget and remaining tokens already
         * follow the team. league_members.total_token_salary is the template
         * the next season copies from, so it has to move too: start_draft syncs
         * that column back onto the team, and a blank template would otherwise
         * wipe the inherited override next season.
         */
        SELECT lm.total_token_salary
          INTO v_inherited_salary
        FROM public.league_members lm
        WHERE lm.league_id = v_league_id
          AND lm.user_id = v_previous_owner_id;

        IF v_inherited_salary IS NULL THEN
          SELECT t.total_salary_override
            INTO v_inherited_salary
          FROM public.teams t
          WHERE t.id = v_vacated_team_id;
        END IF;

        UPDATE public.league_members lm
        SET total_token_salary = v_inherited_salary
        WHERE lm.league_id = v_league_id
          AND lm.user_id = v_user_id;

        /*
         * PP is read from the current owner's picks, so move the departing
         * member's season picks with the team. The NOT EXISTS keeps a pick the
         * new owner already has for the same match; their own choice wins and
         * the old row is simply not handed over.
         */
        UPDATE public.match_predictions mp
        SET user_id = v_user_id,
            updated_at = NOW()
        WHERE mp.league_id = v_league_id
          AND mp.season_id = v_season_id
          AND mp.user_id = v_previous_owner_id
          AND NOT EXISTS (
            SELECT 1 FROM public.match_predictions mine
            WHERE mine.match_id = mp.match_id
              AND mine.user_id = v_user_id
          );

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
