/*
 * Fills a season's regular season with results, so every team carries a record and a
 * KO differential and the standings tab has something real to rank.
 *
 * Why this exists: `generate_schedule` deletes every match for the season and lets the
 * results cascade with them. There is no undo, so once a schedule is regenerated the
 * standings are blank and the playoff seeds are drawn from teams with no record at all.
 * Re-seeding the regular season is the cheapest way back to a league you can keep
 * testing the bracket in, and this does it repeatably.
 *
 * How the results are produced:
 *   * every team gets a hidden strength rating, so the table has a believable ordering
 *     rather than a flat coin flip across twenty teams;
 *   * a match is won by the higher-rated team with an Elo-style probability, which
 *     still produces upsets, so a seeded bracket is not simply the rating order;
 *   * games are written to `match_results`, one row per game, because that table is
 *     where `season_standings` reads the differential from;
 *   * a slice of matches are recorded as one-sided forfeits with no game rows at all,
 *     which is what `season_standings` charges the maximum negative differential for.
 *
 * The KO differential is signed per game from the winner's surviving Pokemon: the
 * winner is credited that many, the loser debited the same. Games are ordered so the
 * series always ends on its last game, which is what keeps a best-of-three consistent
 * with the match status it is written under.
 *
 * Playoff matches are never touched. Re-seeding the regular season leaves an existing
 * bracket intact, and `reset_playoff_bracket` is the separate, deliberate way to drop
 * one.
 *
 * Re-running is safe. Results for the regular season are deleted before being rewritten
 * rather than merged into, so a partial run can be repeated and a different seed
 * produces a different season.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/seed-standings-results.mjs "TL 2.1" 7
 */

const LEAGUE_NAME = process.argv[2] ?? "TL 2.1";

/** Seed for the strength draw and the match outcomes, so a run can be reproduced. */
const SEED = Number.parseInt(process.argv[3] ?? "1", 10) || 1;

/** Share of matches recorded as a one-sided forfeit rather than a played series. */
const FORFEIT_RATE = 0.12;

/** Bounds of the hidden strength draw. A wider spread separates the seeds further. */
const RATING_MIN = -3;
const RATING_MAX = 3;

const supabaseUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error(
    "Set SUPABASE_URL and SUPABASE_SECRET_KEY before running this script.\n" +
      "The service key is read from the environment on purpose; do not put it in .env.local.",
  );
  process.exit(1);
}

/** Headers for PostgREST, which needs the service key to bypass RLS. */
function restHeaders() {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
}

/**
 * Calls PostgREST and returns the parsed body, failing loudly on a non-2xx.
 *
 * @param {string} path - Path under `/rest/v1/`.
 * @param {RequestInit} [init] - Standard fetch options.
 * @returns {Promise<any>} The decoded response body.
 */
async function rest(path, init = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders(), ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PostgREST ${response.status} on ${path}: ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Small deterministic PRNG, so the same seed rebuilds the same season.
 *
 * @param {number} seed - Integer seed.
 * @returns {() => number} Generator returning floats in [0, 1).
 */
function makeRng(seed) {
  let state = seed >>> 0;

  return function next() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Elo-style expected score for a team against another.
 *
 * @param {number} ratingA - Rating of the team under test.
 * @param {number} ratingB - Rating of its opponent.
 * @returns {number} Probability that A wins, between 0 and 1.
 */
function winProbability(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 4));
}

/**
 * Picks an integer in [min, max] inclusive.
 *
 * @param {() => number} rng - PRNG generator.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} A random integer within the bounds.
 */
function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

const rng = makeRng(SEED);

// ---------------------------------------------------------------- resolve league

const leagues = await rest(
  `leagues?select=id,name,owner_id&name=eq.${encodeURIComponent(LEAGUE_NAME)}`,
);

if (!leagues || leagues.length === 0) {
  console.error(`No league named "${LEAGUE_NAME}".`);
  process.exit(1);
}

const league = leagues[0];

const seasons = await rest(
  `seasons?select=id,season_number,status&league_id=eq.${league.id}&order=season_number.desc&limit=1`,
);

