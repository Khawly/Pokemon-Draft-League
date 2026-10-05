-- Lets a trade proposal carry tokens
--
-- Re-issues propose_trade with two new optional arguments, one per side, and the
-- validation that goes with them. Everything else is carried over verbatim from
-- 20261104 so the roster checks, the one-open-proposal-per-pair guard, the
-- duplicate-slug guards, and the item inserts behave exactly as they did.
--
-- The arguments are additive with defaults, but the signature changed, so the
-- four-argument overload is dropped first: CREATE OR REPLACE would otherwise leave
-- both registered and PostgREST would have two candidates to choose between for
-- the same call name.

DROP FUNCTION IF EXISTS public.propose_trade(UUID, UUID, JSONB, JSONB);

-- Re-issues propose_trade with per-side token amounts.
--
-- Tokens are only accepted when the league has opted in via
-- league_settings.allow_token_trades, which is itself only meaningful when
-- enable_pokemon_costs is on. Both sides' amounts are validated here for a
-- readable error, but they are re-validated at completion, because a proposal can
-- sit unanswered for a week and a balance can move underneath it.
--
-- @param p_league_id        - The league the trade belongs to.
-- @param p_recipient_user_id- The member being traded with.
-- @param p_offer            - JSONB array of {pokemon_id} leaving the proposer's roster.
-- @param p_request          - JSONB array of {pokemon_id} leaving the recipient's roster.
-- @param p_proposer_tokens  - Tokens the proposer sends. 0 for none.
-- @param p_recipient_tokens - Tokens the recipient sends. 0 for none.
-- @returns The id of the created trade.
CREATE OR REPLACE FUNCTION public.propose_trade(
  p_league_id UUID,
  p_recipient_user_id UUID,
  p_offer JSONB,
  p_request JSONB,
  p_proposer_tokens INTEGER DEFAULT 0,
  p_recipient_tokens INTEGER DEFAULT 0
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
  v_allow_token_trades BOOLEAN;
  v_enable_costs BOOLEAN;
  v_proposer_tokens INTEGER;
  v_recipient_tokens INTEGER;
  v_remaining INTEGER;
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

  /*
   * Normalized before anything else uses them. COALESCE covers a caller that sends
   * an explicit null, and GREATEST covers a negative amount, so the checks below
   * and the stored row can assume a non-negative integer either way.
   */
  v_proposer_tokens := GREATEST(COALESCE(p_proposer_tokens, 0), 0);
  v_recipient_tokens := GREATEST(COALESCE(p_recipient_tokens, 0), 0);

  IF (p_proposer_tokens IS NOT NULL AND p_proposer_tokens < 0)
     OR (p_recipient_tokens IS NOT NULL AND p_recipient_tokens < 0) THEN
    RAISE EXCEPTION 'Tokens sent on a trade cannot be negative.';
  END IF;

  IF v_proposer_tokens = 0 AND v_recipient_tokens = 0
     AND p_offer IS NULL AND p_request IS NULL THEN
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
     + COALESCE(array_length(v_request_ids, 1), 0) = 0
     AND v_proposer_tokens = 0 AND v_recipient_tokens = 0 THEN
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

  /*
   * Tokens are opt-in twice over. Costs off means the token economy is not running
   * at all, so a token amount has nothing to be measured against; the setting off
   * is the league owner's choice. Both are read together so the reason a member
   * gets is the one they can act on.
   */
  IF v_proposer_tokens > 0 OR v_recipient_tokens > 0 THEN
    SELECT
      COALESCE(ls.enable_pokemon_costs, FALSE),
      COALESCE(ls.allow_token_trades, FALSE)
    INTO v_enable_costs, v_allow_token_trades
    FROM public.league_settings ls
    WHERE ls.season_id = v_season_id;

    IF NOT v_enable_costs THEN
      RAISE EXCEPTION 'Tokens cannot be traded because this league does not have Pokémon costs enabled.';
    END IF;

    IF NOT v_allow_token_trades THEN
      RAISE EXCEPTION 'Tokens cannot be traded because this league has not enabled token trades.';
    END IF;

    /*
     * Solvency now, so the member is not invited into a proposal that cannot
     * complete. `remaining` comes back null when costs are off, which is unbounded
     * rather than broke; the costs check above has already passed by this point, so
     * a null here would mean the two reads disagree and is treated as unbounded
     * rather than silently allowing a negative balance.
     */
    IF v_proposer_tokens > 0 THEN
      SELECT ts.remaining INTO v_remaining
      FROM public.team_salary_totals(p_team_id => v_my_team_id) ts;

      IF v_remaining IS NOT NULL AND v_remaining < v_proposer_tokens THEN
        RAISE EXCEPTION 'You only have % tokens left, so you cannot send %.',
          v_remaining, v_proposer_tokens;
      END IF;
    END IF;

    IF v_recipient_tokens > 0 THEN
      SELECT ts.remaining INTO v_remaining
      FROM public.team_salary_totals(p_team_id => v_their_team_id) ts;

      IF v_remaining IS NOT NULL AND v_remaining < v_recipient_tokens THEN
        RAISE EXCEPTION '% does not have % tokens left to send.',
          p_recipient_user_id, v_recipient_tokens;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.trades (
    league_id, season_id, proposer_user_id, recipient_user_id, status,
    proposer_token_amount, recipient_token_amount
  ) VALUES (
    p_league_id, v_season_id, v_user_id, p_recipient_user_id, 'awaiting_response',
    v_proposer_tokens, v_recipient_tokens
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

REVOKE ALL ON FUNCTION public.propose_trade(UUID, UUID, JSONB, JSONB, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_trade(UUID, UUID, JSONB, JSONB, INTEGER, INTEGER) TO authenticated;

-- Force PostgREST to pick up the new function body immediately.
NOTIFY pgrst, 'reload schema';