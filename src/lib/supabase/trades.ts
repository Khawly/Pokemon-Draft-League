/*
 * Trades page data layer for the Pokemon Draft League.
 *
 * Implements spec section 12. Loads the league, current season, the season's trade
 * configuration, every team with its roster and token balance, and the trades the
 * signed-in member is allowed to see. RLS decides that audience rather than a query
 * filter: a member reads the trades they are party to at any stage, plus every
 * completed trade in the league once the rosters have actually changed.
 *
 * All writes go through the SECURITY DEFINER RPCs added in
 * supabase/migrations/20261103_trade_workflow.sql, so this module never writes to
 * `trades` or `trade_items` directly. The approval arithmetic is exposed as pure
 * functions because it is the part with a rule in it: the same votes must always
 * produce the same outcome, and the page has to be able to say how far a pending
 * approval has got without re-deriving it.
 */
import { supabase } from "@/lib/supabase/client";
import { loadLatestSeason } from "@/lib/supabase/seasons";
import { getPokemonEntryBySlug } from "@/lib/pokeapi";

/**
 * Every state a trade can be in, mirroring `trades_status_check`.
 *
 * `accepted` is part of the schema's vocabulary but unused: an accepted trade moves
 * straight to `pending_approval` or on to `approved`, and leaving it out of the
 * union means no caller can render a state that nothing produces.
 */
export type TradeStatus =
  | "awaiting_response"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "cancelled";

/** Which member of the trade an item is travelling from. */
export type TradeSide = "proposer" | "recipient";

/** Lifecycle status of a season (subset used by the trades page). */
export type TradeSeasonStatus =
  | "draft_pending"
  | "draft_active"
  | "draft_complete"
  | "archived";

/** Season row for the trades page. */
export type TradeSeason = {
  id: string;
  season_number: number;
  status: TradeSeasonStatus;
  name: string | null;
};

/** Per-season cost and trade-approval configuration read from league_settings. */
export type TradeSettings = {
  enable_pokemon_costs: boolean;
  total_token_salary: number | null;
  allow_per_team_salary: boolean;
  /**
   * The league's "Owner has to Approve Trades" switch. When it is off an accepted
   * trade completes on the spot and there is nothing for staff to vote on.
   */
  admins_approve_trades: boolean;
  /**
   * The league's "Owners/Admins vote on Approving Trades" switch. When it is off the
   * owner is the only approver; when it is on the admins join the voting pool.
   */
  owners_admins_vote_on_trades: boolean;
  /**
   * The league's "Allow Tokens to Be Traded" switch. Only meaningful when
   * `enable_pokemon_costs` is on; without a token economy there is nothing for a
   * token amount to be measured against.
   */
  allow_token_trades: boolean;
};

/** A team slot in the season with its owner's resolved display info. */
export type TradeTeam = {
  id: string;
  owner_user_id: string;
  /**
   * The draft-time snapshot of the owner's name. Never used to label the person:
   * a rename leaves the old name in here forever, so `owner_name` is the authority.
   */
  team_name: string;
  /** The owner's live display name, which is how the member is addressed. */
  owner_name: string | null;
  owner_avatar_url: string | null;
  draft_position: number | null;
  total_salary_override: number | null;
  /** The team's roster, enriched from the bundled catalog for display. */
  roster: TradePokemon[];
};

/** A roster Pokémon as the trade picker sees it. */
export type TradePokemon = {
  pokemon_id: string;
  species_name: string;
  /** Display name from the catalog (falls back to species_name). */
  name: string;
  tier_value: number;
  /** Typing as PokeAPI type names. */
  types: string[];
  /** Sprite id used to render the local sprite. */
  spriteId: number;
  bst: number | null;
};

/** One Pokémon being offered by one side of a trade. */
export type TradeItem = TradePokemon & {
  /** Which side of the trade this Pokémon is travelling from. */
  side: TradeSide;
};

/** One recorded approval decision on a trade. */
export type TradeVote = {
  voter_user_id: string;
  /** The voter's display name, so a card can show who decided without a second read. */
  voter_name: string | null;
  decision: "approved" | "rejected";
  /** True when the owner settled the trade without waiting for the quorum. */
  is_override: boolean;
  created_at: string;
};

/** A trade with both sides' items and any recorded approval decisions. */
export type Trade = {
  id: string;
  status: TradeStatus;
  proposer_user_id: string;
  recipient_user_id: string;
  proposer_name: string;
  recipient_name: string;
  created_at: string;
  updated_at: string;
  /** When the roster swap landed. Null until the trade completes. */
  completed_at: string | null;
  /**
   * Tokens the proposer is sending. This comes out of the proposer's budget and
   * goes onto the recipient's, the opposite of how sending a Pokémon behaves.
   */
  proposerTokenAmount: number;
  /** Tokens the recipient is sending, counted the same way. */
  recipientTokenAmount: number;
  items: TradeItem[];
  votes: TradeVote[];
};

