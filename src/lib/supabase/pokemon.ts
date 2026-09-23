/*
 * Pokémon page data layer for the Pokemon Draft League.
 *
 * Implements spec section 11: loads the league, latest season, season settings
 * (including transaction-cost config), the free-agent pool (every in-pool
 * Pokémon not currently on any team's roster), the signed-in user's team and
 * salary, and that team's transaction history in stack order. Also exposes the
 * RPC-backed pickup mutation and the pure cost/salary derivations the page
 * renders.
 */
import { supabase } from "@/lib/supabase/client";
import {
  getPokemonDetailsBySlug,
  getPokemonEntryBySlug,
  type PokemonAbility,
  type PokemonBaseStats,
} from "@/lib/pokeapi";

/** Lifecycle status of a season (subset used by the Pokémon page). */
export type PokemonSeasonStatus =
  | "draft_pending"
  | "draft_active"
  | "draft_complete"
  | "archived";

/** Season row for the Pokémon page. */
export type PokemonSeason = {
  id: string;
  season_number: number;
  status: PokemonSeasonStatus;
};

/** Per-season cost/transaction configuration read from league_settings. */
export type PokemonSettings = {
  enable_pokemon_costs: boolean;
  total_token_salary: number | null;
  allow_per_team_salary: boolean;
  enable_transaction_costs: boolean;
  transaction_cost: number | null;
};

/** The signed-in user's team slot in the current season. */
export type PokemonTeam = {
  id: string;
  team_name: string;
  total_salary_override: number | null;
};

/** A free-agent Pokémon (in-pool and not on any roster) enriched for display. */
export type PokemonPoolRow = {
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  /** Display name from the catalog (falls back to species_name). */
  name: string;
  /** Typing as PokeAPI type names. */
  types: string[];
  /** Dex number for species, 10001+ for alternate forms (drives the sprite). */
  dex: number;
  /** Sprite id used to render the local sprite. */
  spriteId: number;
  bst: number | null;
  generation: string | null;
  /** Six base stats, or null when the bundled dataset lacks the slug. */
  stats: PokemonBaseStats | null;
  /** Ability list (normal + hidden), or null when unknown. */
  abilities: PokemonAbility[] | null;
};

/** A roster move from the ledger, enriched with a display name and sprite id. */
export type PokemonTransaction = {
  id: string;
  pokemon_id: string;
  name: string;
  /** Sprite id used to render the local sprite. */
  spriteId: number;
  /** The member who made the move. */
  userId: string;
  /** The mover's display name, when their profile has one set. */
  playerName: string | null;
  action: "added" | "dropped" | "trade_in" | "trade_out";
  cost_delta: number;
  note: string | null;
  created_at: string;
};

/** Complete Pokémon page payload for a league. */
export type PokemonGoods = {
  league: {
    id: string;
    name: string;
    owner_id: string;
  };
  season: PokemonSeason | null;
  settings: PokemonSettings | null;
  /** Free agents: in-pool Pokémon not on any team's roster. */
  pool: PokemonPoolRow[];
  /** The signed-in user's team in the current season, or null. */
  myTeam: PokemonTeam | null;
  /** Number of Pokémon currently on my team's roster. */
  rosterCount: number;
  /** My team's token spend, including sunk transaction costs. */
  spent: number;
  /** My team's transaction history, newest first. */
  transactions: PokemonTransaction[];
  currentUserId: string;
  userRole: "owner" | "admin" | "member" | null;
};

/** One pool row page; the API caps responses, so the loader pages through. */
const POKEMON_PAGE_SIZE = 1000;

type PoolRowRecord = {
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  type_primary: string | null;
  type_secondary: string | null;
  bst: number | null;
  generation: string | null;
};

type RosterClaimRow = {
  pokemon_id: string;
  tier_value: number;
  team_id: string;
};

type TransactionRow = {
  id: string;
  pokemon_id: string;
  user_id: string;
  profiles?: { display_name?: string | null } | null;
  action: "added" | "dropped" | "trade_in" | "trade_out";
  cost_delta: number;
  note: string | null;
  created_at: string;
};

