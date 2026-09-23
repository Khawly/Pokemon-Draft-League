/*
 * Team page data layer for the Pokemon Draft League.
 *
 * Loads the league, latest season, season settings, teams with owner display
 * info, each team's roster (enriched with the bundled catalog + stats/abilities
 * datasets), and the season's match history. Also exposes the RPC-backed
 * mutations the page uses: dropping a roster Pokemon (with the tier refunded
 * into the team's token salary) and deleting a match (owner/admin only, handled
 * by RLS), plus the salary derivation the UI shows per team.
 */
import { supabase } from "@/lib/supabase/client";
import {
  getPokemonDetailsBySlug,
  getPokemonEntryBySlug,
  type PokemonAbility,
  type PokemonBaseStats,
} from "@/lib/pokeapi";

/** Lifecycle status of a season (subset used by the team page). */
export type TeamSeasonStatus =
  | "draft_pending"
  | "draft_active"
  | "draft_complete"
  | "archived";

/** Season row for the team page. */
export type TeamSeason = {
  id: string;
  season_number: number;
  status: TeamSeasonStatus;
};

/** Per-season cost/salary configuration read from league_settings. */
export type TeamSettings = {
  enable_pokemon_costs: boolean;
  total_token_salary: number | null;
  allow_per_team_salary: boolean;
  total_rounds: number;
};

/** A team slot in the season with its owner's resolved display info. */
export type TeamInfo = {
  id: string;
  owner_user_id: string;
  team_name: string;
  draft_position: number | null;
  total_salary_override: number | null;
  owner_name: string | null;
  owner_avatar_url: string | null;
};