/** Complete trades page payload for a league. */
export type TradesGoods = {
  league: {
    id: string;
    name: string;
    owner_id: string;
  };
  season: TradeSeason | null;
  settings: TradeSettings | null;
  teams: TradeTeam[];
  /** The signed-in user's team in the current season, or null. */
  myTeam: TradeTeam | null;
  /** Trades the member may read, newest first. */
  trades: Trade[];
  /**
   * Trades the member has cleared off their own list. Kept beside the trades rather
   * than folded into them as a flag, because "cleared" is per member: the other
   * party still sees the same card.
   */
  dismissedTradeIds: Set<string>;
  /** Token ledger sums keyed by team id (tiers + sunk transaction fees). */
  spentByTeam: Map<string, number>;
  /**
   * The Owner plus, where the league enables it, the Admins who vote on trades in
   * this season. Drives the quorum the page shows.
   */
  approverIds: string[];
  currentUserId: string;
  userRole: "owner" | "admin" | "member" | null;
  /** True when the member can vote on a pending approval. */
  canApprove: boolean;
};

/** A team's token budget, spend, and what is left of it. */
export type TeamSalary = {
  budget: number;
  spent: number;
  remaining: number;
};

/**
 * Both sides' balances as a trade would leave them.
 *
 * The tier value is a cost the league charged for the Pokémon and it travels with
 * the Pokémon, so what a side's balance becomes is its current balance plus what it
 * receives minus what it gives. This is the same arithmetic `complete_trade` runs
 * before it writes anything, so the figure the proposer approves is the figure the
 * database will hold.
 */
export type TradeProjection = {
  /** Tokens remaining for the proposing team once the trade settles. */
  proposerRemaining: number;
  /** Tokens remaining for the receiving team once the trade settles. */
  recipientRemaining: number;
  /**
   * Change in the proposer's remaining balance. Positive frees tokens, so a member
   * giving up a tier 8 for a tier 2 reads as +6 rather than -6.
   */
  proposerDelta: number;
  /** Change in the recipient's remaining balance; the mirror of the proposer's. */
  recipientDelta: number;
  /** True when neither side would be left below zero. */
  affordable: boolean;
};

/** One member's recorded decision on a trade. */
export type ApprovalProgress = {
  /** Approvals recorded so far, counting only current approvers. */
  approvals: number;
  /** Approvals needed for the quorum. */
  required: number;
  /** Rejections recorded, counting only current approvers. */
  rejections: number;
  /** True once the approvals have reached the quorum. */
  quorumMet: boolean;
  /** True when the Owner settled it without waiting for the quorum. */
  overridden: boolean;
};

type TradeRow = {
  id: string;
  status: TradeStatus;
  proposer_user_id: string;
  recipient_user_id: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  proposer_token_amount: number | null;
  recipient_token_amount: number | null;
  proposer?: { display_name?: string | null } | null;
  recipient?: { display_name?: string | null } | null;
};

type TradeItemRow = {
  trade_id: string;
  side: TradeSide;
  pokemon_id: string;
};

type TradeVoteRow = {
  trade_id: string;
  voter_user_id: string;
  decision: "approved" | "rejected";
  is_override: boolean;
  created_at: string;
  profiles?: { display_name?: string | null } | null;
};

type RosterRow = {
  team_id: string;
  pokemon_id: string;
  species_name: string;
  tier_value: number;
};

/**
 * Enriches a roster row with the bundled catalog's display data.
 *
 * The catalog is the same source the team and Pokémon pages read, so a Pokémon
 * offered in a trade is named and sprited identically wherever it appears.
 *
 * @param row - A raw `team_roster` row.
 * @returns The roster Pokémon with display name, typing, and sprite id.
 */
function toTradePokemon(row: RosterRow): TradePokemon {
  const entry = getPokemonEntryBySlug(row.pokemon_id);

  return {
    pokemon_id: row.pokemon_id,
    species_name: row.species_name,
    name: entry?.name ?? row.species_name,
    tier_value: row.tier_value,
    types: entry?.types ?? [],
    spriteId: entry?.spriteId ?? 0,
    bst: entry?.bst ?? null,
  };
}

/**
 * Loads the complete trades page state for a league for the signed-in user.
 *
 * Guards on authentication, loads the league and current season, and when a season
 * exists resolves the season's trade configuration, every team with its roster and
 * ledger balance, the member's own team, the trades RLS lets them read, and the set
 * of members who vote on approvals.
 *
 * @param leagueId - The id of the league whose trades to load.
 * @returns A Promise resolving to the assembled {@link TradesGoods}.
 * @throws If the user is not signed in, the league is missing, or a core query
 *   fails.
 */