/**
 * Loads the complete Pokémon page state for a league for the signed-in user.
 *
 * Guards on authentication, loads the league and latest season, and when a
 * season exists resolves settings, the free-agent pool (in-pool Pokémon not on
 * any team's roster), the user's own team and salary, and that team's
 * transaction history (newest first).
 *
 * @param leagueId - The id of the league whose free agents to load.
 * @returns A Promise resolving to the assembled {@link PokemonGoods}.
 * @throws If the user is not signed in, the league is missing, or a core query
 *   fails.
 */
export async function loadPokemonPageData(
  leagueId: string,
): Promise<PokemonGoods> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to view the free agent pool.");
  }

  const { data: league, error: leagueError } = await supabase
    .from("leagues")
    .select("id, name, owner_id")
    .eq("id", leagueId)
    .maybeSingle();

  if (leagueError || !league) {
    throw new Error("This league could not be loaded.");
  }

  const { data: seasonRow, error: seasonError } = await supabase
    .from("seasons")
    .select("id, season_number, status")
    .eq("league_id", leagueId)
    .order("season_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (seasonError) {
    throw new Error("This league's season could not be loaded.");
  }

  const season = (seasonRow as PokemonSeason | null) ?? null;

  const base: PokemonGoods = {
    league: {
      id: league.id,
      name: league.name,
      owner_id: league.owner_id,
    },
    season,
    settings: null,
    pool: [],
    myTeam: null,
    rosterCount: 0,
    spent: 0,
    transactions: [],
    currentUserId: user.id,
    userRole: null,
  };

  if (!season) {
    return base;
  }

  const [settingsResult, teamResult, memberResult] = await Promise.all([
    supabase
      .from("league_settings")
      .select(
        "enable_pokemon_costs, total_token_salary, allow_per_team_salary, enable_transaction_costs, transaction_cost",
      )
      .eq("season_id", season.id)
      .maybeSingle(),
    supabase
      .from("teams")
      .select("id, owner_user_id, team_name, total_salary_override")
      .eq("league_id", leagueId)
      .eq("season_id", season.id),
    supabase
      .from("league_members")
      .select("user_id, role")
      .eq("league_id", leagueId)
      .eq("is_active", true),
  ]);

  if (settingsResult.error || teamResult.error || memberResult.error) {
    throw new Error("The free agent pool could not be loaded.");
  }

  const settingsRow = settingsResult.data as {
    enable_pokemon_costs: boolean;
    total_token_salary: number | null;
    allow_per_team_salary: boolean;
    enable_transaction_costs: boolean;
    transaction_cost: number | null;
  } | null;

  const settings: PokemonSettings | null = settingsRow
    ? {
        enable_pokemon_costs: settingsRow.enable_pokemon_costs,
        total_token_salary: settingsRow.total_token_salary,
        allow_per_team_salary: settingsRow.allow_per_team_salary,
        enable_transaction_costs: settingsRow.enable_transaction_costs,
        transaction_cost: settingsRow.transaction_cost,
      }
    : null;

  const teams = ((teamResult.data ?? []) as {
    id: string;
    owner_user_id: string;
    team_name: string;
    total_salary_override: number | null;
  }[]);

  const members = ((memberResult.data ?? []) as {
    user_id: string;
    role: "owner" | "admin" | "member";
  }[]) ?? [];

  const myTeam =
    teams.find((team) => team.owner_user_id === user.id) ?? null;

  const teamIds = teams.map((team) => team.id);
  const claimedByPokemon = new Map<string, string>();
  const rosterTiersByTeam = new Map<string, number>();
  const rosterCountByTeam = new Map<string, number>();

  if (teamIds.length > 0) {
    const { data: rosterRows, error: rosterError } = await supabase
      .from("team_roster")
      .select("pokemon_id, tier_value, team_id")
      .in("team_id", teamIds);

    if (rosterError) {
      throw new Error("Team rosters could not be loaded.");
    }

    for (const row of (rosterRows ?? []) as RosterClaimRow[]) {
      claimedByPokemon.set(row.pokemon_id, row.team_id);
      rosterTiersByTeam.set(
        row.team_id,
        (rosterTiersByTeam.get(row.team_id) ?? 0) + row.tier_value,
      );
      rosterCountByTeam.set(
        row.team_id,
        (rosterCountByTeam.get(row.team_id) ?? 0) + 1,
      );
    }
  }

  // Resolve pool ids (active pool when set, otherwise every pool), then page
  // through the in-pool species rows past the response cap like the pool page.
  const { data: poolResult, error: poolError } = await supabase
    .from("draft_pools")
    .select("id, is_active")
    .eq("league_id", leagueId)
    .eq("season_id", season.id);

  if (poolError) {
    throw new Error("The draft pool could not be loaded.");
  }

  const poolRows = (poolResult ?? []) as { id: string; is_active: boolean }[];
  const activePools = poolRows.filter((pool) => pool.is_active);
  const poolIds = (activePools.length > 0 ? activePools : poolRows).map(
    (pool) => pool.id,
  );

  const poolPieces: PoolRowRecord[] = [];
  if (poolIds.length > 0) {
    for (let from = 0; ; from += POKEMON_PAGE_SIZE) {
      const { data, error: rowsError } = await supabase
        .from("draft_pool_pokemon")
        .select(
          "pokemon_id, species_name, tier_value, type_primary, type_secondary, bst, generation",
        )
        .in("draft_pool_id", poolIds)
        .eq("is_in_pool", true)
        .order("id", { ascending: true })
        .range(from, from + POKEMON_PAGE_SIZE - 1);

      if (rowsError) {
        throw new Error("The free agent pool could not be loaded.");
      }

      const page = (data ?? []) as PoolRowRecord[];
      poolPieces.push(...page);
      if (page.length < POKEMON_PAGE_SIZE) {
        break;
      }
    }
  }

  // A Pokémon that is on any team's roster is not a free agent, even though the
  // draft engine leaves is_in_pool TRUE for drafted species.
  const pool: PokemonPoolRow[] = poolPieces
    .filter((row) => !claimedByPokemon.has(row.pokemon_id))
    .map((row) => {
      const match = getPokemonEntryBySlug(row.pokemon_id);
      const details = getPokemonDetailsBySlug(row.pokemon_id);
      return {
        pokemon_id: row.pokemon_id,
        species_name: row.species_name,
        tier_value: row.tier_value,
        name: match?.name ?? row.species_name,
        types: match?.types ?? [],
        dex: match?.dexNumber ?? 0,
        spriteId: match?.spriteId ?? 0,
        bst: row.bst ?? match?.bst ?? null,
        generation: row.generation ?? match?.generation ?? null,
        stats: details?.stats ?? null,
        abilities: details?.abilities ?? null,
      };
    });

  const rosterTierSpent = myTeam
    ? (rosterTiersByTeam.get(myTeam.id) ?? 0)
    : 0;
  const rosterCount = myTeam ? (rosterCountByTeam.get(myTeam.id) ?? 0) : 0;

  let transactions: PokemonTransaction[] = [];
  if (myTeam) {
    const { data: transactionRows, error: transactionsError } = await supabase
      .from("transactions")
      .select(
        "id, pokemon_id, user_id, action, cost_delta, note, created_at, profiles: user_id (display_name)",
      )
      .eq("team_id", myTeam.id)
      .order("created_at", { ascending: false });

    if (transactionsError) {
      throw new Error("Transaction history could not be loaded.");
    }

    transactions = ((transactionRows ?? []) as TransactionRow[]).map((row) => ({
      id: row.id,
      pokemon_id: row.pokemon_id,
      name: getPokemonEntryBySlug(row.pokemon_id)?.name ?? row.pokemon_id,
      spriteId: getPokemonEntryBySlug(row.pokemon_id)?.spriteId ?? 0,
      userId: row.user_id,
      playerName: row.profiles?.display_name ?? null,
      action: row.action,
      cost_delta: row.cost_delta,
      note: row.note,
      created_at: row.created_at,
    }));
  }

  // Token spend is the ledger sum: draft/added rows carry tier + any transaction
  // fee, and dropped rows carry a negative refund, so the net equals the current
  // roster's tiers plus every sunk transaction fee. Fall back to roster tiers for
  // teams whose history predates the transaction ledger.
  const spent = myTeam
    ? transactions.length > 0
      ? transactions.reduce((sum, entry) => sum + entry.cost_delta, 0)
      : rosterTierSpent
    : 0;

  return {
    ...base,
    settings,
    pool,
    myTeam: myTeam
      ? {
          id: myTeam.id,
          team_name: myTeam.team_name,
          total_salary_override: myTeam.total_salary_override,
        }
      : null,
    rosterCount,
    spent,
    transactions,
    userRole:
      members.find((member) => member.user_id === user.id)?.role ?? null,
  };
}