if (!seasons || seasons.length === 0) {
  console.error(`League "${LEAGUE_NAME}" has no seasons.`);
  process.exit(1);
}

const season = seasons[0];

const settings = await rest(
  `league_settings?select=regular_season_weeks,match_format,league_format,playoff_team_count&season_id=eq.${season.id}&limit=1`,
);

if (!settings || settings.length === 0) {
  console.error(`Season ${season.season_number} has no league settings.`);
  process.exit(1);
}

const config = settings[0];

/** Games a team must win to take a match, from the season's match format. */
const gamesToWin = config.match_format === "single" ? 1 : 2;

/** Pokemon per team, which bounds a game's surviving count and the forfeit penalty. */
const teamSize = config.league_format === "4v4" ? 4 : 6;

console.log(`League:    ${league.name}`);
console.log(`Season:    ${season.season_number} (${season.status})`);
console.log(`Format:    ${config.league_format}, ${config.match_format} (first to ${gamesToWin})`);
console.log(`Playoffs:  ${config.playoff_team_count} teams`);
console.log(`Seed:      ${SEED}\n`);

// ------------------------------------------------------------- load teams, games

const teams = await rest(
  `teams?select=id,team_name,draft_position&league_id=eq.${league.id}&season_id=eq.${season.id}&order=draft_position.asc`,
);

if (!teams || teams.length < 2) {
  console.error(`League "${LEAGUE_NAME}" needs at least two teams.`);
  process.exit(1);
}

/** Hidden strength per team id. Draw order follows draft position so it is stable. */
const ratings = new Map(
  teams.map((team) => [team.id, RATING_MIN + rng() * (RATING_MAX - RATING_MIN)]),
);

// Every column is read back because the upsert below has to restate the whole row;
// see the NOT NULL note there.
const matches = await rest(
  `matches?select=id,league_id,season_id,week_number,is_playoff,player_1_team_id,player_2_team_id,scheduled_at,status,winner_team_id,notes,bracket_phase,forfeited_by_user_id,bracket_slot&league_id=eq.${league.id}&season_id=eq.${season.id}&is_playoff=eq.false&order=week_number.asc`,
);

if (!matches || matches.length === 0) {
  console.error(
    "This season has no regular-season matches. Generate a schedule first.",
  );
  process.exit(1);
}

// ------------------------------------------------------------------ clear a run

// Results are removed rather than merged into, so re-running replaces the season
// outright instead of accumulating a second set of rows against the same match.
const matchIds = matches.map((m) => m.id);
await rest(`match_results?match_id=in.(${matchIds.join(",")})`, {
  method: "DELETE",
});

console.log(`Cleared previous results for ${matchIds.length} regular-season matches.`);

// --------------------------------------------------------------- write new games

/** Rows to insert, batched at the end so the run makes a handful of round trips. */
const resultRows = [];
const matchUpdates = [];

for (const match of matches) {
  const ratingA = ratings.get(match.player_1_team_id);
  const ratingB = ratings.get(match.player_2_team_id);

  // Flipping the pair before the draw is what makes the coin flip independent of
  // which side the generator happened to list a team on.
  const p1Wins = rng() < winProbability(ratingA, ratingB);
  const winnerId = p1Wins ? match.player_1_team_id : match.player_2_team_id;
  const loserId = p1Wins ? match.player_2_team_id : match.player_1_team_id;

  // A forfeit carries no game rows at all; season_standings charges the loser the
  // season's worst differential directly from the match row.
  if (rng() < FORFEIT_RATE) {
    matchUpdates.push({ ...match, status: "forfeit", winner_team_id: winnerId });
    continue;
  }

  // How many games the loser takes. Capped so the series cannot outlast its format.
  const loserGames = gamesToWin === 1 ? 0 : randomInt(rng, 0, 1);
  const totalGames = gamesToWin + loserGames;

  // The winner must reach gamesToWin on the final game, so that game is always theirs
  // and the remaining games carry the loserGames spread between them.
  const schedule = [];
  let loserRemaining = loserGames;

  for (let game = 1; game < totalGames; game++) {
    const takeLoss = loserRemaining > 0 && rng() < 0.5;
    schedule.push(takeLoss ? loserId : winnerId);
    if (takeLoss) loserRemaining -= 1;
  }

  while (schedule.length < totalGames - 1) {
    schedule.push(winnerId);
  }

  schedule.push(winnerId);

  for (let game = 1; game <= totalGames; game++) {
    const gameWinner = schedule[game - 1];

    resultRows.push({
      match_id: match.id,
      reporter_user_id: league.owner_id,
      winner_team_id: gameWinner,
      game_number: game,
      // A stronger side tends to sweep more of the board; the floor of 1 keeps a
      // win from ever reading as a zero-KO game.
      pokemon_left_alive: randomInt(
        rng,
        1,
        Math.max(1, Math.round(teamSize / 2 + rng() * (teamSize / 2))),
      ),
      is_manual: true,
    });
  }

  matchUpdates.push({
    ...match,
    status: "completed",
    winner_team_id: winnerId,
  });
}

