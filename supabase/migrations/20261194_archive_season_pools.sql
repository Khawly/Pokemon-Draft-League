-- Archive a closed season's draft pools when the next season starts
--
-- Draft pools are the single largest per-season cost in the database: a pool
-- holding the national dex is ~1,300-1,500 rows of draft_pool_pokemon, and
-- start_new_season deliberately does not carry pools forward. Once a newer
-- season exists the old pool is history, so this migration replaces those rows
-- with one compressed JSONB snapshot per pool.
--
-- The snapshot is read-only app data: it only has to render the historical pool
-- page. Draft results are already independent of it (draft_picks, team_roster
-- and transactions snapshot the species and tier themselves), so deleting the
-- per-row pool data loses no league history.
--
-- Archiving runs inside start_new_season, in the same transaction as the season
-- switch, so a failure rolls the whole thing back instead of leaving a season
-- half-archived. It can also be called directly by a league owner to archive an
-- older season that predates this migration.

-- One archive row per draft pool. `pokemon` is a compact array of
-- [pokemon_id, species_name, tier_value, is_in_pool, notes] tuples; JSONB is
-- large enough to be TOAST-compressed, which is what makes the snapshot an
-- order of magnitude smaller than the rows it replaces.
CREATE TABLE IF NOT EXISTS public.draft_pool_archives (
  draft_pool_id UUID PRIMARY KEY REFERENCES public.draft_pools(id) ON DELETE CASCADE,
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pokemon_count INTEGER NOT NULL CHECK (pokemon_count >= 0),
  in_pool_count INTEGER NOT NULL CHECK (in_pool_count >= 0),
  pokemon JSONB NOT NULL
);

-- Lets the pool page fetch a season's archives by league/season and lets the
-- draftboard resolve the archived pool for a single season.
CREATE INDEX IF NOT EXISTS draft_pool_archives_league_season_idx
  ON public.draft_pool_archives (league_id, season_id);

ALTER TABLE public.draft_pool_archives ENABLE ROW LEVEL SECURITY;

-- Active league members can read archived pools, matching draft_pools' read
-- policy. There are deliberately no INSERT/UPDATE/DELETE policies: writes are
-- only possible through the SECURITY DEFINER function below.
DROP POLICY IF EXISTS "Members can view archived draft pools" ON public.draft_pool_archives;
CREATE POLICY "Members can view archived draft pools"
ON public.draft_pool_archives
FOR SELECT
TO authenticated
USING (public.is_active_league_member(league_id));

GRANT SELECT ON public.draft_pool_archives TO authenticated;