/**
 * Computes the signed-in user's team salary budget, spent, and remaining.
 *
 * Mirrors the team/draft pages: budget comes from a per-team override (when
 * enabled) or the league's total token salary; spent is the team's transaction
 * ledger sum, so tier costs and (when enabled) transaction fees both count
 * against the budget while drops (which refund only the tier) free salary back
 * up. When costs are disabled the salary is effectively unlimited.
 *
 * @param goods - The loaded Pokémon page state.
 * @returns Budget, spent, and remaining salary amounts.
 */
export function getPokemonSalary(goods: PokemonGoods): {
  budget: number;
  spent: number;
  remaining: number;
} {
  if (!goods.settings?.enable_pokemon_costs) {
    return { budget: 0, spent: 0, remaining: Number.POSITIVE_INFINITY };
  }

  const usesOverride =
    goods.settings.allow_per_team_salary &&
    goods.myTeam?.total_salary_override != null;
  const budget = usesOverride
    ? (goods.myTeam?.total_salary_override ?? 0)
    : (goods.settings.total_token_salary ?? 0);

  return { budget, spent: goods.spent, remaining: budget - goods.spent };
}

/**
 * Computes the token cost of picking up a free agent.
 *
 * The base cost is the Pokémon's tier (only when costs are enabled) plus the
 * league's transaction cost (when enabled). Returns the breakdown and total the
 * confirmation dialog shows.
 *
 * @param goods - The loaded Pokémon page state.
 * @param row - The free-agent Pokémon being considered.
 * @returns The tier, transaction, and total token cost.
 */
