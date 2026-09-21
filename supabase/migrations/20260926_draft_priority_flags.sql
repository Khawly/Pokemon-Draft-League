-- Draft priority flags: per-round auto-pick and skip-pick toggles.
--
-- Adds two boolean columns to `draft_priority_lists` (auto_pick / skip_pick,
-- both DEFAULT FALSE) and a `set_priority_round_flags` SECURITY DEFINER RPC that
-- flips them for a single (user, round) band of priority rows. The arena
-- renders one mutually-exclusive Auto/Skip checkbox pair per round; the UI
-- enforces exclusivity and persists the result through this RPC. Because the
-- columns live on the priority rows themselves, the existing
-- `save_priority_list` upsert path stays untouched.

ALTER TABLE public.draft_priority_lists
  ADD COLUMN IF NOT EXISTS auto_pick BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS skip_pick BOOLEAN NOT NULL DEFAULT FALSE;

-- Sets the auto / skip flags for one round of the current user's priority
-- list. `p_auto_pick` and `p_skip_pick` may both be FALSE (clear the round),
-- but callers should never pass both FALSE tue and TRUE; the app enforces
-- mutual exclusion before calling.
--
-- Security: SECURITY DEFINER, and the only writes allowed to the list are the
-- row owner's own round band. `p_pokemon_*` checks verify the user is an
-- active league member so a member cannot flip another league's rows.
CREATE OR REPLACE FUNCTION public.set_priority_round_flags(
  p_league_id UUID,
  p_round_number INTEGER,
  p_auto_pick BOOLEAN,
  p_skip_pick BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  IF p_auto_pick AND p_skip_pick THEN
    RAISE EXCEPTION 'Auto-pick and skip-pick are mutually exclusive.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  SELECT s.id INTO v_season_id
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No season exists for this league.';
  END IF;

  UPDATE public.draft_priority_lists d
  SET
    auto_pick = p_auto_pick,
    skip_pick = p_skip_pick
  WHERE d.season_id = v_season_id
    AND d.user_id = v_user_id
    AND d.round_number = p_round_number;
END;
$$;