export async function loadTradesPageData(leagueId: string): Promise<TradesGoods> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to view trades.");
  }

  const { data: league, error: leagueError } = await supabase
    .from("leagues")
    .select("id, name, owner_id")
    .eq("id", leagueId)
    .maybeSingle();

  if (leagueError || !league) {
    throw new Error("This league could not be loaded.");
  }

  const { data: seasonRow, error: seasonError } = await loadLatestSeason<TradeSeason>(
    leagueId,
    "id, season_number, status, name",
  );

  if (seasonError) {
    throw new Error("This league's season could not be loaded.");
  }

  const season = (seasonRow as TradeSeason | null) ?? null;

  const base: TradesGoods = {
    league: {
      id: league.id,
      name: league.name,
      owner_id: league.owner_id,
    },
    season,
    settings: null,
    teams: [],
    myTeam: null,
    trades: [],
    dismissedTradeIds: new Set<string>(),
    spentByTeam: new Map<string, number>(),
    approverIds: [],
    currentUserId: user.id,
    userRole: null,
    canApprove: false,
  };

  if (!season) {
    return base;
  }

  const [settingsResult, teamResult, memberResult] = await Promise.all([
    supabase
      .from("league_settings")
      .select(
        "enable_pokemon_costs, total_token_salary, allow_per_team_salary, admins_approve_trades, owners_admins_vote_on_trades, allow_token_trades",
      )
      .eq("season_id", season.id)
      .maybeSingle(),
    supabase
      .from("teams")
      .select(
        "id, owner_user_id, team_name, draft_position, total_salary_override, profiles: owner_user_id (display_name, avatar_url)",
      )
      .eq("league_id", leagueId)
      .eq("season_id", season.id)
      .order("draft_position", { ascending: true, nullsFirst: false }),
    supabase
      .from("league_members")
      .select("user_id, role")
      .eq("league_id", leagueId)
      .eq("is_active", true),
  ]);

  if (settingsResult.error || teamResult.error || memberResult.error) {
    throw new Error("The trade centre could not be loaded.");
  }

  const settingsRow = settingsResult.data as {
    enable_pokemon_costs: boolean;
    total_token_salary: number | null;
    allow_per_team_salary: boolean;
    admins_approve_trades: boolean;
    owners_admins_vote_on_trades: boolean;
    allow_token_trades: boolean;
  } | null;

  const settings: TradeSettings | null = settingsRow
    ? {
        enable_pokemon_costs: settingsRow.enable_pokemon_costs,
        total_token_salary: settingsRow.total_token_salary,
        allow_per_team_salary: settingsRow.allow_per_team_salary,
        admins_approve_trades: settingsRow.admins_approve_trades,
        owners_admins_vote_on_trades: settingsRow.owners_admins_vote_on_trades,
        allow_token_trades: settingsRow.allow_token_trades,
      }
    : null;

  const members = ((memberResult.data ?? []) as {
    user_id: string;
    role: "owner" | "admin" | "member";
  }[]) ?? [];

  const userRole =
    members.find((member) => member.user_id === user.id)?.role ?? null;

  const teamIds = ((teamResult.data ?? []) as { id: string }[]).map(
    (row) => row.id,
  );

  // Rosters and the token ledger, read once for the season so the proposal builder
  // can price both sides of a trade without a round trip per Pokémon.
  const rosterByTeam = new Map<string, TradePokemon[]>();
  const spentByTeam = new Map<string, number>();

  if (teamIds.length > 0) {
    const [rosterResult, ledgerResult] = await Promise.all([
      supabase
        .from("team_roster")
        .select("team_id, pokemon_id, species_name, tier_value")
        .in("team_id", teamIds)
        .order("acquired_at", { ascending: true }),
      supabase
        .from("transactions")
        .select("team_id, cost_delta")
        .in("team_id", teamIds),
    ]);

    if (rosterResult.error) {
      throw new Error("Team rosters could not be loaded.");
    }

    if (ledgerResult.error) {
      throw new Error("Team token balances could not be loaded.");
    }

    for (const row of (rosterResult.data ?? []) as RosterRow[]) {
      const current = rosterByTeam.get(row.team_id) ?? [];
      current.push(toTradePokemon(row));
      rosterByTeam.set(row.team_id, current);
    }

    for (const row of (ledgerResult.data ?? []) as {
      team_id: string;
      cost_delta: number;
    }[]) {
      spentByTeam.set(
        row.team_id,
        (spentByTeam.get(row.team_id) ?? 0) + row.cost_delta,
      );
    }
  }

  const teams: TradeTeam[] = (
    (teamResult.data ?? []) as {
      id: string;
      owner_user_id: string;
      team_name: string;
      draft_position: number | null;
      total_salary_override: number | null;
      profiles?: { display_name?: string | null; avatar_url?: string | null } | null;
    }[]
  ).map((row) => ({
    id: row.id,
    owner_user_id: row.owner_user_id,
    team_name: row.team_name,
    owner_name: row.profiles?.display_name ?? null,
    owner_avatar_url: row.profiles?.avatar_url ?? null,
    draft_position: row.draft_position,
    total_salary_override: row.total_salary_override,
    roster: rosterByTeam.get(row.id) ?? [],
  }));

  const myTeam = teams.find((team) => team.owner_user_id === user.id) ?? null;

  /*
   * How every member is addressed. Built from the team rows rather than read off
   * each trade, because a rename has to reach every past card at once and the
   * `team_name` snapshot never does. `teams.team_name` is only the last resort, for
   * a member whose profile has no display name set at all.
   */
  const nameByUserId = new Map<string, string>();
  for (const team of teams) {
    nameByUserId.set(
      team.owner_user_id,
      team.owner_name?.trim() || team.team_name || "Unknown member",
    );
  }

  const resolveName = (
    userId: string,
    embedded: string | null | undefined,
  ): string => {
    const fromTeam = nameByUserId.get(userId);
    if (fromTeam) {
      return fromTeam;
    }
    return embedded?.trim() || "Unknown member";
  };

  /*
   * No `.or(...)` filter here on purpose. RLS is the authority on who may read a
   * trade: the two parties at every stage, and any active member once it has
   * completed. Re-deriving that as a PostgREST `or` would be a second copy of the
   * rule that could disagree with the policy and, worse, would make a completed
   * league-wide trade invisible to anyone whose id is not named on it.
   */
  const { data: tradeRows, error: tradeError } = await supabase
    .from("trades")
    .select(
      "id, status, proposer_user_id, recipient_user_id, created_at, updated_at, completed_at, proposer_token_amount, recipient_token_amount, proposer: proposer_user_id (display_name), recipient: recipient_user_id (display_name)",
    )
    .eq("league_id", leagueId)
    .eq("season_id", season.id)
    .order("created_at", { ascending: false });

  if (tradeError) {
    throw new Error("Trades could not be loaded.");
  }

  const tradeRecords = (tradeRows ?? []) as TradeRow[];
  const tradeIds = tradeRecords.map((row) => row.id);

  // Which of these the member has cleared for themselves. Scoped to their own rows
  // by the table's RLS policy, so this read can never report another member's view.
  const { data: dismissalRows, error: dismissalError } = await supabase
    .from("trade_dismissals")
    .select("trade_id");

  if (dismissalError) {
    throw new Error("Your cleared trades could not be loaded.");
  }

  const dismissedTradeIds = new Set(
    ((dismissalRows ?? []) as { trade_id: string }[]).map((row) => row.trade_id),
  );

  const itemsByTrade = new Map<string, TradeItem[]>();
  const votesByTrade = new Map<string, TradeVote[]>();

  if (tradeIds.length > 0) {
    const [itemResult, voteResult] = await Promise.all([
      supabase
        .from("trade_items")
        .select("trade_id, side, pokemon_id")
        .in("trade_id", tradeIds),
      supabase
        .from("trade_votes")
        .select(
          "trade_id, voter_user_id, decision, is_override, created_at, profiles: voter_user_id (display_name)",
        )
        .in("trade_id", tradeIds)
        .order("created_at", { ascending: true }),
    ]);

    if (itemResult.error) {
      throw new Error("The Pokémon in these trades could not be loaded.");
    }

    if (voteResult.error) {
      throw new Error("Trade approvals could not be loaded.");
    }

    /*
     * A trade item stores only the slug and the team it came from, so the tier and
     * species are resolved against the roster as it stands. That is the same value
     * the completion will move, which is what lets a card show what a Pokémon is
     * worth without a second table read.
     */
    const rosterByPokemon = new Map<string, TradePokemon>();
    for (const team of teams) {
      for (const pokemon of team.roster) {
        rosterByPokemon.set(pokemon.pokemon_id, pokemon);
      }
    }

    for (const row of (itemResult.data ?? []) as TradeItemRow[]) {
      const pokemon = rosterByPokemon.get(row.pokemon_id);
      const current = itemsByTrade.get(row.trade_id) ?? [];

      current.push({
        pokemon_id: row.pokemon_id,
        species_name: pokemon?.species_name ?? row.pokemon_id,
        name: pokemon?.name ?? row.pokemon_id,
        // A Pokémon already moved by an earlier trade in the same read is priced at
        // 0 rather than guessed, so the card says nothing it cannot support.
        tier_value: pokemon?.tier_value ?? 0,
        types: pokemon?.types ?? [],
        spriteId: pokemon?.spriteId ?? 0,
        bst: pokemon?.bst ?? null,
        side: row.side,
      });
      itemsByTrade.set(row.trade_id, current);
    }

    for (const row of (voteResult.data ?? []) as TradeVoteRow[]) {
      const current = votesByTrade.get(row.trade_id) ?? [];
      current.push({
        voter_user_id: row.voter_user_id,
        voter_name: row.profiles?.display_name ?? null,
        decision: row.decision,
        is_override: row.is_override,
        created_at: row.created_at,
      });
      votesByTrade.set(row.trade_id, current);
    }
  }

  const trades: Trade[] = tradeRecords.map((row) => ({
    id: row.id,
    status: row.status,
    proposer_user_id: row.proposer_user_id,
    recipient_user_id: row.recipient_user_id,
    // The parties' live display names, with the team rows preferred so a rename
    // propagates to every card in one read.
    proposer_name: resolveName(row.proposer_user_id, row.proposer?.display_name),
    recipient_name: resolveName(
      row.recipient_user_id,
      row.recipient?.display_name,
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    proposerTokenAmount: row.proposer_token_amount ?? 0,
    recipientTokenAmount: row.recipient_token_amount ?? 0,
    items: (itemsByTrade.get(row.id) ?? []).sort((a, b) =>
      a.side === b.side ? a.name.localeCompare(b.name) : a.side === "proposer" ? -1 : 1,
    ),
    votes: votesByTrade.get(row.id) ?? [],
  }));

  let approverIds: string[] = [];
  if (settings?.admins_approve_trades) {
    const { data: approverRows, error: approverError } = await supabase.rpc(
      "trade_approver_ids",
      { p_league_id: leagueId, p_season_id: season.id },
    );

    if (approverError) {
      throw new Error("Trade approvers could not be loaded.");
    }

    approverIds = (approverRows ?? []) as string[];
  }

  return {
    ...base,
    settings,
    teams,
    myTeam,
    trades,
    dismissedTradeIds,
    spentByTeam,
    approverIds,
    userRole,
    canApprove:
      settings?.admins_approve_trades === true &&
      (userRole === "owner" || userRole === "admin"),
  };
}

