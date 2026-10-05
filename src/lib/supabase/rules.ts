/*
 * Rules document data layer for the Pokemon Draft League (spec section 13).
 *
 * A league's rules are one document per season, authored by the league owner:
 * the owner types them into a text area or uploads a text file, and every member
 * can read them back. Reads go straight to `rules_documents` under RLS; the write
 * goes through the `save_league_rules` RPC, which is the only path allowed to
 * change the row and which refuses anyone who is not the league's owner.
 */
import { supabase } from "@/lib/supabase/client";
import { loadLatestSeason } from "@/lib/supabase/seasons";

/** The league's rules for the current season. */
export type LeagueRules = {
  id: string;
  /** The rules text, or null when the owner has cleared them. */
  content: string | null;
  /** The author's display name, or null when the profile has no name set. */
  authorName: string | null;
  /** When the rules were last saved; the page shows this as "last updated". */
  updatedAt: string;
};

const RULES_SELECT =
  "id, content, updated_at, profiles!rules_documents_created_by_fkey(display_name)";

/**
 * Loads the selected league's rules for its current season.
 *
 * Resolves the latest season explicitly rather than relying on the RLS policy's
 * own subquery, so a league with no rules yet and a league whose rules are hidden
 * both come back as null rather than as an error the page has to interpret.
 *
 * The league identity and the caller's own id ride along because the page needs
 * both to decide whether to offer the owner an editor, and it would otherwise cost
 * two more round trips to answer a question the rules query already sits inside.
 *
 * @param leagueId - The league whose rules to read.
 * @returns A promise resolving to the league, the rules, and the caller's id.
 * @throws If the league or its latest season cannot be resolved.
 */
export async function loadRulesPageData(leagueId: string): Promise<{
  league: { id: string; name: string; ownerId: string } | null;
  rules: LeagueRules | null;
  currentUserId: string;
}> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: leagueRow, error: leagueError } = await supabase
    .from("leagues")
    .select("id, name, owner_id")
    .eq("id", leagueId)
    .maybeSingle();

  if (leagueError) {
    throw new Error("This league could not be loaded.");
  }

  const league = (leagueRow as {
    id: string;
    name: string;
    owner_id: string;
  } | null) ?? null;

  const { data: seasonRow, error: seasonError } = await loadLatestSeason<{
    id: string;
  }>(leagueId, "id");

  if (seasonError) {
    throw new Error("This league's season could not be loaded.");
  }

  const season = (seasonRow as { id: string } | null) ?? null;
  const leagueSummary = league
    ? { id: league.id, name: league.name, ownerId: league.owner_id }
    : null;

  if (!league || !season) {
    return {
      league: leagueSummary,
      rules: null,
      currentUserId: user?.id ?? "",
    };
  }

  const { data, error } = await supabase
    .from("rules_documents")
    .select(RULES_SELECT)
    .eq("league_id", leagueId)
    .eq("season_id", season.id)
    .maybeSingle();

  if (error) {
    throw new Error("The league rules could not be loaded.");
  }

  const row = data as {
    id: string;
    content: string | null;
    updated_at: string;
    profiles?: { display_name?: string | null } | null;
  } | null;

  return {
    league: leagueSummary,
    rules: row
      ? {
          id: row.id,
          content: row.content,
          authorName: row.profiles?.display_name ?? null,
          updatedAt: row.updated_at,
        }
      : null,
    currentUserId: user?.id ?? "",
  };
}

/**
 * Saves the league's rules for its current season, creating or replacing them.
 *
 * Delegates to the owner-gated RPC rather than writing the table, so the browser
 * cannot author rules on someone else's behalf. Blank content clears the rules
 * rather than storing an empty document.
 *
 * @param leagueId - The league whose rules to write.
 * @param content - The rules text. Blank clears them.
 * @returns A promise resolving to when the rules were saved.
 * @throws If the database refuses the save, e.g. the caller is not the owner.
 */
export async function saveLeagueRules(
  leagueId: string,
  content: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("save_league_rules", {
    p_league_id: leagueId,
    p_content: content,
  });

  if (error) {
    throw new Error(error.message || "Unable to save the league rules.");
  }

  const saved = (data as { updated_at: string }[] | null)?.[0];
  return saved?.updated_at ?? new Date().toISOString();
}

/**
 * Normalizes the text of an uploaded rules file.
 *
 * Strips a UTF-8 byte order mark, which Notepad and older Windows editors add and
 * which would otherwise render as a stray character at the top of the rules, and
 * collapses CRLF and bare-CR line endings to LF so the text area does not show
 * mixed endings and a lone carriage return does not render as a run-on line.
 *
 * @param raw - The file's contents as read by the browser.
 * @returns The cleaned text.
 */
export function normalizeRulesText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}