-- Moves tokens when a trade completes
--
-- Re-issues complete_trade (latest version from 20261106) so a completed trade
-- settles its token amounts as well as its Pokémon. Everything else is carried
-- over verbatim: the lock and idempotency guard, the per-item roster re-check, the
-- same-Pokémon-on-both-sides refusal, the team lookups, the solvency pre-check, the
-- mirrored trade_out/trade_in ledger pairs, and the completion notice.
--
-- Two things had to change rather than just extend:
--
--   * The solvency pre-check built its per-team ledger delta out of roster tiers
--     alone, so a trade sending 50 tokens against no Pokémon would have looked
--     like a no-op to it. The token deltas are now part of the same union, which
--     is what makes "you cannot send tokens you do not have" hold at completion.
--   * The ledger rows for tokens pass `source` explicitly. The
--     transactions_classify_source trigger classifies any row that does not, and
--     its trade_in/trade_out branch does not match the new action, so it would
--     have fallen through to looking up team_roster by a null pokemon_id and
--     filed every token transfer as 'free_agent_pickup'.

CREATE OR REPLACE FUNCTION public.complete_trade(p_trade_id UUID, p_actor_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade RECORD;
  v_item RECORD;
  v_proposer_team_id UUID;
  v_recipient_team_id UUID;
  v_tier INTEGER;
  v_species TEXT;
  v_enable_costs BOOLEAN;
  v_allow_token_trades BOOLEAN;
  v_proposer_tokens INTEGER;
  v_recipient_tokens INTEGER;
  v_sides RECORD;
  v_remaining INTEGER;
  v_receiving_team_id UUID;
  v_receiving_user_id UUID;
BEGIN
  -- Lock the trade so two approvers pressing the button at once cannot both run
  -- the swap. The second one sees status = 'completed' and returns unchanged.
  SELECT * INTO v_trade FROM public.trades t WHERE t.id = p_trade_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That trade does not exist.';
  END IF;

  IF v_trade.status = 'completed' THEN
    RETURN 'completed';
  END IF;

  IF v_trade.status NOT IN ('approved', 'pending_approval') THEN
    RAISE EXCEPTION 'That trade is not ready to complete.';
  END IF;

  SELECT t.id INTO v_proposer_team_id
  FROM public.teams t
  WHERE t.season_id = v_trade.season_id AND t.owner_user_id = v_trade.proposer_user_id
  LIMIT 1;

  SELECT t.id INTO v_recipient_team_id
  FROM public.teams t
  WHERE t.season_id = v_trade.season_id AND t.owner_user_id = v_trade.recipient_user_id
  LIMIT 1;

  IF v_proposer_team_id IS NULL OR v_recipient_team_id IS NULL THEN
    RAISE EXCEPTION 'Both members need a team in this season for the trade to complete.';
  END IF;

  -- Re-read every item against the roster as it stands now. A proposal can sit in
  -- someone's inbox for a week, and a Pokémon on it may have been released or
  -- picked up in the meantime; the trade that was agreed is not the trade that can
  -- legally happen.
  FOR v_item IN
    SELECT ti.* FROM public.trade_items ti WHERE ti.trade_id = p_trade_id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.team_roster r
      WHERE r.team_id = v_item.team_id AND r.pokemon_id = v_item.pokemon_id
    ) THEN
      RAISE EXCEPTION 'A Pokémon in this trade is no longer on the roster it was offered from.';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.team_roster r
      JOIN public.teams t ON t.id = r.team_id
      WHERE t.season_id = v_trade.season_id
        AND r.pokemon_id = v_item.pokemon_id
        AND r.team_id <> v_item.team_id
    ) THEN
      RAISE EXCEPTION 'A Pokémon in this trade is already on another team.';
    END IF;
  END LOOP;

  /*
   * A Pokémon offered by both sides would be deleted from one roster and inserted
   * onto the other twice, so it is refused rather than silently collapsed. The
   * proposer is prevented from building that at proposal time, but the rows can
   * also be edited by anything holding broader rights, so it is re-checked here.
   */
  IF EXISTS (
    SELECT 1 FROM public.trade_items a
    JOIN public.trade_items b ON b.trade_id = a.trade_id
    WHERE a.trade_id = p_trade_id
      AND a.id < b.id
      AND a.pokemon_id = b.pokemon_id
  ) THEN
    RAISE EXCEPTION 'The same Pokémon cannot appear on both sides of a trade.';
  END IF;

  SELECT
    COALESCE(ls.enable_pokemon_costs, FALSE),
    COALESCE(ls.allow_token_trades, FALSE)
  INTO v_enable_costs, v_allow_token_trades
  FROM public.league_settings ls
  WHERE ls.season_id = v_trade.season_id;

  -- Trades proposed before the token columns existed carry 0 here, and trades
  -- proposed since default to 0, so a Pokemon-only trade takes this path with
  -- nothing to do.
  v_proposer_tokens := COALESCE(v_trade.proposer_token_amount, 0);
  v_recipient_tokens := COALESCE(v_trade.recipient_token_amount, 0);

  /*
   * The owner can switch token trades off while a token-carrying proposal is still
   * sitting unanswered. Settling it anyway would move value the league has since
   * stopped allowing, so the trade is refused and left for someone to withdraw.
   */
  IF (v_proposer_tokens > 0 OR v_recipient_tokens > 0) AND NOT v_allow_token_trades THEN
    RAISE EXCEPTION 'This trade sends tokens, but this league no longer has token trades enabled.';
  END IF;

  /*
   * What each team's ledger sum will be once the swap lands, built from the same
   * rows the move loop below writes rather than from a re-derivation of them. A
   * positive `ledger_delta` adds to `spent`, and `remaining` is budget minus spent,
   * so it has to be subtracted. With costs switched off neither branch produces a
   * row, so the loop is empty and there is nothing to enforce.
   *
   * The table is aliased `ti`, not `v_item`. A plpgsql alias cannot reuse the name of
   * a record variable declared in the same function: plpgsql substitutes variables
   * before Postgres parses the query, so the two would make every `ti.team_id`
   * reference ambiguous and the function would fail to plan at all.
   */
  FOR v_sides IN
    SELECT d.team_id, SUM(d.cost_delta) AS ledger_delta
    FROM (
      -- Sent: the holding team is credited back the tier it no longer carries.
      SELECT ti.team_id AS team_id, -r.tier_value AS cost_delta
      FROM public.trade_items ti
      JOIN public.team_roster r
        ON r.team_id = ti.team_id AND r.pokemon_id = ti.pokemon_id
      WHERE ti.trade_id = p_trade_id AND v_enable_costs
      UNION ALL
      -- Received: the other team is charged for the tier it has just taken on.
      SELECT
        CASE
          WHEN ti.side = 'proposer' THEN v_recipient_team_id
          ELSE v_proposer_team_id
        END AS team_id,
        r.tier_value AS cost_delta
      FROM public.trade_items ti
      JOIN public.team_roster r
        ON r.team_id = ti.team_id AND r.pokemon_id = ti.pokemon_id
      WHERE ti.trade_id = p_trade_id AND v_enable_costs
      UNION ALL
      /*
       * Tokens the proposer sends: a positive `ledger_delta`, so its spend rises and
       * its remaining falls by the amount. Tokens are the currency rather than a
       * purchased good, so sending them costs the sender budget instead of freeing
       * it the way sending a Pokémon frees the tier it no longer carries.
       */
      SELECT v_proposer_team_id AS team_id, v_proposer_tokens AS cost_delta
      WHERE v_enable_costs AND v_proposer_tokens > 0
      UNION ALL
      -- Tokens the recipient sends: charged, so its spend falls by the amount.
      SELECT v_recipient_team_id AS team_id, -v_recipient_tokens AS cost_delta
      WHERE v_enable_costs AND v_recipient_tokens > 0
    ) d
    GROUP BY d.team_id
  LOOP
    -- A null remaining also means costs are off, which is unbounded, not broke.
    SELECT ts.remaining INTO v_remaining
    FROM public.team_salary_totals(p_team_id => v_sides.team_id) ts;

    IF v_remaining IS NOT NULL AND (v_remaining - v_sides.ledger_delta) < 0 THEN
      RAISE EXCEPTION 'This trade would put a team''s token salary below 0.';
    END IF;
  END LOOP;

  -- Move each Pokémon, preserving the tier value it was acquired at.
  FOR v_item IN
    SELECT ti.* FROM public.trade_items ti WHERE ti.trade_id = p_trade_id
  LOOP
    SELECT r.tier_value, r.species_name INTO v_tier, v_species
    FROM public.team_roster r
    WHERE r.team_id = v_item.team_id AND r.pokemon_id = v_item.pokemon_id;

    v_receiving_team_id := CASE
      WHEN v_item.side = 'proposer' THEN v_recipient_team_id
      ELSE v_proposer_team_id
    END;
    v_receiving_user_id := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_user_id
      ELSE v_trade.proposer_user_id
    END;

    DELETE FROM public.team_roster r
    WHERE r.team_id = v_item.team_id AND r.pokemon_id = v_item.pokemon_id;

    INSERT INTO public.team_roster (
      team_id, pokemon_id, species_name, tier_value, source
    ) VALUES (
      v_receiving_team_id, v_item.pokemon_id, v_species, v_tier, 'trade'
    );

    /*
     * Two ledger rows per Pokémon, one per side, because a team's spend is the sum
     * of its own `cost_delta` and `trade_in`/`trade_out` are what say which
     * direction the value moved. The tier is charged to the receiver and credited
     * back to the sender, so each team's ledger still equals its roster's tier
     * total after the swap. Writing a single zero-cost row would leave a team that
     * gave up a tier 5 for a tier 1 still paying for the tier 5 it no longer has,
     * and the salary every page reads would silently disagree with the roster.
     *
     * Costs disabled means the tier was never charged in the first place, so
     * neither side moves -- matching insert_draft_pick and pickup_roster_pokemon.
     */
    INSERT INTO public.transactions (
      league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
      cost_delta, note
    ) VALUES (
      v_trade.league_id, v_trade.season_id, v_item.user_id, v_item.team_id,
      v_item.pokemon_id, 'trade_out', 1,
      CASE WHEN v_enable_costs THEN -v_tier ELSE 0 END, 'Traded away'
    );

    INSERT INTO public.transactions (
      league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
      cost_delta, note
    ) VALUES (
      v_trade.league_id, v_trade.season_id, v_receiving_user_id,
      v_receiving_team_id, v_item.pokemon_id, 'trade_in', 1,
      CASE WHEN v_enable_costs THEN v_tier ELSE 0 END, 'Traded in'
    );
  END LOOP;

  /*
   * Two ledger rows per token side, mirroring the Pokémon pairing above, but with
   * the opposite sense to the tier rows: the sender is charged for the tokens it
   * gives away and the receiver is credited, because tokens are the currency the
   * other side then spends. Each row is written against its own team so the sum of
   * cost_delta per team stays the authority for that team's salary.
   *
   * pokemon_id is null because there is no Pokémon in a token movement, and source
   * is stated rather than left to the trigger: the trigger's trade_in/trade_out
   * branch does not match 'token_transfer', so it would otherwise fall through to
   * looking up team_roster by a null pokemon_id and file this as a free agent
   * pickup.
   */
  IF v_enable_costs AND v_proposer_tokens > 0 THEN
    INSERT INTO public.transactions (
      league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
      cost_delta, source, note
    ) VALUES (
      v_trade.league_id, v_trade.season_id, v_trade.proposer_user_id,
      v_proposer_team_id, NULL, 'token_transfer', 1,
      v_proposer_tokens, 'trade', 'Tokens traded away'
    );

    INSERT INTO public.transactions (
      league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
      cost_delta, source, note
    ) VALUES (
      v_trade.league_id, v_trade.season_id, v_trade.recipient_user_id,
      v_recipient_team_id, NULL, 'token_transfer', 1,
      -v_proposer_tokens, 'trade', 'Tokens traded in'
    );
  END IF;

  IF v_enable_costs AND v_recipient_tokens > 0 THEN
    INSERT INTO public.transactions (
      league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
      cost_delta, source, note
    ) VALUES (
      v_trade.league_id, v_trade.season_id, v_trade.recipient_user_id,
      v_recipient_team_id, NULL, 'token_transfer', 1,
      v_recipient_tokens, 'trade', 'Tokens traded away'
    );

    INSERT INTO public.transactions (
      league_id, season_id, user_id, team_id, pokemon_id, action, quantity,
      cost_delta, source, note
    ) VALUES (
      v_trade.league_id, v_trade.season_id, v_trade.proposer_user_id,
      v_proposer_team_id, NULL, 'token_transfer', 1,
      -v_recipient_tokens, 'trade', 'Tokens traded in'
    );
  END IF;

  UPDATE public.trades
  SET status = 'completed',
      completed_at = NOW(),
      completed_by = p_actor_user_id
  WHERE id = p_trade_id;

  PERFORM public.notify_trade_user(
    v_trade.league_id, v_trade.season_id, v_trade.proposer_user_id,
    p_actor_user_id, 'trade_completed',
    'Your trade was completed.', p_trade_id
  );
  PERFORM public.notify_trade_user(
    v_trade.league_id, v_trade.season_id, v_trade.recipient_user_id,
    p_actor_user_id, 'trade_completed',
    'Your trade was completed.', p_trade_id
  );

  RETURN 'completed';
END;
$$;

-- Force PostgREST to pick up the new function body immediately.
NOTIFY pgrst, 'reload schema';