/**
 * Finds the team a member owns, addressed by the member's user id.
 *
 * Trades are addressed by *user* id, not by team id: `propose_trade` takes a
 * `p_recipient_user_id`, and both sides of the page carry user ids around. Team ids
 * and user ids are both UUIDs, so nothing about a value stops it from being compared
 * against the wrong column -- which is exactly how the recipient's roster ended up
 * rendering empty, because the selection was matched against `id` instead of
 * `owner_user_id` and quietly found nothing. Every lookup of this kind goes through
 * here so there is one place that knows which id the page is holding.
 *
 * @param teams - The season's teams.
 * @param ownerUserId - The member's user id.
 * @returns That member's team, or null when they own none in this season.
 */
export function findTeamByOwner(
  teams: TradeTeam[],
  ownerUserId: string,
): TradeTeam | null {
  if (!ownerUserId) {
    return null;
  }

  return teams.find((team) => team.owner_user_id === ownerUserId) ?? null;
}

/**
 * The members a signed-in user can propose a trade with.
 *
 * The user themself is excluded, since `propose_trade` refuses a trade with oneself
 * and offering it in the picker would only produce a rejection.
 *
 * @param teams - The season's teams.
 * @param currentUserId - The signed-in user's id.
 * @returns Every other member's team.
 */
