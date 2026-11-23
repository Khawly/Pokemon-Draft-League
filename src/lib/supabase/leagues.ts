/*
 * League lifecycle helpers for the Pokemon Draft League.
 *
 * Wraps the `create_league_for_user` and `delete_league` RPCs: create a league
 * along with its first season, or permanently remove a league and every row
 * that cascades from it.
 */
import { supabase } from "@/lib/supabase/client";
import { MAX_NAME_LENGTH } from "@/lib/name-limits";

/**
 * Creates a new league owned by the current user via the
 * `create_league_for_user` RPC.
 *
 * @param params - Object containing the league `name` and `numberOfPlayers`.
 * @returns A Promise resolving to the created league's id, season id, name, and
 *   number of players.
 * @throws If the name is blank or longer than {@link MAX_NAME_LENGTH}, the
 *   player count is not a positive integer, the user is not signed in, or the
 *   RPC fails.
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

  if (trimmedName.length > MAX_NAME_LENGTH) {
    throw new Error(
      `League name must be ${MAX_NAME_LENGTH} characters or fewer.`,
    );
  }

  if (
    !Number.isInteger(numberOfPlayers) ||
    numberOfPlayers < 2 ||
    numberOfPlayers > 50
  ) {
    throw new Error("Number of players must be a whole number between 2 and 50.");
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

/** Bucket holding uploaded league images. */
const LEAGUE_IMAGE_BUCKET = "league-images";

/**
 * Path of a league's uploaded image inside the bucket.
 *
 * @param leagueId - The league whose image is addressed.
 * @returns The storage path.
 */
function leagueImagePath(leagueId: string): string {
  return `${leagueId}/image.webp`;
}

/**
 * Removes a league's uploaded image.
 *
 * @param leagueId - The league whose image to remove.
 * @throws When storage rejects the delete.
 */
export async function removeLeagueImage(leagueId: string): Promise<void> {
  const { error } = await supabase.storage
    .from(LEAGUE_IMAGE_BUCKET)
    .remove([leagueImagePath(leagueId)]);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Uploads a league image and returns its public URL.
 *
 * @param leagueId - The league whose image to replace.
 * @param file - The image to store.
 * @returns The public URL, cache-busted so the new image is picked up.
 * @throws When storage rejects the upload.
 */
export async function uploadLeagueImage(
  leagueId: string,
  file: File,
): Promise<string> {
  const path = leagueImagePath(leagueId);
  const { error } = await supabase.storage
    .from(LEAGUE_IMAGE_BUCKET)
    .upload(path, file, { cacheControl: "0", upsert: true });

  if (error) {
    throw new Error(error.message);
  }

  const { data } = supabase.storage.from(LEAGUE_IMAGE_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
}

/**
 * Starts a new season for a league and archives the closing one.
 *
 * @param leagueId - The league to advance.
 * @throws When the RPC fails.
 */
export async function startNewSeason(leagueId: string): Promise<void> {
  const { error } = await supabase.rpc("start_new_season", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Leaves a league.
 *
 * @param leagueId - The league to leave.
 * @throws When the RPC refuses the departure.
 */
export async function leaveLeague(leagueId: string): Promise<void> {
  const { error } = await supabase.rpc("leave_league", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Transfers league ownership to another member.
 *
 * @param leagueId - The league being transferred.
 * @param newOwnerUserId - The member who becomes owner.
 * @throws When the caller is not the current owner or the RPC fails.
 */
export async function transferLeagueOwnership(
  leagueId: string,
  newOwnerUserId: string,
): Promise<void> {
  const { error } = await supabase.rpc("transfer_league_ownership", {
    p_league_id: leagueId,
    p_new_owner_user_id: newOwnerUserId,
  });

  if (error) {
    throw new Error(error.message);
  }
}
