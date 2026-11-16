/*
 * Resolves which league a page should show.
 *
 * Every page that loads league data (trades, teams, free agents, schedule) needs
 * the same three-step answer: the league named in the URL, else the one the
 * member last selected, else the member's most recent active membership. That
 * logic used to be copy-pasted into each page's load effect; it lives here so the
 * order of precedence - and the messages when none of the three applies - cannot
 * drift between pages.
 */
import { getSelectedLeague } from "@/lib/league-selection";
import { supabase } from "@/lib/supabase/client";

/** Outcome of {@link resolveActiveLeague}. */
export type ActiveLeagueResolution =
  | { status: "unauthenticated" }
  | { status: "error"; message: string }
  | { status: "ready"; leagueId: string };

/** Shown when the member has no active membership to fall back to. */
const NO_MEMBERSHIP_MESSAGE = "You are not a member of any active league.";

/**
 * Finds the league the page should load for the signed-in member.
 *
 * Precedence is URL parameter, then the stored selection, then the member's most
 * recently joined active league. The membership query is only issued when the
 * first two are empty, matching the order the pages used before this helper
 * existed and avoiding a request on every navigation.
 *
 * @param requestedLeagueId - The `leagueId` search param, or null when absent.
 * @param missingLeagueMessage - Page-specific copy for the (unlikely) case where
 *   every source is empty, e.g. "Select a league before opening the trade centre."
 * @returns `unauthenticated`, an `error` with display copy, or the resolved id.
 */
export async function resolveActiveLeague(
  requestedLeagueId: string | null,
  missingLeagueMessage: string,
): Promise<ActiveLeagueResolution> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { status: "unauthenticated" };
  }

  const fromRequestOrStorage = requestedLeagueId ?? getSelectedLeague();

  if (fromRequestOrStorage) {
    return { status: "ready", leagueId: fromRequestOrStorage };
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from("league_members")
    .select("league_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("joined_at", { ascending: false })
    .limit(1);

  if (membershipsError || !memberships?.length) {
    return { status: "error", message: NO_MEMBERSHIP_MESSAGE };
  }

  /*
   * A row with a null league id would be a data fault rather than a missing
   * membership, so it keeps the page-specific message instead of claiming the
   * member belongs to no league at all.
   */
  const leagueId: string | null = memberships[0]?.league_id ?? null;

  if (!leagueId) {
    return { status: "error", message: missingLeagueMessage };
  }

  return { status: "ready", leagueId };
}
