/*
 * Replay summary endpoint for the Pokemon Draft League.
 *
 * Fetches a Pokemon Showdown battle log on the server and returns the winner and
 * the winner's surviving Pokemon count, resolved against the two teams in a
 * league match. The browser never talks to Showdown directly, which keeps the
 * outbound request off the client and puts the host allowlist and auth check in
 * one place.
 *
 * The response deliberately carries the survivor count as an unsigned number
 * alongside the winning team, never a signed differential. `match_results`
 * stores an unsigned count and `season_standings` derives the sign from
 * `winner_team_id`, so returning a signed value would risk writing a negative
 * into that column and reversing the differential for both teams.
 */
import { NextResponse } from "next/server";
import { getServerSession, createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchReplaySummary } from "@/lib/replay";

/** The subset of the parsed replay the schedule form needs. */
type ReplaySummaryResponse = {
  format: string | null;
  turnCount: number | null;
  /** Both Showdown usernames, keyed by the match side they played. */
  players: Record<string, string>;
  /** The league team that won, when the log's usernames match a participant. */
  winnerTeamId: string | null;
  /** The Showdown username credited with the win. */
  winnerName: string | null;
  /** Unsigned surviving count for the winner; null unless the finish was a knockout. */
  pokemonLeftAlive: number | null;
  kosFor: number;
  kosAgainst: number;
  conclusive: boolean;
  /** A human-readable reason the count is unavailable, when it is. */
  note: string | null;
};

/**
 * Reads a Showdown replay and resolves its winner against a league match.
 *
 * @param request - POST body of `{ replayUrl, matchId }`.
 * @returns The resolved summary, or a 4xx with an `error` message.
 */
export async function POST(request: Request) {
  const { user } = await getServerSession();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  let replayUrl: unknown;
  let matchId: unknown;
  try {
    ({ replayUrl, matchId } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof replayUrl !== "string" || typeof matchId !== "string") {
    return NextResponse.json(
      { error: "A replay link and a match are required." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();

  const { data: match, error: matchError } = await supabase
    .from("matches")
    .select("id, player_1_team_id, player_2_team_id")
    .eq("id", matchId)
    .maybeSingle();

  if (matchError) {
    return NextResponse.json(
      { error: "That match could not be loaded." },
      { status: 500 },
    );
  }
  if (!match) {
    return NextResponse.json({ error: "That match does not exist." }, { status: 404 });
  }

  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id, owner_user_id, profiles(pokemon_showdown_username)")
    .in("id", [match.player_1_team_id, match.player_2_team_id]);

  if (teamsError) {
    return NextResponse.json(
      { error: "That match's teams could not be loaded." },
      { status: 500 },
    );
  }
  if (!teams || teams.length === 0) {
    return NextResponse.json({ error: "That match does not exist." }, { status: 404 });
  }

  // The client is untyped, so normalise the embedded profile to a flat shape.
  const participants = teams.map((team) => {
    const embedded = team.profiles as
      | { pokemon_showdown_username: string | null }[]
      | { pokemon_showdown_username: string | null }
      | null;
    const profile = Array.isArray(embedded) ? embedded[0] : embedded;
    return {
      id: team.id as string,
      ownerUserId: team.owner_user_id as string,
      showdownUsername: profile?.pokemon_showdown_username ?? null,
    };
  });

  // Mirror submit_game_result: only a participant resolves replays for a match.
  if (!participants.some((team) => team.ownerUserId === user.id)) {
    return NextResponse.json(
      { error: "Only the participants can read a replay for this match." },
      { status: 403 },
    );
  }

  let summary: Awaited<ReturnType<typeof fetchReplaySummary>>;
  try {
    summary = await fetchReplaySummary(replayUrl);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "That replay could not be read.";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  // Map the log's `|win|` username onto a league team by Showdown handle.
  const winnerHandle = summary.winnerName?.toLowerCase() ?? null;
  let winningTeam = winnerHandle
    ? participants.find((team) => team.showdownUsername?.toLowerCase() === winnerHandle)
    : undefined;

  /*
   * Fallback for opponents who have not set a Showdown username. The replay
   * names both of its players, so if exactly one participant's handle appears
   * there, that team is the one that lost and the other team won. With neither
   * or both handles present there is nothing to infer and the user picks.
   */
  if (!winningTeam) {
    const replayHandles = new Set(
      Object.values(summary.players).map((name) => name.toLowerCase()),
    );
    const identified = participants.filter((team) =>
      team.showdownUsername
        ? replayHandles.has(team.showdownUsername.toLowerCase())
        : false,
    );
    if (identified.length === 1) {
      winningTeam = participants.find((team) => team.id !== identified[0].id);
    }
  }

  const body: ReplaySummaryResponse = {
    format: summary.format,
    turnCount: summary.turnCount,
    players: summary.players,
    winnerTeamId: winningTeam?.id ?? null,
    winnerName: summary.winnerName,
    pokemonLeftAlive: summary.pokemonLeftAlive,
    kosFor: summary.kosFor,
    kosAgainst: summary.kosAgainst,
    conclusive: summary.conclusive,
    note: replayNote(summary),
  };

  return NextResponse.json(body);
}

/** Explains, in the user's terms, why a count is missing for an unusual finish. */
function replayNote(summary: Awaited<ReturnType<typeof fetchReplaySummary>>): string | null {
  if (summary.conclusive) return null;
  if (summary.outcome === "tie") {
    return "That replay ended in a tie, so there is no differential to record.";
  }
  if (summary.outcome === "unfinished") {
    return "That replay has no result recorded, so Showdown did not finish it.";
  }
  if ((summary.loserPokemonLeftAlive ?? 0) > 0) {
    return "That game did not end by knockout, so the survivor count is not a valid differential. Record it as a forfeit instead.";
  }
  return "The winner of that replay could not be matched to a team in this match.";
}
