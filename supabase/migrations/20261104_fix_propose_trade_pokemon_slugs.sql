-- Fix propose_trade reading the Pokémon slugs out of its JSONB arguments
--
-- `propose_trade` has never once succeeded. Every proposal died with "You can only
-- offer Pokémon from your own roster", and the trades table was empty, which is how
-- the bug was found.
--
-- The cause is one function name. The client sends each side as an array of objects,
-- `[{"pokemon_id":"applin"}]`, and the roster checks compare the extracted value
-- against `team_roster.pokemon_id`. The extraction used:
--
--   ARRAY(SELECT jsonb_array_elements_text(p_offer))
--
-- `jsonb_array_elements_text` returns each element rendered *as text*, which for an
-- object element is the whole object -- '{"pokemon_id": "applin"}' -- not the field
-- inside it. So the comparison became
--
--   WHERE r.pokemon_id = '{"pokemon_id": "applin"}'
--
-- which never matches anything, and every offer was rejected as if the member had
-- picked a Pokémon off someone else's roster. The empty-roster and unknown-Pokémon
-- paths were unreachable, so the error named the wrong problem entirely: the member
-- had done nothing wrong and was told they had.
--
-- The fix reads the field with `->>` out of each element. Written as its own
-- migration rather than an edit to 20261103 because that version is already applied
-- and Supabase tracks applied migrations by name, so an in-place correction would
-- never be re-run on any deployed database.

