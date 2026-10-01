-- Trades page: proposal, response, approval, and completion
--
-- The `trades` and `trade_items` tables shipped in the initial schema with a full
-- status vocabulary and RLS enabled, but no policy to write through and no way to
-- express an approval quorum: `trades.status` alone cannot record *who* voted, so
-- "deterministic and based on recorded votes" (spec 4.3) had nowhere to live. This
-- migration builds the whole write path.
--
-- The state machine, and which function owns each transition:
--
--   (none)
--     -> awaiting_response   propose_trade          proposer -> recipient
--   awaiting_response
--     -> cancelled           respond_to_trade(false) recipient declines
--     -> cancelled           cancel_trade           proposer withdraws
--     -> pending_approval    respond_to_trade(true)  approval is required
--     -> approved            respond_to_trade(true)  approval is switched off
--   pending_approval
--     -> approved            vote_on_trade           quorum reached
--     -> rejected            vote_on_trade           an approver said no
--     -> completed           vote_on_trade           the owner overrides
--   approved
--     -> completed           complete_trade          the single roster swap
--   completed | cancelled | rejected
--     -> (unchanged status)  dismiss_trade          only records the caller's own
--                                                    dismissal, for their list only
--
-- Everything that moves a Pokémon goes through `complete_trade`, which is not
-- granted to any role. A roster swap touches two rosters and four ledger rows, so
-- having one entry point is the only way to guarantee it cannot half-apply: it is
-- reached exclusively from the two SECURITY DEFINER callers above, inside their
-- transaction.
--
-- Cost accounting: a trade is not token-neutral. The tier value is a cost the
-- league charged for the Pokémon, and it is paid by whoever is holding the
-- Pokémon, so a trade moves that cost with it. Each moved Pokémon therefore writes
-- two ledger rows -- a `trade_out` crediting the sender's team and a `trade_in`
-- charging the receiver's -- and each team's ledger sum still equals its roster's
-- tier total afterwards. That is what makes the projected balances the page shows
-- before submitting real rather than decorative, and it is why the invariant that a
-- budget may not go below zero has to be re-checked here: handing away more tier
-- value than you take back does move a balance, so `complete_trade` recomputes
-- both sides before it writes anything and refuses the whole trade if either would
-- land below zero. With costs switched off no tier was ever charged, so both rows
-- are zero, matching insert_draft_pick and pickup_roster_pokemon.
--
-- Approval settings are read from `league_settings` rather than stored on the
-- trade, so a change the owner makes applies to the trades still in flight rather
-- than freezing whatever was configured when they were proposed.

-- ---------------------------------------------------------------- new columns

-- When the roster swap landed. Spec 12.4 requires a completed trade to carry a
-- timestamp of its own: `updated_at` also moves on a later dismissal, so it cannot
-- be read as the moment the rosters changed.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- The user whose action completed the trade, for the audit trail spec 4.1 asks
-- every mutation to carry.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ------------------------------------------------------------- dismissal rows

-- A member clearing a settled or refused trade off their own list.
--
-- Deliberately a table rather than a column on `trades`. Both parties see the same
-- card, and the spec's "Clear" control is per member: one person clearing their
-- copy must not silently remove it from the other person's list too. A single
-- `dismissed_at` on the trade would do exactly that, and the person who wanted to
-- tidy their screen would be deleting the other party's view as well.
CREATE TABLE IF NOT EXISTS public.trade_dismissals (
  trade_id UUID NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trade_id, user_id)
);

ALTER TABLE public.trade_dismissals ENABLE ROW LEVEL SECURITY;

-- Serves the Trades page's "cleared by me" lookup, which is always scoped to the
-- signed-in member across every trade they can see.
CREATE INDEX IF NOT EXISTS trade_dismissals_user_id_idx
  ON public.trade_dismissals (user_id);

-- Members read and remove only their own dismissals. Clearing a card again after
-- seeing it is not a state transition, so the DELETE is offered directly rather than
-- through an RPC; the INSERT is not, because a row here asserts that a trade has
-- settled and the caller is one of its parties, and only `dismiss_trade` checks that.
DROP POLICY IF EXISTS "Members can view their own trade dismissals" ON public.trade_dismissals;
CREATE POLICY "Members can view their own trade dismissals"
ON public.trade_dismissals
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Members can undo their own trade dismissal" ON public.trade_dismissals;
CREATE POLICY "Members can undo their own trade dismissal"
ON public.trade_dismissals
FOR DELETE
TO authenticated
USING (user_id = auth.uid());

