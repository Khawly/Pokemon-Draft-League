/*
 * League lifecycle helpers for the Pokemon Draft League.
 *
 * Wraps the `create_league_for_user` and `delete_league` RPCs: create a league
 * along with its first season, or permanently remove a league and every row
 * that cascades from it.
 */
import { supabase } from "@/lib/supabase/client";

/**
 * Creates a new league owned by the current user via the
 * `create_league_for_user` RPC.
 *
 * @param params - Object containing the league `name` and `numberOfPlayers`.
 * @returns A Promise resolving to the created league's id, season id, name, and
 *   number of players.
 * @throws If the name is blank, the player count is not a positive integer, the
 *   user is not signed in, or the RPC fails.
 */
export async function createLeagueForUser({
  name,
  numberOfPlayers,
}: {
  name: string;
  numberOfPlayers: number;
}) {
  const trimmedName = name.trim();

  if (!trimmedName) {
    throw new Error("League name is required.");
  }

  if (!Number.isInteger(numberOfPlayers) || numberOfPlayers <= 0) {
    throw new Error("Number of players must be a positive whole number.");
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to create a league.");
  }

  const { data, error } = await supabase.rpc("create_league_for_user", {
    p_name: trimmedName,
    p_number_of_players: numberOfPlayers,
  });

  if (error) {
    throw new Error(error.message || "Unable to create the league.");
  }

  const result = data as
    | {
        league_id: string;
        season_id: string;
        league_name: string;
        number_of_players: number;
      }
    | null;

  if (!result) {
    throw new Error("No league was created.");
  }

  return {
    leagueId: result.league_id,
    seasonId: result.season_id,
    name: result.league_name,
    numberOfPlayers: result.number_of_players,
  };
}

/**
 * Permanently deletes a league and every row that belongs to it.
 *
 * Delegates to the `delete_league` SECURITY DEFINER RPC, which checks that the
 * caller is the league owner. All league-scoped tables reference `leagues` with
 * `ON DELETE CASCADE`, so seasons, settings, teams, rosters, drafts, trades,
 * matches, transactions, rules, notifications, and invites are removed in the
 * same transaction.
 *
 * @param leagueId - The league to delete.
 * @throws If the caller is not the owner, the league no longer exists, or the
 *   RPC fails.
 */
export async function deleteLeague(leagueId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_league", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message || "Unable to delete the league.");
  }
}