export function tradeOpponents(
  teams: TradeTeam[],
  currentUserId: string,
): TradeTeam[] {
  return teams.filter((team) => team.owner_user_id !== currentUserId);
}

/**
 * How each side's token balance moves if a trade settles.
 *
 * Positive means the balance goes up. The two are always mirrors of one another,
 * because a trade conserves the total tier value in the league: whatever one side
 * gains, the other gives up.
 */
export type TradeValueShift = {
  /** Tokens gained (positive) or lost (negative) by the proposer. */
  proposerDelta: number;
  /** Tokens gained (positive) or lost (negative) by the recipient. */
  recipientDelta: number;
};

/**
 * Computes how a trade moves each side's token balance.
 *
 * The tier value is a cost the league charged for the Pokémon and it travels with
 * the Pokémon, so a side's balance rises by the value it gives up and falls by the
 * value it takes on. `complete_trade` writes the mirror of this into the ledger, so
 * the figure shown on a card is the figure the database ends up holding.
 *
 * This is the single implementation of that arithmetic. {@link projectTradeBalance}
 * builds on it for the proposal form, and the trade cards use it for a trade that
 * already exists; keeping one copy is what stops the two from disagreeing about
 * which side gains, which is the easy mistake to make with a mirrored pair.
 *
 * @param outgoing - Pokémon leaving the proposer's roster.
 * @param incoming - Pokémon leaving the recipient's roster.
 * @param costsEnabled - Whether the league charges for Pokémon at all. With costs
 *   off no tier was ever charged, so nothing moves.
 * @param proposerTokens - Tokens the proposer is sending.
 * @param recipientTokens - Tokens the recipient is sending.
 * @returns Both sides' balance changes.
 */
export function tradeValueShift(
  outgoing: TradePokemon[],
  incoming: TradePokemon[],
  costsEnabled: boolean,
  proposerTokens = 0,
  recipientTokens = 0,
): TradeValueShift {
  const sumTiers = (rows: TradePokemon[]): number =>
    costsEnabled ? rows.reduce((sum, row) => sum + row.tier_value, 0) : 0;

  /*
   * Tokens run the opposite way to Pokémon, which is the whole reason this is not
   * just another term in the tier sum.
   *
   * Handing over a Pokémon frees budget, because the tier it was bought for is no
   * longer carried and `complete_trade` writes a negative `cost_delta` for it.
   * Handing over tokens costs budget: the tokens are the currency, so giving them
   * away is exactly what the other side spends them on, and `complete_trade`
   * writes a positive `cost_delta` against the sender. Reading a token transfer as
   * a refund made the projection promise the sender a larger balance than the
   * database would hold, and flagged the wrong side as the one going broke.
   *
   * Both are gated on costs being on, matching `complete_trade`: with costs off
   * nothing is charged for anything, so a stored amount must not move a balance.
   */
  const given = costsEnabled ? proposerTokens : 0;
  const received = costsEnabled ? recipientTokens : 0;

  const proposerDelta = sumTiers(outgoing) - sumTiers(incoming) - given + received;

  /*
   * Negating zero would produce -0, which is equal to 0 under `===` but not under
   * `Object.is`, and which would surface as a surprise to any caller comparing
   * identities or serialising the result. A trade that hands over equal value moves
   * neither balance, so the mirror is normalised to plain zero.
   */
  return {
    proposerDelta,
    recipientDelta: proposerDelta === 0 ? 0 : -proposerDelta,
  };
}

/**
 * Renders a balance change the way a member reads it, e.g. `+1 Token`, `-2 Tokens`.
 *
 * A plain hyphen rather than a typographic minus, so the string matches what the
 * rest of the app writes into ledger copy, and the unit is pluralised so a single
 * token never reads as "1 Tokens". Zero is stated rather than hidden: a trade that
 * hands over equal value moves neither balance, and saying so is more useful than
 * printing a pair of `+0 Token`s.
 *
 * @param delta - The signed change in tokens.
 * @returns The formatted amount, e.g. `+1 Token`.
 */