-- ------------------------------------------------------------------ vote rows

-- One recorded decision per approver per trade.
--
-- The schema's own invariant is that trade approval is "deterministic and based
-- on recorded votes", so a vote is a row rather than a flag on `trades`. The
-- UNIQUE constraint is also what makes the workflow idempotent: re-voting from a
-- double-clicked button updates the existing row instead of inflating the count
-- and manufacturing a quorum nobody cast.
CREATE TABLE IF NOT EXISTS public.trade_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  voter_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  -- True when the owner used Approve (Override) to settle the trade without
  -- waiting for the quorum. Recorded rather than inferred from a single approval
  -- so the history says which of the two rules was applied.
  is_override BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trade_id, voter_user_id)
);

ALTER TABLE public.trade_votes ENABLE ROW LEVEL SECURITY;

-- Speeds the approval tally and the history render, both of which read a trade's
-- votes as a group.
CREATE INDEX IF NOT EXISTS trade_votes_trade_id_idx
  ON public.trade_votes (trade_id);

-- Serves the Trades page: the season's trades, newest first, split by status.
CREATE INDEX IF NOT EXISTS trades_league_season_status_idx
  ON public.trades (league_id, season_id, status, created_at DESC);

-- Serves the items of one trade, which every card renders.
CREATE INDEX IF NOT EXISTS trade_items_trade_id_idx
  ON public.trade_items (trade_id);

-- At most one open question per pair, per season.
--
-- A member cannot have two proposals in flight to the same person: neither could
-- be answered without leaving the other ambiguous. It also makes a double-clicked
-- submit a constraint violation rather than a duplicate trade, which is the same
-- guarantee the match-time proposal flow relies on.
CREATE UNIQUE INDEX IF NOT EXISTS trades_one_open_per_pair_uk
  ON public.trades (proposer_user_id, recipient_user_id, season_id)
  WHERE status IN ('awaiting_response', 'pending_approval', 'approved');

-- ------------------------------------------------------------ read predicates

