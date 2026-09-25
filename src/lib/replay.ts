/*
 * Pokemon Showdown replay parsing for the Pokemon Draft League.
 *
 * Turns a Showdown replay link into the numbers the league standings need: who
 * won a game and how many Pokemon that winner had left standing. The league's
 * `season_standings` differential is the sum of `+/- pokemon_left_alive` over a
 * team's games, so the parser's job is to read one game's winner and survivor
 * count out of the battle log that Showdown serves next to the replay.
 *
 * The module is deliberately dependency-free so it can run in a server route,
 * a script, or a test harness without pulling in the Supabase client.
 */

/** Hosts a replay log may be fetched from, to keep user-supplied links from becoming SSRF. */
const ALLOWED_REPLAY_HOSTS = new Set(["replay.pokemonshowdown.com"]);

/** Default side size when a log declares neither `teamsize` nor a team preview. */
const FALLBACK_TEAM_SIZE = 6;

/** How the game ended, as far as the log reveals. */
export type ReplayOutcome =
  /** A normal finish: one side knocked the other out. */
  | "win"
  /** The turn limit expired, or the log ends with `|tie|`. */
  | "tie"
  /** The log has no `|win|` or `|tie|` line (interrupted, or truncated). */
  | "unfinished";

/** Everything the league needs from one replay log. */
export type ReplaySummary = {
  /** The `tier` line, e.g. `[Gen 9] NatDex 6v6 Doubles Draft`. */
  format: string | null;
  outcome: ReplayOutcome;
  /** The winning side (`p1`/`p2`), or null when the log does not name a winner. */
  winnerSide: string | null;
  /** The losing side, or null when the log does not name a winner. */
  loserSide: string | null;
  /** The username Showdown credits the win to. */
  winnerName: string | null;
  /** Side -> username, as declared by the `player` lines. */
  players: Record<string, string>;
  /** Side -> declared team size, from `teamsize` or the team preview. */
  teamSizes: Record<string, number>;
  /** Pokemon the winner knocked out. */
  kosFor: number;
  /** Pokemon the winner lost. */
  kosAgainst: number;
  /** The winner's surviving Pokemon, i.e. `teamSize - kosAgainst`. */
  pokemonLeftAlive: number | null;
  /** `kosFor - kosAgainst`; equals `pokemonLeftAlive` for equal-sized sides. */
  koDifferential: number | null;
  /**
   * True only when the log records a knockout finish: a named winner, and a
   * losing side with no Pokemon left standing. A tie, an unfinished log, or a
   * forfeit that ended the game early leaves this false, because none of those
   * produce a survivor count the league can score.
   */
  conclusive: boolean;
  /** Pokemon the losing side still had standing. */
  loserPokemonLeftAlive: number | null;
  /** The highest `turn` number seen, i.e. the game length. */
  turnCount: number | null;
};

/** Resolves the `.log` URL that backs a replay page, without fetching it. */
export function replayLogUrl(replayUrl: string): string {
  const path = replayUrl.trim().split(/[?#]/)[0].replace(/\/+$/, "");
  if (/\.(?:log|txt)$/i.test(path)) {
    return path.replace(/\.txt$/i, ".log");
  }
  return `${path}.log`;
}

/** Reverses Showdown's HTML escaping of the `&`, `<`, `>`, `"` and `'` entities. */
function unescape(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const point = Number.parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      return Number.isNaN(point) ? match : String.fromCodePoint(point);
    }
    return named[code.toLowerCase()] ?? match;
  });
}

/** Pulls the side out of a `p1a: Name` style token, or null when it has none. */
function sideOf(token: string | undefined): string | null {
  const match = token?.match(/^(p[1-4])(?=[a-z]?:|\s|$)/i);
  return match ? match[1].toLowerCase() : null;
}

/** Case- and escape-insensitive key so `|win|` names match `|player|` names. */
function nameKey(value: string): string {
  return unescape(value).trim().toLowerCase();
}

/**
 * Reads a Showdown battle log and derives the game's winner and KO numbers.
 *
 * Showdown reports knockouts as `|faint|<side>` lines, so the winner's KO count
 * is just the number of faints on the losing side. A `|faint|` line is emitted
 * for every knockout regardless of cause (damage, recoil, self-destruct,
 * Perish Song, sandstorm), and Illusion's `|replace|` fake is not one, which
 * makes the line count reliable without inspecting the move log.
 *
 * @param log - The raw contents of a replay's `.log` file.
 * @returns The winner, the KO counts, and the winner's surviving Pokemon.
 */