CREATE OR REPLACE FUNCTION public.propose_trade(
  p_league_id UUID,
  p_recipient_user_id UUID,
  p_offer JSONB,
  p_request JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_season_id UUID;
  v_season_status TEXT;
  v_my_team_id UUID;
  v_their_team_id UUID;
  v_trade_id UUID;
  v_pokemon_id TEXT;
  v_offer_ids TEXT[];
  v_request_ids TEXT[];
  v_roster_team_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to propose a trade.';
  END IF;

  IF NOT public.is_active_league_member(p_league_id) THEN
    RAISE EXCEPTION 'You are not an active member of this league.';
  END IF;

  IF p_recipient_user_id IS NULL OR p_recipient_user_id = v_user_id THEN
    RAISE EXCEPTION 'Choose another member to trade with.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = p_league_id
      AND lm.user_id = p_recipient_user_id
      AND lm.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'That member is not in this league.';
  END IF;

  SELECT s.id, s.status INTO v_season_id, v_season_status
  FROM public.seasons s
  WHERE s.league_id = p_league_id
  ORDER BY s.season_number DESC
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'This league has no seasons yet.';
  END IF;

  -- Rosters are not tradeable mid-draft: a pick in flight is a claim on a Pokémon
  -- the owner has not finished taking, and the draft engine is the source of truth
  -- for picks while it runs.
  IF v_season_status <> 'draft_complete' THEN
    RAISE EXCEPTION 'Trades unlock once the draft is complete.';
  END IF;

  SELECT t.id INTO v_my_team_id
  FROM public.teams t
  WHERE t.season_id = v_season_id AND t.owner_user_id = v_user_id
  LIMIT 1;

  IF v_my_team_id IS NULL THEN
    RAISE EXCEPTION 'You do not own a team in this season.';
  END IF;

  SELECT t.id INTO v_their_team_id
  FROM public.teams t
  WHERE t.season_id = v_season_id AND t.owner_user_id = p_recipient_user_id
  LIMIT 1;

  IF v_their_team_id IS NULL THEN
    RAISE EXCEPTION 'That member does not have a team in this season.';
  END IF;

  -- One open question per pair. The partial unique index is the real guard; this
  -- raises the readable version of the same rule.
  IF EXISTS (
    SELECT 1 FROM public.trades t
    WHERE t.season_id = v_season_id
      AND t.proposer_user_id = v_user_id
      AND t.recipient_user_id = p_recipient_user_id
      AND t.status IN ('awaiting_response', 'pending_approval', 'approved')
  ) THEN
    RAISE EXCEPTION 'You already have a trade open with that member. Withdraw it before proposing another.';
  END IF;

  IF p_offer IS NULL AND p_request IS NULL THEN
    RAISE EXCEPTION 'Choose at least one Pokémon to send.';
  END IF;

  /*
   * Both sides are read out once so the cross-side check below is a single
   * membership test against an array rather than a correlated scan re-run per
   * Pokémon.
   *
   * `->> 'pokemon_id'` is load-bearing. The elements are objects, and the roster
   * checks need the slug *inside* them; `jsonb_array_elements_text` would yield the
   * whole object as text and every offer would then be compared against a string
   * like '{"pokemon_id": "applin"}', which matches no roster row. The empty-array
   * case is covered by COALESCE because an SRF that returns no rows gives an empty
   * array rather than a null one.
   */
  SELECT
    COALESCE(
      ARRAY(SELECT item ->> 'pokemon_id' FROM jsonb_array_elements(p_offer) AS item),
      ARRAY[]::TEXT[]
    ),
    COALESCE(
      ARRAY(SELECT item ->> 'pokemon_id' FROM jsonb_array_elements(p_request) AS item),
      ARRAY[]::TEXT[]
    )
  INTO v_offer_ids, v_request_ids;

  FOR v_pokemon_id IN SELECT unnest(v_offer_ids)
  LOOP
    IF v_pokemon_id IS NULL OR v_pokemon_id = '' THEN
      RAISE EXCEPTION 'One of the Pokémon in this trade is not recognised.';
    END IF;

    SELECT r.team_id INTO v_roster_team_id
    FROM public.team_roster r
    WHERE r.team_id = v_my_team_id AND r.pokemon_id = v_pokemon_id;

    IF v_roster_team_id IS NULL THEN
      RAISE EXCEPTION 'You can only offer Pokémon from your own roster.';
    END IF;

    IF v_pokemon_id = ANY (v_request_ids) THEN
      RAISE EXCEPTION 'The same Pokémon cannot be on both sides of a trade.';
    END IF;
  END LOOP;

  FOR v_pokemon_id IN SELECT unnest(v_request_ids)
  LOOP
    IF v_pokemon_id IS NULL OR v_pokemon_id = '' THEN
      RAISE EXCEPTION 'One of the Pokémon in this trade is not recognised.';
    END IF;

    SELECT r.team_id INTO v_roster_team_id
    FROM public.team_roster r
    WHERE r.team_id = v_their_team_id AND r.pokemon_id = v_pokemon_id;

    IF v_roster_team_id IS NULL THEN
      RAISE EXCEPTION 'You can only ask for Pokémon from their roster.';
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_offer_ids, 1), 0)
     + COALESCE(array_length(v_request_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Choose at least one Pokémon to send.';
  END IF;

  -- A repeated slug on one side would be moved twice at completion, which fails on
  -- the receiving roster's unique key. Rejecting it here gives the member a
  -- readable reason instead of a constraint violation.
  IF (SELECT COUNT(DISTINCT slug) FROM unnest(v_offer_ids) AS slug)
       <> COALESCE(array_length(v_offer_ids, 1), 0)
     OR (SELECT COUNT(DISTINCT slug) FROM unnest(v_request_ids) AS slug)
       <> COALESCE(array_length(v_request_ids, 1), 0) THEN
    RAISE EXCEPTION 'The same Pokémon cannot be listed twice on one side of a trade.';
  END IF;

  INSERT INTO public.trades (
    league_id, season_id, proposer_user_id, recipient_user_id, status
  ) VALUES (
    p_league_id, v_season_id, v_user_id, p_recipient_user_id, 'awaiting_response'
  )
  RETURNING id INTO v_trade_id;

  FOR v_pokemon_id IN SELECT unnest(v_offer_ids)
  LOOP
    INSERT INTO public.trade_items (trade_id, side, user_id, team_id, pokemon_id)
    VALUES (v_trade_id, 'proposer', v_user_id, v_my_team_id, v_pokemon_id);
  END LOOP;

  FOR v_pokemon_id IN SELECT unnest(v_request_ids)
  LOOP
    INSERT INTO public.trade_items (trade_id, side, user_id, team_id, pokemon_id)
    VALUES (v_trade_id, 'recipient', p_recipient_user_id, v_their_team_id, v_pokemon_id);
  END LOOP;

  PERFORM public.notify_trade_user(
    p_league_id, v_season_id, p_recipient_user_id, v_user_id, 'trade_proposed',
    'You have a new trade proposal to answer.', v_trade_id
  );

  RETURN v_trade_id;
END;
$$;

REVOKE ALL ON FUNCTION public.propose_trade(UUID, UUID, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_trade(UUID, UUID, JSONB, JSONB) TO authenticated;

-- Force PostgREST to pick up the new function body immediately.
NOTIFY pgrst, 'reload schema';