-- True when the caller is one of the two parties to a trade.
--
-- SECURITY DEFINER because the `trades` policies below read this, and evaluating
-- it directly inside a policy on `trades` would recurse through the same table.
CREATE OR REPLACE FUNCTION public.is_trade_party(p_trade_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.trades t
    WHERE t.id = p_trade_id
      AND (t.proposer_user_id = auth.uid() OR t.recipient_user_id = auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_trade_party(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_trade_party(UUID) TO authenticated;

-- True when the caller is the league owner or one of its admins.
--
-- SECURITY DEFINER so it can be read from inside a policy without re-entering
-- `league_members`' own policy, which is the same recursion the initial migration's
-- fix for `is_active_league_member` was about.
CREATE OR REPLACE FUNCTION public.is_league_staff(p_league_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = p_league_id
      AND lm.user_id = auth.uid()
      AND lm.is_active = TRUE
      AND lm.role IN ('owner', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.is_league_staff(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_league_staff(UUID) TO authenticated;

-- True when the caller may read a trade.
--
-- Spec 12.4 splits the audience in three.
--
--   The two parties, at every stage. A proposal is a negotiation between two people
--   and is nobody else's business while it is in flight.
--
--   League staff, once the trade has been accepted and is waiting on a decision.
--   Without this the Approvals tab would be dead on arrival: `vote_on_trade` lets
--   the owner and admins settle a trade, but a policy that hid pending trades from
--   everyone but their parties would never show them the question they are being
--   asked. The pre-agreement states stay private to the two members, so staff see
--   the negotiation only from the point where the members have already agreed to it.
--
--   Any active member, once it has completed. A completed trade changed two rosters
--   every member can see, so the whole league reads it, with a timestamp.
CREATE OR REPLACE FUNCTION public.can_view_trade(p_trade_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.trades t
    WHERE t.id = p_trade_id
      AND (
        t.proposer_user_id = auth.uid()
        OR t.recipient_user_id = auth.uid()
        OR (
          t.status IN ('pending_approval', 'approved', 'rejected', 'completed')
          AND public.is_league_staff(t.league_id)
        )
        OR (
          t.status = 'completed'
          AND public.is_active_league_member(t.league_id)
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.can_view_trade(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_view_trade(UUID) TO authenticated;

-- Every member who votes on trades in a season: the owner always, plus the admins
-- when the owner has enabled Owner/Admin voting.
--
-- Scoped by season rather than by league because the voting flag lives on
-- `league_settings`, which is per season. Reading it at league scope would let a
-- flag left on for an archived season pull the admins into the quorum for the
-- current one.
--
-- Exposed because the Trades page has to say how far a pending approval has got
-- ("1 of 3 approvals") and cannot derive the denominator from `trades` alone.
CREATE OR REPLACE FUNCTION public.trade_approver_ids(p_league_id UUID, p_season_id UUID)
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT lm.user_id
      FROM public.league_members lm
      WHERE lm.league_id = p_league_id
        AND lm.is_active = TRUE
        AND lm.role = 'owner'
      UNION
      SELECT lm.user_id
      FROM public.league_members lm
      WHERE lm.league_id = p_league_id
        AND lm.is_active = TRUE
        AND lm.role = 'admin'
        AND COALESCE((
          SELECT ls.owners_admins_vote_on_trades
          FROM public.league_settings ls
          WHERE ls.season_id = p_season_id
        ), FALSE)
    ),
    ARRAY[]::UUID[]
  );
$$;

REVOKE ALL ON FUNCTION public.trade_approver_ids(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trade_approver_ids(UUID, UUID) TO authenticated;

-- ------------------------------------------------------------------- policies

-- Replaces the party-only policy from 20261020 with the split audience above.
DROP POLICY IF EXISTS "Members can view their league trades" ON public.trades;
CREATE POLICY "Members can view their league trades"
ON public.trades
FOR SELECT
TO authenticated
USING (public.can_view_trade(id));

-- The items of a trade. `trade_items` had RLS enabled with no policy at all, so
-- even the two people in the negotiation could not read what was on the table.
DROP POLICY IF EXISTS "Members can view visible trade items" ON public.trade_items;
CREATE POLICY "Members can view visible trade items"
ON public.trade_items
FOR SELECT
TO authenticated
USING (public.can_view_trade(trade_id));

-- The parties see where an approval stands, and league staff see it so the
-- Approvals tab can render the same tally the database counts. Staff reach the
-- trade row here for the same reason `can_view_trade` lets them: a vote they are
-- entitled to cast has to be visible to them. No client write policy: a vote is only
-- ever recorded by vote_on_trade, so the quorum cannot be forged from the browser.
DROP POLICY IF EXISTS "Trade parties and staff can view trade votes" ON public.trade_votes;
CREATE POLICY "Trade parties and staff can view trade votes"
ON public.trade_votes
FOR SELECT
TO authenticated
USING (
  public.is_trade_party(trade_id)
  OR EXISTS (
    SELECT 1
    FROM public.trades t
    WHERE t.id = trade_votes.trade_id
      AND public.is_league_staff(t.league_id)
  )
);

-- ------------------------------------------------------------- notifications

-- Raises one notification for a single recipient, linked back to the trade.
CREATE OR REPLACE FUNCTION public.notify_trade_user(
  p_league_id UUID,
  p_season_id UUID,
  p_recipient_user_id UUID,
  p_actor_user_id UUID,
  p_type TEXT,
  p_message TEXT,
  p_trade_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_recipient_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.notifications (
    league_id, season_id, recipient_user_id, actor_user_id, type, message,
    related_entity_type, related_entity_id
  ) VALUES (
    p_league_id, p_season_id, p_recipient_user_id, p_actor_user_id, p_type,
    p_message, 'trade', p_trade_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.notify_trade_user(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC;

-- Raises the same notification for every approver except the actor, so the person
-- who caused it is not told about their own action. A trade the owner is a party
-- to still reaches the admins, which is the point of routing it through the
-- approver set rather than through the two parties.
CREATE OR REPLACE FUNCTION public.notify_trade_approvers(
  p_league_id UUID,
  p_season_id UUID,
  p_actor_user_id UUID,
  p_type TEXT,
  p_message TEXT,
  p_trade_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_approver UUID;
BEGIN
  FOREACH v_approver IN ARRAY public.trade_approver_ids(p_league_id, p_season_id)
  LOOP
    IF v_approver IS DISTINCT FROM p_actor_user_id THEN
      PERFORM public.notify_trade_user(
        p_league_id, p_season_id, v_approver, p_actor_user_id, p_type,
        p_message, p_trade_id
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_trade_approvers(UUID, UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC;

-- ------------------------------------------------------------------ internals

-- A team's token budget, its ledger spend, and what is left.
--
-- Spend is the sum of `transactions.cost_delta` for the team rather than the sum
-- of its roster tiers, which is how pickup_roster_pokemon and the team page both
-- account for it: added rows carry the tier plus any enabled transaction fee and
-- a release refunds the tier, so the ledger is the authority on what a team owes.
CREATE OR REPLACE FUNCTION public.team_salary_totals(p_team_id UUID)
RETURNS TABLE (budget INTEGER, spent INTEGER, remaining INTEGER)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team RECORD;
  v_per_team BOOLEAN;
  v_budget INTEGER;
  v_spent INTEGER;
BEGIN
  SELECT
    t.id, t.season_id, t.total_salary_override,
    COALESCE(ls.enable_pokemon_costs, FALSE),
    COALESCE(ls.allow_per_team_salary, FALSE),
    ls.total_token_salary
  INTO v_team
  FROM public.teams t
  LEFT JOIN public.league_settings ls ON ls.season_id = t.season_id
  WHERE t.id = p_team_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That team does not exist.';
  END IF;

  v_per_team := v_team.allow_per_team_salary;
  v_budget := CASE
    WHEN v_per_team AND v_team.total_salary_override IS NOT NULL
      THEN v_team.total_salary_override
    ELSE v_team.total_token_salary
  END;

  SELECT COALESCE(SUM(tr.cost_delta), 0) INTO v_spent
  FROM public.transactions tr
  WHERE tr.team_id = p_team_id;

  -- Costs disabled means the app treats the salary as unlimited rather than zero,
  -- so the caller has to be able to tell that apart from being broke. A null budget
  -- and a null remaining are that signal; the spend is irrelevant when nothing is
  -- charged for it, so it reads as zero rather than as a real ledger sum.
  IF NOT v_team.enable_pokemon_costs THEN
    RETURN QUERY SELECT NULL::INTEGER, 0, NULL::INTEGER;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    COALESCE(v_budget, 0),
    v_spent,
    COALESCE(v_budget, 0) - v_spent;
END;
$$;

REVOKE ALL ON FUNCTION public.team_salary_totals(UUID) FROM PUBLIC;

-- Settles a trade by swapping the Pokémon between the two rosters.
--
-- Deliberately not granted to any role: it is only reachable from
-- respond_to_trade and vote_on_trade below, so the roster swap has exactly one path
-- and cannot be invoked on a trade that has not cleared its gates. It is idempotent:
-- a trade already marked completed returns without touching anything, so a retried
-- approval cannot double-write the ledger.
--
-- Everything is validated before anything is written, including the two integrity
-- rules a trade can break and a single pick cannot: a Pokémon may exist on only
-- one roster in a season, and no team's balance may land below zero.
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

  SELECT COALESCE(ls.enable_pokemon_costs, FALSE) INTO v_enable_costs
  FROM public.league_settings ls
  WHERE ls.season_id = v_trade.season_id;

  /*
   * What each team's ledger sum will be once the swap lands, built from the same two
   * rows the move loop below writes rather than from a re-derivation of them. A
   * positive `ledger_delta` adds to `spent`, and `remaining` is budget minus spent,
   * so it has to be subtracted. With costs switched off neither branch produces a
   * row, so the loop is empty and there is nothing to enforce.
   */
  FOR v_sides IN
    SELECT d.team_id, SUM(d.cost_delta) AS ledger_delta
    FROM (
      -- Sent: the holding team is credited back the tier it no longer carries.
      SELECT v_item.team_id AS team_id, -r.tier_value AS cost_delta
      FROM public.trade_items v_item
      JOIN public.team_roster r
        ON r.team_id = v_item.team_id AND r.pokemon_id = v_item.pokemon_id
      WHERE v_item.trade_id = p_trade_id AND v_enable_costs
      UNION ALL
      -- Received: the other team is charged for the tier it has just taken on.
      SELECT
        CASE
          WHEN v_item.side = 'proposer' THEN v_recipient_team_id
          ELSE v_proposer_team_id
        END AS team_id,
        r.tier_value AS cost_delta
      FROM public.trade_items v_item
      JOIN public.team_roster r
        ON r.team_id = v_item.team_id AND r.pokemon_id = v_item.pokemon_id
      WHERE v_item.trade_id = p_trade_id AND v_enable_costs
    ) d
    GROUP BY d.team_id
  LOOP
    -- A null remaining also means costs are off, which is unbounded, not broke.
    SELECT ts.remaining INTO v_remaining
    FROM public.team_salary_totals(ts_team_id => v_sides.team_id) ts;

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

-- No GRANT: complete_trade is reachable only through the two RPCs below, which
-- enforce the state machine before calling it.
REVOKE ALL ON FUNCTION public.complete_trade(UUID, UUID) FROM PUBLIC;

-- ------------------------------------------------------------------- propose

-- Opens a trade proposal.
--
-- @param p_league_id - League the trade belongs to; its current season is used.
-- @param p_recipient_user_id - The member being asked, who must own a team.
-- @param p_offer - JSON array of `{ "pokemon_id": "<slug>" }` the proposer sends.
-- @param p_request - JSON array of `{ "pokemon_id": "<slug>" }` to receive.
-- @returns The id of the new trade, in status 'awaiting_response'.
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

  -- Both sides are read out once so the cross-side check is a single membership
  -- test against an array rather than a correlated scan re-run per Pokémon.
  SELECT
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_offer)), ARRAY[]::TEXT[]),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_request)), ARRAY[]::TEXT[])
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

-- ------------------------------------------------------------------- respond

-- Answers an incoming proposal. Only the recipient may answer, and only while the
-- trade is awaiting a response.
--
-- Accepting does not always mean the trade happens: when the owner has switched
-- trade approval on it moves to 'pending_approval' for a vote, and only a league
-- with approval switched off goes straight through to the roster swap. The same
-- function decides which, so the setting cannot be bypassed by answering here
-- rather than in the database.
--
-- @param p_trade_id - The trade being answered.
-- @param p_accept - True to accept, false to decline.
-- @returns The trade's status after responding.
CREATE OR REPLACE FUNCTION public.respond_to_trade(p_trade_id UUID, p_accept BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_trade RECORD;
  v_needs_approval BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to answer a trade.';
  END IF;

  SELECT * INTO v_trade FROM public.trades t WHERE t.id = p_trade_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That trade does not exist.';
  END IF;

  IF v_trade.recipient_user_id <> v_user_id THEN
    RAISE EXCEPTION 'Only the member the trade was sent to can answer it.';
  END IF;

  IF v_trade.status <> 'awaiting_response' THEN
    RAISE EXCEPTION 'This trade has already been answered.';
  END IF;

  IF NOT p_accept THEN
    UPDATE public.trades SET status = 'cancelled' WHERE id = p_trade_id;

    PERFORM public.notify_trade_user(
      v_trade.league_id, v_trade.season_id, v_trade.proposer_user_id, v_user_id,
      'trade_declined', 'Your trade proposal was declined.', p_trade_id
    );

    RETURN 'cancelled';
  END IF;

  SELECT COALESCE(ls.admins_approve_trades, FALSE) INTO v_needs_approval
  FROM public.league_settings ls
  WHERE ls.season_id = v_trade.season_id;

  PERFORM public.notify_trade_user(
    v_trade.league_id, v_trade.season_id, v_trade.proposer_user_id, v_user_id,
    'trade_accepted', 'Your trade proposal was accepted.', p_trade_id
  );

  IF v_needs_approval THEN
    UPDATE public.trades SET status = 'pending_approval' WHERE id = p_trade_id;

    PERFORM public.notify_trade_approvers(
      v_trade.league_id, v_trade.season_id, v_user_id, 'trade_pending_approval',
      'A trade is waiting on your approval.', p_trade_id
    );

    RETURN 'pending_approval';
  END IF;

  UPDATE public.trades SET status = 'approved' WHERE id = p_trade_id;

  RETURN public.complete_trade(p_trade_id, v_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.respond_to_trade(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_to_trade(UUID, BOOLEAN) TO authenticated;

-- Settles a trade as rejected and tells both parties.
--
-- Split out of vote_on_trade because there are two ways to reach the outcome -- the
-- owner overriding with a rejection, and an approver turning it down -- and both
-- have to notify the same two people with the same wording. A rejection is
-- terminal: nothing in the schema moves a trade back out of it, which is what makes
-- a refused trade a decision rather than something still in progress.
CREATE OR REPLACE FUNCTION public.reject_trade(p_trade_id UUID, p_actor_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade RECORD;
BEGIN
  SELECT * INTO v_trade FROM public.trades t WHERE t.id = p_trade_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That trade does not exist.';
  END IF;

  UPDATE public.trades SET status = 'rejected' WHERE id = p_trade_id;

  PERFORM public.notify_trade_user(
    v_trade.league_id, v_trade.season_id, v_trade.proposer_user_id, p_actor_user_id,
    'trade_rejected', 'Trade Rejected', p_trade_id
  );
  PERFORM public.notify_trade_user(
    v_trade.league_id, v_trade.season_id, v_trade.recipient_user_id, p_actor_user_id,
    'trade_rejected', 'Trade Rejected', p_trade_id
  );

  RETURN 'rejected';
END;
$$;

-- No GRANT: reachable only through vote_on_trade.
REVOKE ALL ON FUNCTION public.reject_trade(UUID, UUID) FROM PUBLIC;

-- ---------------------------------------------------------------------- vote

-- Records an Owner or Admin decision on a pending trade and applies the result.
--
-- The quorum is the spec's rule exactly: approval is valid when the approvals are
-- more than half the Owner plus (where enabled) Admin voting members. The count is
-- taken from recorded rows, never from a status flag, so the same input always
-- produces the same outcome. A rejection by any approver settles the trade as
-- rejected, which is terminal -- the owner can settle a trade they disagree with
-- before anyone votes, but cannot resurrect one an approver has already turned
-- down, because a refused trade is a decision rather than a shortfall.
--
-- @param p_trade_id - The trade being decided.
-- @param p_approve - True to approve, false to reject.
-- @param p_override - Owner only; settles the trade without waiting for the quorum.
-- @returns The trade's status after the vote.
CREATE OR REPLACE FUNCTION public.vote_on_trade(
  p_trade_id UUID,
  p_approve BOOLEAN,
  p_override BOOLEAN DEFAULT FALSE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_trade RECORD;
  v_is_owner BOOLEAN;
  v_approver_count INTEGER;
  v_required INTEGER;
  v_approvals INTEGER;
  v_rejections INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to vote on a trade.';
  END IF;

  SELECT * INTO v_trade FROM public.trades t WHERE t.id = p_trade_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That trade does not exist.';
  END IF;

  IF v_trade.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'This trade is not waiting for approval.';
  END IF;

  v_is_owner := public.is_league_owner(v_trade.league_id);

  IF NOT v_is_owner AND NOT EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = v_trade.league_id
      AND lm.user_id = v_user_id
      AND lm.is_active = TRUE
      AND lm.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only the owner and admins can decide a trade.';
  END IF;

  IF p_override AND NOT v_is_owner THEN
    RAISE EXCEPTION 'Only the owner can override an approval.';
  END IF;

  -- The override still gets recorded, so the history shows who settled the trade
  -- and that the quorum was skipped rather than reached.
  INSERT INTO public.trade_votes (trade_id, voter_user_id, decision, is_override)
  VALUES (p_trade_id, v_user_id, CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, COALESCE(p_override, FALSE))
  ON CONFLICT (trade_id, voter_user_id) DO UPDATE
    SET decision = EXCLUDED.decision,
        is_override = EXCLUDED.is_override,
        created_at = NOW();

  IF p_override THEN
    IF p_approve THEN
      RETURN public.complete_trade(p_trade_id, v_user_id);
    END IF;

    RETURN public.reject_trade(p_trade_id, v_user_id);
  END IF;

  -- Only approvers are counted, so a vote from someone who has since lost the role
  -- cannot carry a trade on its own.
  v_approver_count := COALESCE(
    (SELECT COUNT(*)::INTEGER
     FROM public.trade_approver_ids(v_trade.league_id, v_trade.season_id) AS a),
    0
  );
  v_required := (v_approver_count / 2) + 1;

  SELECT
    COUNT(*) FILTER (WHERE v.decision = 'approved'),
    COUNT(*) FILTER (WHERE v.decision = 'rejected')
  INTO v_approvals, v_rejections
  FROM public.trade_votes v
  WHERE v.trade_id = p_trade_id
    AND v.voter_user_id = ANY (
      public.trade_approver_ids(v_trade.league_id, v_trade.season_id)
    );

  IF v_rejections > 0 THEN
    RETURN public.reject_trade(p_trade_id, v_user_id);
  END IF;

  IF v_approvals >= v_required THEN
    RETURN public.complete_trade(p_trade_id, v_user_id);
  END IF;

  RETURN 'pending_approval';
END;
$$;

REVOKE ALL ON FUNCTION public.vote_on_trade(UUID, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vote_on_trade(UUID, BOOLEAN, BOOLEAN) TO authenticated;

-- -------------------------------------------------------------------- cancel

-- Withdraws your own proposal while it is still awaiting an answer.
--
-- @param p_trade_id - The trade to withdraw.
CREATE OR REPLACE FUNCTION public.cancel_trade(p_trade_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_trade RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to withdraw a trade.';
  END IF;

  SELECT * INTO v_trade FROM public.trades t WHERE t.id = p_trade_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That trade does not exist.';
  END IF;

  IF v_trade.proposer_user_id <> v_user_id THEN
    RAISE EXCEPTION 'Only the member who proposed a trade can withdraw it.';
  END IF;

  IF v_trade.status <> 'awaiting_response' THEN
    RAISE EXCEPTION 'This trade has already been answered.';
  END IF;

  UPDATE public.trades SET status = 'cancelled' WHERE id = p_trade_id;

  -- The proposer cannot answer their own proposal, so withdrawing is the one event
  -- the recipient would otherwise never hear about.
  PERFORM public.notify_trade_user(
    v_trade.league_id, v_trade.season_id, v_trade.recipient_user_id, v_user_id,
    'trade_withdrawn', 'A trade proposal was withdrawn.', p_trade_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_trade(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_trade(UUID) TO authenticated;

-- ------------------------------------------------------------------- dismiss

-- Clears a completed, declined, or rejected trade off your own list.
--
-- Records a row in `trade_dismissals` for the caller alone. The trade is untouched:
-- it stays in league history and stays on the other party's list, which is the whole
-- reason a dismissal is a row rather than a column. The spec's "Clear" control on a
-- rejected card tidies one member's view, it does not delete a record.
--
-- @param p_trade_id - The trade to clear.
CREATE OR REPLACE FUNCTION public.dismiss_trade(p_trade_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to clear a trade.';
  END IF;

  SELECT t.status INTO v_status
  FROM public.trades t
  WHERE t.id = p_trade_id
    AND (t.proposer_user_id = v_user_id OR t.recipient_user_id = v_user_id);

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Only the two members in a trade can clear it.';
  END IF;

  IF v_status NOT IN ('completed', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION 'This trade is still in play, so there is nothing to clear.';
  END IF;

  -- Re-clearing a card the member already cleared is a no-op rather than an error,
  -- so a double-clicked button cannot surface a failure.
  INSERT INTO public.trade_dismissals (trade_id, user_id)
  VALUES (p_trade_id, v_user_id)
  ON CONFLICT (trade_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_trade(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dismiss_trade(UUID) TO authenticated;

-- ------------------------------------------------------------------ realtime

-- A trade is the one table after the draft that a member can see changing under
-- them: the whole page is a two-person negotiation, so a proposal that arrives
-- while it is open is exactly the staleness the Trades page exists to avoid. This
-- is the deliberate exception to the "publish only three tables" rule in
-- 20261029_realtime_publication.sql, whose reasoning was that everything else
-- changes once at the draft or never. A trade changes on every proposal, answer,
-- and vote. Events are still only a staleness signal: the page refetches through
-- the same scoped loader it runs on mount.
ALTER TABLE public.trades REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname || '.' || tablename = 'public.trades'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;
  END IF;
END;
$$;

-- Force PostgREST to pick up the new schema objects immediately.
NOTIFY pgrst, 'reload schema';
