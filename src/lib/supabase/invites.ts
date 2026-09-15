/*
 * League invite helpers for the Pokemon Draft League.
 *
 * Wraps invite-related RPCs for validating tokens, creating invite links, and
 * joining a league by invite.
 */
import { supabase } from "@/lib/supabase/client";

/**
 * Public details about a league surfaced when validating an invite link.
 */
export type LeagueInviteInfo = {
  league_id: string;
  league_name: string;
  member_count: number;
  is_expired: boolean;
};

/**
 * A created league invite, including its token and expiry.
 */
export type LeagueInviteToken = {
  token: string;
  league_id: string;
  expires_at: string | null;
};

/**
 * Validates an invite token and returns the target league's public info.
 *
 * @param token - The invite token to look up.
 * @returns A Promise resolving to the league info, or null if the token is
 *   unknown or invalid.
 */
export async function getLeagueInviteInfo(
  token: string,
): Promise<LeagueInviteInfo | null> {
  const { data, error } = await supabase.rpc("get_league_invite_info", {
    p_token: token,
  });

  if (error) {
    throw new Error(
      error.message || "This invite link could not be validated.",
    );
  }

  const row = (data as LeagueInviteInfo[] | null)?.[0] ?? null;
  return row ?? null;
}

/**
 * Creates a new invite link for the given league.
 *
 * @param leagueId - The id of the league to create an invite for.
 * @returns A Promise resolving to the created invite token and expiry.
 */
export async function createLeagueInvite(
  leagueId: string,
): Promise<LeagueInviteToken> {
  const { data, error } = await supabase.rpc("create_league_invite", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message || "Unable to create an invite link.");
  }

  const row = (data as LeagueInviteToken[] | null)?.[0] ?? null;

  if (!row) {
    throw new Error("No invite link was created.");
  }

  return row;
}

/**
 * Joins the current user to the league associated with the given invite token.
 *
 * @param token - The invite token used to join.
 * @returns A Promise resolving to the joined league's id and name, or null if
 *   the invite is no longer valid.
 */
export async function joinLeagueByInvite(token: string): Promise<{
  league_id: string;
  league_name: string;
} | null> {
  const { data, error } = await supabase.rpc("join_league_by_invite", {
    p_token: token,
  });

  if (error) {
    throw new Error(error.message || "Unable to join this league.");
  }

  return (data as Array<{ league_id: string; league_name: string }> | null)?.[0] ??
    null;
}