/** A roster slot enriched with catalog and stats/abilities data for display. */
export type TeamRosterPokemon = {
  id: string;
  team_id: string;
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  source: "draft" | "pickup" | "trade";
  acquired_at: string;
  /** Official display name from the catalog (falls back to species_name). */
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

/** One reported game of a match (result). */
export type TeamMatchResult = {
  id: string;
  winner_team_id: string;
  replay_url: string | null;
  game_number: number;
  submitted_at: string;
};

/** A head-to-head match in the season with resolved team/winner names. */
export type TeamMatch = {
  id: string;
  week_number: number;
  is_playoff: boolean;
  scheduled_at: string | null;
  status: "scheduled" | "in_progress" | "completed" | "forfeit" | "cancelled";
  winner_team_id: string | null;
  player_1_team_id: string;
  player_2_team_id: string;
  player_1_name: string;
  player_2_name: string;
  winner_name: string | null;
  /** Display date: latest result submission, else the scheduled time. */
  date_time: string | null;
  results: TeamMatchResult[];
};

/** Complete team page payload for a league. */
export type TeamPageGoods = {
  league: {
    id: string;
    name: string;
    owner_id: string;
  };
  season: TeamSeason | null;
  settings: TeamSettings | null;
  teams: TeamInfo[];
  /** Rosters keyed by team id, sorted by draft_position within teams. */
  rostersByTeam: Map<string, TeamRosterPokemon[]>;
  /** Token ledger sums keyed by team id (tiers + sunk transaction fees). */
  spentByTeam: Map<string, number>;
  /** Matches for the current season, oldest first. */
  matches: TeamMatch[];
  currentUserId: string;
  userRole: "owner" | "admin" | "member" | null;
  myTeamId: string | null;
  isStaff: boolean;
};

type TeamRow = {
  id: string;
  owner_user_id: string;
  team_name: string;
  draft_position: number | null;
  total_salary_override: number | null;
  profiles?: { display_name?: string | null; avatar_url?: string | null } | null;
};

type RosterRow = {
  id: string;
  team_id: string;
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  source: "draft" | "pickup" | "trade";
  acquired_at: string;
};

/**
 * Loads the complete team page state for a league for the signed-in user.
 *
 * Guards on authentication, loads the league and latest season, and when a
 * season exists resolves settings, teams (with owner display info), every team's
 * enriched roster, and the season's match history with results.
 *
 * @param leagueId - The id of the league whose teams to load.
 * @returns A Promise resolving to the assembled {@link TeamPageGoods}.
 * @throws If the user is not signed in, the league is missing, or a core query
 *   fails.
 */
export async function loadTeamPageData(
  leagueId: string,
): Promise<TeamPageGoods> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to view teams.");
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

  const season = (seasonRow as TeamSeason | null) ?? null;

  const base: TeamPageGoods = {
    league: {
      id: league.id,
      name: league.name,
      owner_id: league.owner_id,
    },
    season,
    settings: null,
    teams: [],
    rostersByTeam: new Map<string, TeamRosterPokemon[]>(),
    spentByTeam: new Map<string, number>(),
    matches: [],
    currentUserId: user.id,
    userRole: null,
    myTeamId: null,
    isStaff: false,
  };

  if (!season) {
    return base;
  }

  const [settingsResult, teamResult, memberResult] = await Promise.all([
    supabase
      .from("league_settings")
      .select(
        "enable_pokemon_costs, total_token_salary, allow_per_team_salary, total_rounds",
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
    throw new Error("Teams could not be loaded.");
  }

  const settingsRow = settingsResult.data as {
    enable_pokemon_costs: boolean;
    total_token_salary: number | null;
    allow_per_team_salary: boolean;
    total_rounds: number;
  } | null;

  const settings: TeamSettings | null = settingsRow
    ? {
        enable_pokemon_costs: settingsRow.enable_pokemon_costs,
        total_token_salary: settingsRow.total_token_salary,
        allow_per_team_salary: settingsRow.allow_per_team_salary,
        total_rounds: settingsRow.total_rounds,
      }
    : null;

  const teams = ((teamResult.data ?? []) as TeamRow[]).map(
    (row): TeamInfo => ({
      id: row.id,
      owner_user_id: row.owner_user_id,
      team_name: row.team_name,
      draft_position: row.draft_position,
      total_salary_override: row.total_salary_override,
      owner_name: row.profiles?.display_name ?? null,
      owner_avatar_url: row.profiles?.avatar_url ?? null,
    }),
  );

  const members = ((memberResult.data ?? []) as {
    user_id: string;
    role: "owner" | "admin" | "member";
  }[]) ?? [];

  const myMembership = members.find((member) => member.user_id === user.id);
  const userRole = myMembership?.role ?? null;
  const myTeam = teams.find((team) => team.owner_user_id === user.id);

  const teamIds = teams.map((team) => team.id);
  const rosterByTeam = new Map<string, TeamRosterPokemon[]>();

  if (teamIds.length > 0) {
    const { data: rosterRows, error: rosterError } = await supabase
      .from("team_roster")
      .select(
        "id, team_id, pokemon_id, species_name, tier_value, source, acquired_at",
      )
      .in("team_id", teamIds)
      .order("acquired_at", { ascending: true });

    if (rosterError) {
      throw new Error("Team rosters could not be loaded.");
    }

    for (const row of (rosterRows ?? []) as RosterRow[]) {
      const catalog = getPokemonEntryBySlug(row.pokemon_id);
      const details = getPokemonDetailsBySlug(row.pokemon_id);
      const entry: TeamRosterPokemon = {
        id: row.id,
        team_id: row.team_id,
        pokemon_id: row.pokemon_id,
        species_name: row.species_name,
        tier_value: row.tier_value,
        source: row.source,
        acquired_at: row.acquired_at,
        name: catalog?.name ?? row.species_name,
        types: catalog?.types ?? [],
        dex: catalog?.dexNumber ?? 0,
        spriteId: catalog?.spriteId ?? 0,
        bst: catalog?.bst ?? null,
        generation: catalog?.generation ?? null,
        stats: details?.stats ?? null,
        abilities: details?.abilities ?? null,
      };
      const current = rosterByTeam.get(row.team_id) ?? [];
      current.push(entry);
      rosterByTeam.set(row.team_id, current);
    }
  }

  // Token spend per team comes from the transaction ledger: added rows carry
  // tier plus (when enabled) the transaction fee, and dropped rows refund the
  // tier, so the net sum equals each roster's tiers plus every sunk fee.
  const spentByTeam = new Map<string, number>();
  if (teamIds.length > 0) {
    const { data: txRows, error: txError } = await supabase
      .from("transactions")
      .select("team_id, cost_delta")
      .in("team_id", teamIds);

    if (txError) {
      throw new Error("Team token balances could not be loaded.");
    }

    for (const row of (txRows ?? []) as {
      team_id: string;
      cost_delta: number;
    }[]) {
      spentByTeam.set(
        row.team_id,
        (spentByTeam.get(row.team_id) ?? 0) + row.cost_delta,
      );
    }
  }

  const { data: matchRows, error: matchError } = await supabase
    .from("matches")
    .select(
      "id, week_number, is_playoff, scheduled_at, status, winner_team_id, player_1_team_id, player_2_team_id, player_1: player_1_team_id (team_name), player_2: player_2_team_id (team_name), winner: winner_team_id (team_name)",
    )
    .eq("league_id", leagueId)
    .eq("season_id", season.id)
    .order("scheduled_at", { ascending: true });

  if (matchError) {
    throw new Error("Match history could not be loaded.");
  }

  const matchIds = (matchRows ?? []).map((row) => row.id);

  const resultsByMatch = new Map<string, TeamMatchResult[]>();
  if (matchIds.length > 0) {
    const { data: resultRows, error: resultsError } = await supabase
      .from("match_results")
      .select(
        "id, match_id, winner_team_id, replay_url, game_number, submitted_at",
      )
      .in("match_id", matchIds);

    if (resultsError) {
      throw new Error("Match results could not be loaded.");
    }

    for (const row of (resultRows ?? []) as (Omit<TeamMatchResult, "match_id"> & {
      match_id: string;
    })[]) {
      const current = resultsByMatch.get(row.match_id) ?? [];
      current.push({
        id: row.id,
        winner_team_id: row.winner_team_id,
        replay_url: row.replay_url,
        game_number: row.game_number,
        submitted_at: row.submitted_at,
      });
      resultsByMatch.set(row.match_id, current);
    }
  }

  const matches = ((matchRows ?? []) as {
    id: string;
    week_number: number;
    is_playoff: boolean;
    scheduled_at: string | null;
    status: TeamMatch["status"];
    winner_team_id: string | null;
    player_1_team_id: string;
    player_2_team_id: string;
    player_1?: { team_name?: string } | null;
    player_2?: { team_name?: string } | null;
    winner?: { team_name?: string } | null;
  }[]).map(
    (row): TeamMatch => {
      const results = resultsByMatch.get(row.id) ?? [];
      const lastSubmitted = results
        .map((result) => result.submitted_at)
        .sort()
        .at(-1);
      return {
        id: row.id,
        week_number: row.week_number,
        is_playoff: row.is_playoff,
        scheduled_at: row.scheduled_at,
        status: row.status,
        winner_team_id: row.winner_team_id,
        player_1_team_id: row.player_1_team_id,
        player_2_team_id: row.player_2_team_id,
        player_1_name: row.player_1?.team_name ?? "Team 1",
        player_2_name: row.player_2?.team_name ?? "Team 2",
        winner_name: row.winner?.team_name ?? null,
        date_time: lastSubmitted ?? row.scheduled_at ?? null,
        results,
      };
    },
  );

  // Deterministic oldest-first ordering (spec 9.4) by the display date.
  matches.sort((a, b) => {
    const left = a.date_time ? new Date(a.date_time).getTime() : Number.MAX_SAFE_INTEGER;
    const right = b.date_time ? new Date(b.date_time).getTime() : Number.MAX_SAFE_INTEGER;
    return left - right;
  });

  return {
    ...base,
    settings,
    teams,
    rostersByTeam: rosterByTeam,
    spentByTeam,
    matches,
    userRole,
    myTeamId: myTeam?.id ?? null,
    isStaff: userRole === "owner" || userRole === "admin",
  };
}

/**
 * Computes a team's current salary budget, spent, and remaining.
 *
 * Spent is the team's transaction ledger sum, so it includes any enabled
 * transaction fees on top of the roster's tier values; a dropped Pokémon's
 * refund (tier removed from the roster + a negative 'dropped' ledger row) is
 * reflected automatically. When costs are disabled the salary is effectively
 * unlimited, matching the draft arena's convention.
 *
 * @param goods - The loaded team page state.
 * @param teamId - The team to evaluate.
 * @returns Budget, spent, and remaining salary amounts.
 */
export function getTeamSalary(
  goods: TeamPageGoods,
  teamId: string,
): { budget: number; spent: number; remaining: number } {
  if (!goods.settings?.enable_pokemon_costs) {
    return { budget: 0, spent: 0, remaining: Number.POSITIVE_INFINITY };
  }

  const team = goods.teams.find((candidate) => candidate.id === teamId);
  const usesOverride =
    goods.settings.allow_per_team_salary &&
    team?.total_salary_override != null;
  const budget = usesOverride
    ? (team?.total_salary_override ?? 0)
    : (goods.settings.total_token_salary ?? 0);
  const rosterTiers = (goods.rostersByTeam.get(teamId) ?? []).reduce(
    (sum, pokemon) => sum + pokemon.tier_value,
    0,
  );
  const spent = goods.spentByTeam.get(teamId) ?? rosterTiers;

  return { budget, spent, remaining: budget - spent };
}

/**
 * Drops a Pokémon from the calling user's team roster for the league's current
 * season.
 *
 * Delegates to the `drop_roster_pokemon` SECURITY DEFINER RPC, which validates
 * ownership and season state, refunds the tier cost into the team's token
 * salary (a 'dropped' transaction with a negative cost_delta, i.e. a refund),
 * removes the roster row, and re-lists the Pokémon as in-pool.
 *
 * @param leagueId - The league whose season roster is being changed.
 * @param pokemonId - The roster Pokémon slug to drop.
 * @returns The team id and the tier tokens refunded.
 * @throws If the database rejects the drop (not your team, draft not complete,
 *   or the Pokémon is not on the roster).
 */
export async function dropRosterPokemon(
  leagueId: string,
  pokemonId: string,
): Promise<{ team_id: string; refunded_tokens: number }> {
  const { data, error } = await supabase.rpc("drop_roster_pokemon", {
    p_league_id: leagueId,
    p_pokemon_id: pokemonId,
  });

  if (error) {
    throw new Error(error.message || "Unable to drop that Pokémon.");
  }

  return (data as { team_id: string; refunded_tokens: number }[])[0];
}

/**
 * Deletes a match and its results from the league's current season.
 *
 * The owner/admin-only DELETE policy on `matches` gates this at the database;
 * `match_results` rows cascade with the match.
 *
 * @param matchId - The id of the match to delete.
 * @throws If the caller is not the league owner or an admin.
 */
export async function deleteMatch(matchId: string): Promise<void> {
  const { error } = await supabase.from("matches").delete().eq("id", matchId);

  if (error) {
    throw new Error(error.message || "Unable to delete that match.");
  }
}