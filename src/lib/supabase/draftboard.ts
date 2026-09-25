/*
 * Draft board data loader for the Pokemon Draft League.
 *
 * Assembles league, season, member, invite, and draft-pool data, plus the
 * current user's role, into a single `DraftboardGoods` payload for a league.
 * Draft order positions live on each league member, not on teams.
 */
import { supabase } from "@/lib/supabase/client";
import { loadLatestSeason } from "@/lib/supabase/seasons";

/**
 * A league member with resolved profile display name, avatar, and their
 * per-player draft order position (null until assigned).
 */
export type DraftboardMember = {
  user_id: string;
  role: "owner" | "admin" | "member";
  display_name: string | null;
  avatar_url: string | null;
  draft_position: number | null;
};

/** Season row for the draft board. */
export type DraftboardSeason = {
  id: string;
  season_number: number;
  status: string;
  name: string | null;
};

/**
 * Complete draft board data for a league: league meta, current season, members,
 * whether any Pokémon are in the pool, the latest invite token, and the
 * requesting user's role.
 */
export type DraftboardGoods = {
  league: {
    id: string;
    name: string;
    owner_id: string;
    number_of_players: number;
  };
  season: DraftboardSeason | null;
  members: DraftboardMember[];
  hasInPoolPokemon: boolean;
  inviteToken: string | null;
  userRole: string | null;
  isOwner: boolean;
};

type MemberRow = {
  user_id: string;
  role: "owner" | "admin" | "member";
  draft_position: number | null;
  profiles?: {
    display_name?: string | null;
    avatar_url?: string | null;
  } | null;
};

/**
 * Loads all draft board data for a league for the signed-in user.
 *
 * Fetches the league, its latest season, and (when a season exists) members,
 * teams, profile data, pool status, and the last invite token. Called from
 * server contexts via a Supabase client, but authored against the shared client
 * so RPC/query shapes stay consistent.
 *
 * @param leagueId - The id of the league to load.
 * @returns A Promise resolving to the assembled `DraftboardGoods`.
 * @throws If the user is not signed in, the league cannot be loaded, or a
 *   season lookup fails.
 */
export async function loadDraftboardData(
  leagueId: string,
): Promise<DraftboardGoods> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to view the draft board.");
  }

  const { data: league, error: leagueError } = await supabase
    .from("leagues")
    .select("id, name, owner_id, number_of_players")
    .eq("id", leagueId)
    .maybeSingle();

  if (leagueError || !league) {
    throw new Error("This league could not be loaded.");
  }

  const { data: seasonRow, error: seasonError } = await loadLatestSeason<DraftboardSeason>(
    leagueId,
    "id, season_number, status, name",
  );

  if (seasonError) {
    throw new Error(seasonError.message || "This league's season could not be loaded.");
  }

  const season = seasonRow;

  // Members only apply once a season exists; otherwise skip those queries
  // instead of erroring.
  const [
    memberResult,
    membershipResult,
    inviteResult,
  ] = await Promise.all([
    season
      ? supabase
          .from("league_members")
          .select(
            "user_id, role, draft_position, profiles: user_id (display_name, avatar_url)",
          )
          .eq("league_id", leagueId)
          .eq("is_active", true)
          .order("joined_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("league_members")
      .select("role")
      .eq("league_id", leagueId)
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle(),
    supabase
      .from("league_invites")
      .select("token")
      .eq("league_id", leagueId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (memberResult.error) {
    throw new Error("League data could not be loaded.");
  }

  // Reshape the joined rows into the flat member shape the UI consumes.
  const members = ((memberResult.data ?? []) as MemberRow[]).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    display_name: row.profiles?.display_name ?? null,
    avatar_url: row.profiles?.avatar_url ?? null,
    draft_position: row.draft_position,
  }));

  let hasInPoolPokemon = false;
  if (season) {
    // Count pool Pokémon for the current season, scoped to the active pool when
    // the owner has set one (falling back to every pool in the season).
    const { data: poolRows, error: poolError } = await supabase
      .from("draft_pools")
      .select("id, is_active")
      .eq("league_id", leagueId)
      .eq("season_id", season.id);

    if (!poolError && poolRows && poolRows.length > 0) {
      const scopedPools = (poolRows as { id: string; is_active: boolean }[]).filter(
        (row) => row.is_active,
      );
      const poolIds = (scopedPools.length > 0 ? scopedPools : poolRows).map(
        (row) => (row as { id: string }).id,
      );
      const { count } = await supabase
        .from("draft_pool_pokemon")
        .select("pokemon_id", { count: "exact", head: true })
        .in("draft_pool_id", poolIds)
        .eq("is_in_pool", true);
      hasInPoolPokemon = (count ?? 0) > 0;
    }
  }

  const inviteToken =
    ((inviteResult.data as { token: string } | null)?.token ?? null) ?? null;
  const membershipRole = (
    membershipResult.data as { role: string } | null
  )?.role ?? null;

  return {
    league: {
      id: league.id,
      name: league.name,
      owner_id: league.owner_id,
      number_of_players: league.number_of_players,
    },
    season,
    members,
    hasInPoolPokemon,
    inviteToken,
    userRole: membershipRole,
    isOwner: league.owner_id === user.id,
  };
}