-- SECURITY DEFINER RPC that snapshots then deletes a finished season's pool
-- rows. Owner-only. Refuses the league's newest season (its pool is still the
-- free-agent source) and any season with a live draft. Idempotent: a pool that
-- already has an archive row is skipped, and any rows left behind are removed.
--
-- @returns pools_archived: pools newly snapshotted this call; rows_removed: the
--          draft_pool_pokemon rows deleted (including leftovers from a retry).
CREATE OR REPLACE FUNCTION public.archive_season_pools(
  p_league_id UUID,
  p_season_id UUID
)
RETURNS TABLE (pools_archived INTEGER, rows_removed BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_latest_season_id UUID;
  v_target_status TEXT;
  v_pools INTEGER := 0;
  v_rows BIGINT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to archive draft pools.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can archive draft pools.';
  END IF;

  SELECT s.id INTO v_latest_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_latest_season_id IS NULL OR v_latest_season_id = p_season_id THEN
    RAISE EXCEPTION 'The current season''s pool cannot be archived.';
  END IF;

  SELECT s.status INTO v_target_status
  FROM public.seasons s
  WHERE s.id = p_season_id AND s.league_id = p_league_id;

  IF v_target_status IS NULL THEN
    RAISE EXCEPTION 'That season does not belong to this league.';
  END IF;

  IF v_target_status = 'draft_active' THEN
    RAISE EXCEPTION 'A season with a live draft cannot be archived.';
  END IF;

  /*
   * Grouping by pool means a pool with no rows produces no archive row (there
   * is nothing to preserve) and never trips the count constraints. The array
   * order is stable so a later restore can reproduce the original ordering.
   */
  INSERT INTO public.draft_pool_archives (
    draft_pool_id,
    league_id,
    season_id,
    pokemon_count,
    in_pool_count,
    pokemon
  )
  SELECT
    dp.id,
    dp.league_id,
    dp.season_id,
    COUNT(dpp.id)::INTEGER,
    COUNT(*) FILTER (WHERE dpp.is_in_pool)::INTEGER,
    jsonb_agg(
      jsonb_build_array(
        dpp.pokemon_id,
        dpp.species_name,
        dpp.tier_value,
        dpp.is_in_pool,
        dpp.notes
      )
      ORDER BY dpp.pokemon_id
    )
  FROM public.draft_pools dp
  JOIN public.draft_pool_pokemon dpp ON dpp.draft_pool_id = dp.id
  WHERE dp.league_id = p_league_id
    AND dp.season_id = p_season_id
  GROUP BY dp.id, dp.league_id, dp.season_id
  ON CONFLICT (draft_pool_id) DO NOTHING;

  GET DIAGNOSTICS v_pools = ROW_COUNT;

  DELETE FROM public.draft_pool_pokemon dpp
  USING public.draft_pools dp
  WHERE dpp.draft_pool_id = dp.id
    AND dp.league_id = p_league_id
    AND dp.season_id = p_season_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  pools_archived := v_pools;
  rows_removed := v_rows;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_season_pools(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_season_pools(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_season_pools(UUID, UUID) TO service_role;

-- Re-creates start_new_season from 20261170_rules_by_season with one addition:
-- the season being closed has its pools archived in the same transaction. The
-- archive call sits after the new season exists, because archive_season_pools
-- refuses to touch the league's newest season.
CREATE OR REPLACE FUNCTION public.start_new_season(p_league_id UUID)
RETURNS TABLE (season_id UUID, season_number INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_old_season_id UUID;
  v_old_status TEXT;
  v_old_number INTEGER;
  v_new_season_id UUID;
  v_new_number INTEGER;
  v_team_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to start a season.';
  END IF;

  IF NOT public.is_league_owner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league owner can start a season.';
  END IF;

  SELECT s.id, s.status, s.season_number
  INTO v_old_season_id, v_old_status, v_old_number
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_old_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  /*
   * Refused mid-draft. A draft in progress is the one thing a new season would destroy
   * without the owner meaning to, because the picks are the work of everyone in the league.
   */
  IF v_old_status = 'draft_active' THEN
    RAISE EXCEPTION 'Finish or reset the current draft before starting a new season.';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_team_count
  FROM public.teams t
  WHERE t.league_id = p_league_id AND t.season_id = v_old_season_id;

  IF v_team_count = 0 THEN
    RAISE EXCEPTION 'This league has no teams to carry into a new season.';
  END IF;

  v_new_number := v_old_number + 1;

  INSERT INTO public.seasons (league_id, season_number, status)
  VALUES (p_league_id, v_new_number, 'draft_pending')
  RETURNING id INTO v_new_season_id;

  /*
   * The settings row is copied by merging the old row into itself with the progress columns
   * replaced. Written this way rather than as an explicit column list so a setting added
   * later is carried forward without this function having to learn about it -- the failure
   * mode of a column list is silent, and a new season quietly missing a rule.
   */
  INSERT INTO public.league_settings
  SELECT (
    jsonb_populate_record(
      NULL::public.league_settings,
      to_jsonb(ls) || jsonb_build_object(
        'id', gen_random_uuid(),
        'season_id', v_new_season_id,
        'playoff_state_json', '{}'::jsonb,
        'current_week', 0,
        'regular_season_completed_at', NULL,
        'week_deadline_anchor_date', NULL,
        'updated_at', NOW()
      )
    )
  ).*
  FROM public.league_settings ls
  WHERE ls.season_id = v_old_season_id;

  -- If the old season somehow had no settings row, the new one still needs one.
  IF NOT EXISTS (
    SELECT 1 FROM public.league_settings ls WHERE ls.season_id = v_new_season_id
  ) THEN
    INSERT INTO public.league_settings (league_id, season_id)
    VALUES (p_league_id, v_new_season_id);
  END IF;

  /*
   * No ON CONFLICT guard: the season was created moments ago, so no rules row can exist
   * for it yet. Naming season_id in a conflict target would also collide with this
   * function's OUT parameter of the same name.
   */
  INSERT INTO public.rules_documents (
    league_id, season_id, created_by, content, file_url
  )
  SELECT
    rd.league_id, v_new_season_id, rd.created_by, rd.content, rd.file_url
  FROM public.rules_documents rd
  WHERE rd.league_id = p_league_id
    AND rd.season_id = v_old_season_id
    AND rd.created_by IS NOT NULL;

  /*
   * One fresh team per owner. Draft position is cleared so the new draft order is drawn
   * again rather than inherited, and the salary override is cleared so every team falls
   * back to the league's own figure.
   */
  INSERT INTO public.teams (
    league_id, season_id, owner_user_id, team_name, draft_position, total_salary_override
  )
  SELECT
    t.league_id, v_new_season_id, t.owner_user_id, t.team_name, NULL, NULL
  FROM public.teams t
  WHERE t.league_id = p_league_id
    AND t.season_id = v_old_season_id;

  /*
   * The closed season's pools are now history. Compacting them here, rather than
   * in a background job, means the rows disappear at the exact moment the pool
   * stops being the free-agent source. A failure rolls back the whole season
   * switch; archive_season_pools is idempotent, so a retry is safe.
   */
  PERFORM public.archive_season_pools(p_league_id, v_old_season_id);

  season_id := v_new_season_id;
  season_number := v_new_number;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.start_new_season(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_new_season(UUID) TO authenticated;

-- Force PostgREST to pick up the new table, policy and RPC signatures immediately.
NOTIFY pgrst, 'reload schema';