export function formatTokenSwing(delta: number): string {
  if (delta === 0) {
    return "0 Tokens";
  }

  const magnitude = Math.abs(delta);
  const unit = magnitude === 1 ? "Token" : "Tokens";

  return `${delta > 0 ? "+" : "-"}${magnitude} ${unit}`;
}

/**
 * Computes a team's current salary budget, spent, and remaining.
 *
 * Mirrors the team and Pokémon pages: the budget is a per-team override when the
 * league allows one, and `spent` is the team's transaction ledger sum, which is how
 * a roster tier and a sunk transaction fee both count against it. A completed trade
 * writes a credit to the sender and a charge to the receiver, so the sum here moves
 * with the roster rather than lagging behind it.
 *
 * @param goods - The loaded trades page state.
 * @param teamId - The team to evaluate.
 * @returns Budget, spent, and remaining salary. Remaining is infinite when the
 *   league has costs switched off, matching every other page.
 */
export function getTeamSalary(goods: TradesGoods, teamId: string): TeamSalary {
  if (!goods.settings?.enable_pokemon_costs) {
    return {
      budget: 0,
      spent: 0,
      remaining: Number.POSITIVE_INFINITY,
    };
  }

  const team = goods.teams.find((candidate) => candidate.id === teamId);
  const usesOverride =
    goods.settings.allow_per_team_salary &&
    team?.total_salary_override != null;
  const budget = usesOverride
    ? (team?.total_salary_override ?? 0)
    : (goods.settings.total_token_salary ?? 0);
  const spent = goods.spentByTeam.get(teamId) ?? 0;

  return { budget, spent, remaining: budget - spent };
}

/**
 * Prices a proposed exchange from both sides.
 *
 * With costs disabled every balance is infinite and nothing is affordable to
 * reject, so the figures come back as-is rather than as a misleading zero. With
 * costs on, each side's balance moves by the tier value it receives minus the tier
 * value it gives, and a side that would land below zero makes the whole trade
 * unaffordable -- the same rule `complete_trade` enforces before it writes.
 *
 * @param goods - The loaded trades page state.
 * @param proposerTeamId - The team sending the Pokémon.
 * @param recipientTeamId - The team receiving them.
 * @param outgoing - Pokémon leaving the proposer's roster.
 * @param incoming - Pokémon leaving the recipient's roster.
 * @param proposerTokens - Tokens the proposer is sending.
 * @param recipientTokens - Tokens the recipient is sending.
 * @returns The two projected balances, the two net deltas, and whether both sides
 *   stay solvent.
 */
export function projectTradeBalance(
  goods: TradesGoods,
  proposerTeamId: string,
  recipientTeamId: string,
  outgoing: TradePokemon[],
  incoming: TradePokemon[],
  proposerTokens = 0,
  recipientTokens = 0,
): TradeProjection {
  const proposerSalary = getTeamSalary(goods, proposerTeamId);
  const recipientSalary = getTeamSalary(goods, recipientTeamId);

  const costed = goods.settings?.enable_pokemon_costs === true;

  /*
   * The tier value travels with the Pokémon, so a side's balance rises by what it
   * gives up and falls by what it takes on. Shared with the trade cards through
   * tradeValueShift so the form and the cards can never quote different figures for
   * the same trade.
   */
  const { proposerDelta, recipientDelta } = tradeValueShift(
    outgoing,
    incoming,
    costed,
    proposerTokens,
    recipientTokens,
  );

  const proposerRemaining = proposerSalary.remaining + proposerDelta;
  const recipientRemaining = recipientSalary.remaining + recipientDelta;

  return {
    proposerRemaining,
    recipientRemaining,
    proposerDelta,
    recipientDelta,
    // An infinite balance is solvent whatever the delta is, so only a finite
    // balance can make a trade unaffordable.
    affordable:
      (proposerRemaining === Number.POSITIVE_INFINITY ||
        proposerRemaining >= 0) &&
      (recipientRemaining === Number.POSITIVE_INFINITY || recipientRemaining >= 0),
  };
}

/**
 * How many approvals a trade needs from a given number of voting members.
 *
 * The spec's rule is "more than half", which for an integer count is half rounded
 * down plus one. Worked through: 1 approver needs 1, 2 need 2 (one is not *more*
 * than half of two), 3 need 2, 4 need 3.
 *
 * @param approverCount - How many members can vote on trades this season.
 * @returns The number of approvals that carries the quorum.
 */
export function requiredApprovals(approverCount: number): number {
  if (approverCount <= 0) {
    return 0;
  }

  return Math.floor(approverCount / 2) + 1;
}

/**
 * Tallies a trade's recorded decisions against the current approver set.
 *
 * Only votes from members who are still approvers count, so a demoted admin's
 * earlier approval cannot carry a trade on its own -- the same filter
 * `vote_on_trade` applies before it decides. Voting again replaces a member's
 * earlier decision rather than adding to it, which is what keeps the tally equal to
 * the number of people who have actually spoken.
 *
 * @param trade - The trade whose votes are being tallied.
 * @param approverIds - The members who currently vote on trades this season.
 * @returns The approval and rejection counts, the quorum, and whether the Owner
 *   overrode it.
 */