export function getPickupCost(
  goods: PokemonGoods,
  row: PokemonPoolRow,
): { tierCost: number; transactionCost: number; total: number } {
  const tierCost = goods.settings?.enable_pokemon_costs ? row.tier_value : 0;
  const transactionCost = goods.settings?.enable_transaction_costs
    ? (goods.settings.transaction_cost ?? 0)
    : 0;
  return { tierCost, transactionCost, total: tierCost + transactionCost };
}

/**
 * Reports whether the signed-in user's team can pay the full cost of a pickup.
 *
 * The tier plus any transaction cost must leave the team's remaining token
 * balance at zero or above. When Pokemon costs are disabled the balance is
 * effectively unlimited (the app treats the salary as infinite), so every
 * pickup is affordable.
 *
 * @param goods - The loaded Pokémon page state.
 * @param row - The free-agent Pokémon being considered.
 * @returns True when the pickup is within the team's remaining balance.
 */
export function canAffordPickup(
  goods: PokemonGoods,
  row: PokemonPoolRow,
): boolean {
  const salary = getPokemonSalary(goods);
  if (salary.remaining === Number.POSITIVE_INFINITY) {
    return true;
  }
  return salary.remaining >= getPickupCost(goods, row).total;
}

/**
 * Picks up a free-agent Pokémon from the league's active pool for the calling
 * user's team in the current season.
 *
 * Delegates to the `pickup_roster_pokemon` SECURITY DEFINER RPC, which
 * validates membership, team ownership, pool availability, and salary
 * affordability, charges the tier (plus any transaction cost) as an 'added'
 * ledger row, and adds the roster row with source 'pickup'.
 *
 * @param leagueId - The league whose season roster is being changed.
 * @param pokemonId - The free-agent Pokémon slug to pick up.
 * @returns The roster id, team id, tier, and total tokens charged.
 * @throws If the database rejects the pickup (not your team, draft not
 *   complete, not in the free agent pool, or salary would go below 0).
 */
export async function pickupRosterPokemon(
  leagueId: string,
  pokemonId: string,
): Promise<{
  roster_id: string;
  team_id: string;
  tier_value: number;
  charged_tokens: number;
}> {
  const { data, error } = await supabase.rpc("pickup_roster_pokemon", {
    p_league_id: leagueId,
    p_pokemon_id: pokemonId,
  });

  if (error) {
    throw new Error(error.message || "Unable to pick up that Pokémon.");
  }

  return (data as {
    roster_id: string;
    team_id: string;
    tier_value: number;
    charged_tokens: number;
  }[])[0];
}