export function parseReplayLog(log: string): ReplaySummary {
  const players: Record<string, string> = {};
  const teamSizes: Record<string, number> = {};
  const previewed: Record<string, number> = {};
  const faints: Record<string, number> = {};

  let format: string | null = null;
  let turnCount: number | null = null;
  let outcome: ReplayOutcome = "unfinished";
  let winnerName: string | null = null;

  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const parts = line.split("|");

    switch (parts[1]) {
      case "player": {
        const side = sideOf(parts[2]);
        const name = parts[3];
        if (side && name) players[side] = unescape(name);
        break;
      }
      case "teamsize": {
        const side = sideOf(parts[2]);
        const size = Number.parseInt(parts[3] ?? "", 10);
        if (side && Number.isInteger(size) && size > 0) teamSizes[side] = size;
        break;
      }
      case "poke": {
        const side = sideOf(parts[2]);
        if (side) previewed[side] = (previewed[side] ?? 0) + 1;
        break;
      }
      case "tier":
        format = unescape(parts[2] ?? "");
        break;
      case "faint": {
        const side = sideOf(parts[2]);
        if (side) faints[side] = (faints[side] ?? 0) + 1;
        break;
      }
      case "turn": {
        const turn = Number.parseInt(parts[2] ?? "", 10);
        if (Number.isInteger(turn)) turnCount = turn;
        break;
      }
      case "win":
        outcome = "win";
        winnerName = unescape(parts[2] ?? "");
        break;
      case "tie":
        outcome = "tie";
        break;
      default:
        break;
    }

    // Nothing after the result line belongs to the game's scoring.
    if (outcome !== "unfinished") break;
  }

  const side = (id: string): number => teamSizes[id] ?? previewed[id] ?? FALLBACK_TEAM_SIZE;
  const knockedOut = (id: string): number => faints[id] ?? 0;

  // `|win|` names a user, not a side, so map it back through the player lines.
  const winnerSide =
    outcome === "win" && winnerName
      ? (Object.keys(players).find((id) => nameKey(players[id]) === nameKey(winnerName)) ?? null)
      : null;
  const loserSide = winnerSide ? (winnerSide === "p1" ? "p2" : "p1") : null;

  const kosFor = loserSide ? knockedOut(loserSide) : 0;
  const kosAgainst = winnerSide ? knockedOut(winnerSide) : 0;
  const pokemonLeftAlive = winnerSide ? Math.max(0, side(winnerSide) - kosAgainst) : null;
  const loserPokemonLeftAlive = loserSide ? Math.max(0, side(loserSide) - kosFor) : null;
  // A knockout finish needs a named winner and empties the loser's team. A tie,
  // an unfinished log, or a forfeit that cut the game short does not.
  const conclusive = winnerSide !== null && loserPokemonLeftAlive === 0;

  return {
    format: format || null,
    outcome,
    winnerSide,
    loserSide,
    winnerName: winnerName || null,
    players,
    teamSizes,
    kosFor,
    kosAgainst,
    pokemonLeftAlive: conclusive ? pokemonLeftAlive : null,
    koDifferential: conclusive ? kosFor - kosAgainst : null,
    conclusive,
    loserPokemonLeftAlive,
    turnCount,
  };
}

/**
 * Fetches a replay's battle log from Showdown and parses it.
 *
 * @param replayUrl - A Showdown replay link, e.g. `https://replay.pokemonshowdown.com/gen9ou-1`.
 * @param options - Optional `timeoutMs` (default 10s) and `fetchImpl` for tests.
 * @returns The parsed summary of the game.
 * @throws When the link is not a Showdown replay, or the log cannot be fetched.
 */
export async function fetchReplaySummary(
  replayUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ReplaySummary> {
  const logUrl = replayLogUrl(replayUrl);
  const parsed = new URL(logUrl);
  if (parsed.protocol !== "https:" || !ALLOWED_REPLAY_HOSTS.has(parsed.hostname)) {
    throw new Error("That does not look like a Pokemon Showdown replay link.");
  }

  const { timeoutMs = 10_000, fetchImpl = fetch } = options;
  const response = await fetchImpl(parsed.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("That replay could not be found on Pokemon Showdown.");
  }

  const log = await response.text();
  const summary = parseReplayLog(log);
  // Showdown answers unknown replays with a 404 page rendered as HTML.
  if (Object.keys(summary.players).length === 0) {
    throw new Error("That replay could not be read as a Pokemon Showdown battle log.");
  }
  return summary;
}