// PostgREST reads a bare array body as a bulk insert, so updating many rows by
// primary key is done as an upsert: the ids are filtered in the query and
// resolution=merge-duplicates turns the insert into an update on conflict.
//
// The payload repeats every NOT NULL column rather than just the ones changing.
// Postgres validates NOT NULL while building the candidate tuple, which happens
// before ON CONFLICT resolves, so a payload carrying only `id` and `status` fails
// on league_id being null even though the conflict would have merged it away.
const now = new Date().toISOString();

await rest(
  `matches?select=id&season_id=eq.${season.id}&is_playoff=eq.false&id=in.(${matchIds.join(",")})`,
  {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(
      matchUpdates.map((m) => ({
        id: m.id,
        league_id: m.league_id,
        season_id: m.season_id,
        week_number: m.week_number,
        is_playoff: m.is_playoff,
        player_1_team_id: m.player_1_team_id,
        player_2_team_id: m.player_2_team_id,
        scheduled_at: m.scheduled_at,
        status: m.status,
        winner_team_id: m.winner_team_id,
        notes: m.notes,
        bracket_phase: m.bracket_phase,
        forfeited_by_user_id: m.forfeited_by_user_id,
        bracket_slot: m.bracket_slot,
        updated_at: now,
      })),
    ),
  },
);

// PostgREST batches inserts through a single POST carrying an array.
for (let i = 0; i < resultRows.length; i += 200) {
  await rest("match_results", {
    method: "POST",
    body: JSON.stringify(resultRows.slice(i, i + 200)),
  });
}

const forfeits = matchUpdates.filter((m) => m.status === "forfeit").length;

console.log(
  `Wrote ${matchUpdates.length} results (${matchUpdates.length - forfeits} played, ${forfeits} forfeits) and ${resultRows.length} game rows.\n`,
);

// ---------------------------------------------------------------------- preview

// season_standings is the same read the Standings tab uses, so this preview is the
// table the owner will actually see rather than an approximation of it. It is a
// SECURITY DEFINER function that still checks auth.uid(), which a service-key call
// does not carry, so it is treated as optional.
let standings = null;

try {
  standings = await rest(`rpc/season_standings`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ p_league_id: league.id }),
  });
} catch (error) {
  console.log(`No standings preview: ${error.message}`);
}

if (!standings || standings.length === 0) {
  console.log("Open the Standings tab to see the result.");
  process.exit(0);
}

const inField = standings.length <= config.playoff_team_count;

console.log(
  `Rank  Team                          W-L      KO Diff   ${inField ? "Seed" : ""}`,
);
console.log("-".repeat(inField ? 58 : 48));

standings.forEach((row, index) => {
  const seed = index < config.playoff_team_count ? `  ${index + 1}` : "";
  console.log(
    `${String(index + 1).padStart(4)}  ${row.team_name.padEnd(28).slice(0, 28)}  ` +
      `${String(row.wins).padStart(2)}-${String(row.losses).padEnd(2)}   ` +
      `${String(row.ko_diff).padStart(5)}   ${seed}`,
  );
});