export function approvalProgress(
  trade: Trade,
  approverIds: string[],
): ApprovalProgress {
  const approvers = new Set(approverIds);
  const counted = trade.votes.filter((vote) => approvers.has(vote.voter_user_id));

  const approvals = counted.filter((vote) => vote.decision === "approved").length;
  const rejections = counted.filter((vote) => vote.decision === "rejected").length;
  const required = requiredApprovals(approverIds.length);

  return {
    approvals,
    required,
    rejections,
    quorumMet: required > 0 && approvals >= required,
    overridden: trade.votes.some((vote) => vote.is_override),
  };
}

/**
 * Maps a trade status to the label the cards and history show.
 *
 * @param status - The trade's database status.
 * @returns A short human-readable label.
 */
export function tradeStatusLabel(status: TradeStatus): string {
  switch (status) {
    case "awaiting_response":
      return "Awaiting Response";
    case "pending_approval":
      return "Pending Approval";
    case "approved":
      return "Approved";
    case "rejected":
      return "Trade Rejected";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * Reports whether a trade can still change hands.
 *
 * A trade is settled once it is completed, rejected, or cancelled. Open trades are
 * the ones the inbox and the proposal builder have to act on; `approved` is included
 * because it is the brief window in which the database is completing it, and a card
 * that said "not open" for a trade mid-swap would be lying about something the
 * member can see changing.
 *
 * @param status - The trade's database status.
 * @returns True while the trade has not reached a final state.
 */
export function isTradeOpen(status: TradeStatus): boolean {
  return (
    status === "awaiting_response" ||
    status === "pending_approval" ||
    status === "approved"
  );
}

/**
 * Which set of trades a tab's notification count is drawn from.
 *
 * The two tabs that can hold a live trade differ only in whether it has to be the
 * member's own, so they share one implementation rather than each restating what
 * "open" means.
 */
export type TradeBadgeScope =
  /** The member's own trades, as listed on the Trades page's "My Trades" tab. */
  | "my-trades"
  /** Trades awaiting a vote, as listed on the Trades page's "Approvals" tab. */
  | "awaiting-approval";

/**
 * Counts the trades a member should see a live notification about.
 *
 * The rule is "a trade of mine that has not settled", not "a trade I must act on",
 * and the difference is deliberate. Both members of a trade hold it on their own tab
 * while it is in flight, so both see the bubble, and neither is told there is
 * something to do when there is not: a proposal you sent is waiting on the other
 * member to answer it, and a trade already sent for approval is waiting on an
 * approver. Scoping the bubble to only the member's own turn meant the two sides of
 * the same trade rendered differently -- one red, one grey -- which reads as the app
 * behaving differently per account rather than as both being kept informed.
 *
 * The cost is that red is broader than "act now" and a proposer with unanswered
 * proposals sees a bubble they cannot clear except by Withdrawing. That is judged
 * the better trade: an open trade of your own is genuinely live information, and a
 * bubble that appears and vanishes depending on which member is looking at it is
 * harder to reason about than one that means "you have something in flight".
 *
 * @param trades - The trades the member can see.
 * @param scope - Which set to count within.
 * @param userId - The signed-in member.
 * @returns How many trades the count should show.
 */
export function countOpenTrades(
  trades: Trade[],
  scope: TradeBadgeScope,
  userId: string,
): number {
  if (scope === "awaiting-approval") {
    // Every trade awaiting a vote is unresolved. The tab is only reachable for an
    // approver, so there is no need to narrow this further.
    return trades.filter((trade) => trade.status === "pending_approval").length;
  }

  return trades.filter(
    (trade) =>
      (trade.proposer_user_id === userId || trade.recipient_user_id === userId) &&
      isTradeOpen(trade.status),
  ).length;
}

/**
 * Reports whether the signed-in member may cast an approval vote on a trade.
 *
 * Deliberately says nothing about whether the member is a party to the trade, and
 * that is the whole point. The Owner is always an approver (see
 * `trade_approver_ids`), so when the Owner proposes a trade and the recipient
 * accepts it, the Owner is the person who has to decide it. Hiding a pending trade
 * from an approver who also proposed it left that trade stuck in 'pending_approval'
 * with nobody able to see it or advance it, which is how the Approvals tab came up
 * empty for the one member who most needed it.
 *
 * This follows the database rather than second-guessing it: `vote_on_trade` lets the
 * Owner and the Admins decide any trade awaiting approval, whoever proposed it. The
 * interface's job is to avoid offering an action the database would reject, not to
 * refuse one the database permits.
 *
 * @param trade - The trade being considered.
 * @param canApprove - Whether the member is an approver in this league and season.
 * @returns True when the vote controls belong on this card.
 */
export function canVoteOnTrade(trade: Trade, canApprove: boolean): boolean {
  return canApprove && trade.status === "pending_approval";
}

/**
 * Reports whether the member is the proposer on a trade.
 *
 * @param trade - The trade to test.
 * @param userId - The signed-in user's id.
 * @returns True when the member sent this trade.
 */
export function isProposer(trade: Trade, userId: string): boolean {
  return trade.proposer_user_id === userId;
}

/**
 * Reports whether the member is the recipient on a trade.
 *
 * @param trade - The trade to test.
 * @param userId - The signed-in user's id.
 * @returns True when the member was sent this trade.
 */
export function isRecipient(trade: Trade, userId: string): boolean {
  return trade.recipient_user_id === userId;
}

/**
 * The name to show for a side of a trade from the reader's point of view.
 *
 * A member looking at a card they sent should not have to remember which column
 * was theirs, so a side the reader is party to is reported as "You". A reader who is
 * neither party -- an owner or admin on the Approvals tab, or any member reading a
 * completed trade in league history -- gets both real names, because calling one of
 * them "You" would be plainly wrong.
 *
 * @param trade - The trade being described.
 * @param userId - The signed-in user's id.
 * @returns Labels for the proposer's side and the recipient's side, plus the other
 *   party's name for a reader who is one of them.
 */
export function tradeSideLabels(
  trade: Trade,
  userId: string,
): { proposer: string; recipient: string; other: string } {
  if (userId === trade.proposer_user_id) {
    return {
      proposer: "You",
      recipient: trade.recipient_name,
      other: trade.recipient_name,
    };
  }

  if (userId === trade.recipient_user_id) {
    return {
      proposer: trade.proposer_name,
      recipient: "You",
      other: trade.proposer_name,
    };
  }

  return {
    proposer: trade.proposer_name,
    recipient: trade.recipient_name,
    other: trade.proposer_name,
  };
}

/**
 * The total tier value of a set of Pokémon, the figure a card shows as the cost of
 * what is moving.
 *
 * @param items - The Pokémon to total.
 * @returns The sum of their tier values.
 */
export function totalTierValue(items: TradePokemon[]): number {
  return items.reduce((sum, item) => sum + item.tier_value, 0);
}

/**
 * Opens a trade proposal for the current season.
 *
 * Delegates to the `propose_trade` SECURITY DEFINER RPC, which validates that the
 * caller owns a team, that the recipient is an active member with a team, that
 * every Pokémon named is on the roster it is claimed to come from, that the two
 * sides are disjoint, and that the season is past its draft.
 *
 * @param leagueId - The league the trade belongs to.
 * @param recipientUserId - The member being asked.
 * @param offer - Pokémon slugs the proposer sends.
 * @param request - Pokémon slugs the proposer wants to receive.
 * @param proposerTokens - Tokens the proposer is sending.
 * @param recipientTokens - Tokens the recipient is sending.
 * @returns The new trade's id.
 * @throws If the database rejects the proposal.
 */
export async function proposeTrade(
  leagueId: string,
  recipientUserId: string,
  offer: string[],
  request: string[],
  proposerTokens = 0,
  recipientTokens = 0,
): Promise<string> {
  const toJson = (slugs: string[]) => slugs.map((pokemon_id) => ({ pokemon_id }));

  const { data, error } = await supabase.rpc("propose_trade", {
    p_league_id: leagueId,
    p_recipient_user_id: recipientUserId,
    p_offer: toJson(offer),
    p_request: toJson(request),
    p_proposer_tokens: proposerTokens,
    p_recipient_tokens: recipientTokens,
  });

  if (error) {
    throw new Error(error.message || "Unable to propose that trade.");
  }

  return data as string;
}

/**
 * Accepts or declines an incoming trade proposal.
 *
 * @param tradeId - The trade being answered.
 * @param accept - True to accept, false to decline.
 * @returns The trade's status after answering: `completed` when the league does not
 *   require approval, otherwise `pending_approval` or `cancelled`.
 * @throws If the database rejects the response, e.g. the member is not the
 *   recipient or the trade has already been answered.
 */
export async function respondToTrade(
  tradeId: string,
  accept: boolean,
): Promise<TradeStatus> {
  const { data, error } = await supabase.rpc("respond_to_trade", {
    p_trade_id: tradeId,
    p_accept: accept,
  });

  if (error) {
    throw new Error(error.message || "Unable to answer that trade.");
  }

  return data as TradeStatus;
}

/**
 * Records an Owner or Admin decision on a pending trade.
 *
 * @param tradeId - The trade being decided.
 * @param approve - True to approve, false to reject.
 * @param override - Owner only; settles the trade without waiting for the quorum.
 * @returns The trade's status after the vote.
 * @throws If the caller is not an approver, the trade is not pending, or an
 *   override was requested by anyone but the owner.
 */
export async function voteOnTrade(
  tradeId: string,
  approve: boolean,
  override = false,
): Promise<TradeStatus> {
  const { data, error } = await supabase.rpc("vote_on_trade", {
    p_trade_id: tradeId,
    p_approve: approve,
    p_override: override,
  });

  if (error) {
    throw new Error(error.message || "Unable to record that decision.");
  }

  return data as TradeStatus;
}

/**
 * Withdraws your own proposal while it is still awaiting an answer.
 *
 * @param tradeId - The trade to withdraw.
 * @throws If the caller did not propose it, or it has already been answered.
 */
export async function cancelTrade(tradeId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_trade", { p_trade_id: tradeId });

  if (error) {
    throw new Error(error.message || "Unable to withdraw that trade.");
  }
}

/**
 * Clears a completed, declined, or rejected trade off your own list.
 *
 * @param tradeId - The trade to clear.
 * @throws If the caller is not a party to it, or it is still in play.
 */
export async function dismissTrade(tradeId: string): Promise<void> {
  const { error } = await supabase.rpc("dismiss_trade", { p_trade_id: tradeId });

  if (error) {
    throw new Error(error.message || "Unable to clear that trade.");
  }
}
