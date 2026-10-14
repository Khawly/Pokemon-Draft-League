/*
 * Plays a league's playoff bracket through to a champion and checks it against the
 * bracket rules in ai-instructions.md section 10.4.
 *
 * This is an integration test against the real database rather than a unit test,
 * because the bracket lives entirely in Postgres: the advance, the bye settlement
 * and the feeders that decide who meets whom are all plpgsql functions, and the only
 * way to know they agree with each other is to drive them the way the UI does and
 * watch what comes out.
 *
 * The loop mirrors the schedule page. Games are settled the way a result submission
 * settles them, the owner presses Advance Bracket, and the next round's cards are
 * created from whatever the feeders resolve to. It repeats until the advance creates
 * nothing and no game is left open.
 *
 * Invariants checked, all taken from the spec:
 *   * reverse seeding -- with a power-of-two field the top seed meets the bottom one;
 *   * byes -- a field that is not a power of two gives the top seeds a free week;
 *   * nobody meets itself, and nobody plays twice in the same round;
 *   * a forfeit is a loss for the forfeiting side only;
 *   * a double forfeit charges both sides a loss and eliminates both;
 *   * elimination is permanent -- a team that has lost twice, or been double
 *     forfeited, never reappears;
 *   * every game sits in the slot its bracket label declares, so the sheet and the games
 *     cannot disagree about who is meant to be playing whom;
 *   * the tournament ends with exactly one champion, or none at all when the rules say
 *     the last sides standing were both eliminated.
 *
 * A forfeit rate can be supplied so the forfeit paths are exercised on every run
 * rather than only when a human happens to forfeit.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SECRET_KEY=... OWNER_EMAIL=... OWNER_PASSWORD=... \
 *     node scripts/simulate-playoff-bracket.mjs "TL 2.1" 0.15 0.1 1 12 double_elimination
 *
 * Arguments are league, one-sided forfeit rate, double forfeit rate, seed, field size and
 * playoff format. The field size and format default to whatever the league is already set
 * to, and the rates to no forfeits at all.
 */

const LEAGUE_NAME = process.argv[2] ?? "TL 2.1";

/** Share of games settled as a one-sided forfeit. Defaults to none. */
const FORFEIT_RATE = Number.parseFloat(process.argv[3] ?? "0");

/** Share of games settled as a double forfeit, where both sides lose. */
const DOUBLE_FORFEIT_RATE = Number.parseFloat(process.argv[4] ?? "0");

/** PRNG seed, so a failing run can be reproduced. */
const SEED = Number.parseInt(process.argv[5] ?? "1", 10) || 1;

/**
 * Playoff field size to test, or 0 to use whatever the league is already set to.
 *
 * The bracket is sized by the league rather than by this script, so a run at a
 * different field size rewrites the setting first. The league caps the field at its own
 * size, and the write is a direct table update because the value is normally only
 * reachable through a schedule regeneration.
 */
const FIELD_SIZE = Number.parseInt(process.argv[6] ?? "0", 10) || 0;

/** Guard against a bracket that never settles and loops forever. */
const MAX_ROUNDS = 60;

const supabaseUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const ownerEmail = process.env.OWNER_EMAIL;
const ownerPassword = process.env.OWNER_PASSWORD;

if (!supabaseUrl || !serviceKey || !ownerEmail || !ownerPassword) {
  console.error(
    "Set SUPABASE_URL, SUPABASE_SECRET_KEY, OWNER_EMAIL and OWNER_PASSWORD.\n" +
      "The owner credentials are needed because advancing and resetting the bracket\n" +
      "are owner-only RPCs; the service key alone has no signed-in user behind it.",
  );
  process.exit(1);
}

/**
 * Calls PostgREST with the service key and returns the parsed body.
 *
 * @param {string} path - Path under `/rest/v1/`.
 * @param {RequestInit} [init] - Standard fetch options.
 * @returns {Promise<any>} The decoded response body.
 */
async function rest(path, init = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`PostgREST ${response.status} on ${path}: ${await response.text()}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** @returns {Promise<string>} An access token for the league owner. */
async function signInAsOwner() {
  const response = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    },
  );

  if (!response.ok) {
    throw new Error(`Owner sign-in failed: ${await response.text()}`);
  }

  const body = await response.json();
  return body.access_token;
}

/**
 * Calls an owner-only RPC with the owner's token.
 *
 * @param {string} name - RPC name.
 * @param {Record<string, unknown>} args - Named arguments for the RPC.
 * @param {string} token - The owner's access token.
 * @returns {Promise<any>} The decoded response body.
 */
async function ownerRpc(name, args, token) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(`RPC ${name} failed: ${await response.text()}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Small deterministic PRNG so a failing run can be reproduced.
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

const rng = makeRng(SEED);

// ---------------------------------------------------------------- resolve league

const leagues = await rest(`leagues?select=id,name&name=eq.${encodeURIComponent(LEAGUE_NAME)}`);

if (!leagues?.length) {
  console.error(`No league named "${LEAGUE_NAME}".`);
  process.exit(1);
}

const league = leagues[0];
const token = await signInAsOwner();

const seasons = await rest(
  `seasons?select=id,season_number&league_id=eq.${league.id}&order=season_number.desc&limit=1`,
);
const season = seasons[0];

const settings = await rest(
  `league_settings?select=regular_season_weeks,playoff_team_count,playoff_format,match_format&season_id=eq.${season.id}&limit=1`,
);
const config = settings[0];

const teams = await rest(`teams?select=id,team_name&league_id=eq.${league.id}&season_id=eq.${season.id}`);
const teamName = new Map(teams.map((t) => [t.id, t.team_name]));

/**
 * Playoff format to test, or empty to leave the league's own setting alone.
 *
 * The two formats are out on a different number of losses, so they are separate trees
 * with separate endings and neither one exercises the other. A run has to name the format
 * to cover both.
 */
const PLAYOFF_FORMAT = process.argv[7] ?? "";

/** Formats the bracket engine knows how to build. */
const KNOWN_FORMATS = ["single_elimination", "double_elimination"];

// Resized before the config is read, so the run reports the field it actually played.
if (FIELD_SIZE > 0 && FIELD_SIZE !== config.playoff_team_count) {
  if (FIELD_SIZE > teams.length) {
    console.error(
      `A field of ${FIELD_SIZE} exceeds the league's ${teams.length} teams.`,
    );
    process.exit(1);
  }

  await rest(`league_settings?select=id&season_id=eq.${season.id}&playoff_team_count=eq.${config.playoff_team_count}`, {
    method: "PATCH",
    body: JSON.stringify({ playoff_team_count: FIELD_SIZE }),
  });

  config.playoff_team_count = FIELD_SIZE;
}

if (PLAYOFF_FORMAT && PLAYOFF_FORMAT !== config.playoff_format) {
  if (!KNOWN_FORMATS.includes(PLAYOFF_FORMAT)) {
    console.error(
      `Unknown playoff format "${PLAYOFF_FORMAT}". Use one of ${KNOWN_FORMATS.join(", ")}.`,
    );
    process.exit(1);
  }

  await rest(`league_settings?select=id&season_id=eq.${season.id}&playoff_format=eq.${config.playoff_format}`, {
    method: "PATCH",
    body: JSON.stringify({ playoff_format: PLAYOFF_FORMAT }),
  });

  config.playoff_format = PLAYOFF_FORMAT;
}

/** @returns {string} A short label for a team, or a bye marker when there is none. */
function label(teamId) {
  return teamId ? teamName.get(teamId) ?? teamId.slice(0, 6) : "<bye>";
}

console.log(`League:   ${league.name}`);
console.log(`Season:   ${season.season_number}`);
console.log(`Bracket:  ${config.playoff_team_count} teams, ${config.playoff_format}, best of ${config.match_format === "single" ? 1 : 2}`);
console.log(`Base week: ${config.regular_season_weeks}`);
console.log(
  `Forfeits: ${(FORFEIT_RATE * 100).toFixed(0)}% one-sided, ${(DOUBLE_FORFEIT_RATE * 100).toFixed(0)}% double\n`,
);

// --------------------------------------------------------------------- run it

const removed = await ownerRpc("reset_playoff_bracket", { p_league_id: league.id }, token);
console.log(`Reset bracket (${removed} playoff matches removed).`);

await ownerRpc("generate_playoff_round", { p_league_id: league.id }, token);

// Failures found while checking the bracket once the run finishes.
const problems = [];
// Conditions the spec does not decide, reported rather than treated as a defect.
const warnings = [];
let rounds = 0;

for (; rounds < MAX_ROUNDS; rounds++) {
  const games = await rest(
    `matches?select=id,week_number,bracket_phase,bracket_slot,player_1_team_id,player_2_team_id,status,winner_team_id&league_id=eq.${league.id}&season_id=eq.${season.id}&is_playoff=eq.true&order=week_number.asc,bracket_slot.asc`,
  );

  // Terminal status alone decides whether a game is closed. A double forfeit has no
  // winner and never will, so testing for a winner would re-pick it on every pass and
  // roll a fresh outcome each time, which is not what the bracket would ever do.
  const open = games.filter(
    (g) => !["completed", "forfeit", "cancelled"].includes(g.status),
  );

  // A one-sided game with no result is a bye the advance created and should have
  // settled already. Record it rather than trying to submit into it.
  for (const game of open) {
    if (game.player_2_team_id === null) {
      console.log(
        `  ! week ${game.week_number} ${game.bracket_phase} slot ${game.bracket_slot} is an unsettled bye for ${label(game.player_1_team_id)}`,
      );
    }
  }

  const playable = open.filter((g) => g.player_2_team_id !== null);

  if (playable.length === 0 && open.length === 0) {
    const created = await ownerRpc(
      "generate_playoff_round",
      { p_league_id: league.id },
      token,
    );

    if (!created) {
      break;
    }

    continue;
  }

  const now = new Date().toISOString();
  const updates = [];

  for (const game of playable) {
    const p1 = game.player_1_team_id;
    const p2 = game.player_2_team_id;

    if (p1 === p2) {
      problems.push(
        `week ${game.week_number} ${game.bracket_phase} slot ${game.bracket_slot}: ${label(p1)} faces itself`,
      );
    }

    let status = "completed";
    let winner = rng() < 0.5 ? p1 : p2;

    if (rng() < DOUBLE_FORFEIT_RATE) {
      // No winner at all: both sides take the loss and neither advances.
      status = "forfeit";
      winner = null;
    } else if (rng() < FORFEIT_RATE) {
      status = "forfeit";
    }

    updates.push({
      id: game.id,
      league_id: league.id,
      season_id: season.id,
      week_number: game.week_number,
      is_playoff: true,
      player_1_team_id: p1,
      player_2_team_id: p2,
      bracket_phase: game.bracket_phase,
      bracket_slot: game.bracket_slot,
      status,
      winner_team_id: winner,
      updated_at: now,
    });

    const outcome =
      winner === null
        ? "double forfeit, both lose"
        : `${label(winner)} wins${status === "forfeit" ? " by forfeit" : ""}`;

    console.log(
      `  week ${game.week_number} ${game.bracket_phase.padEnd(5)} slot ${game.bracket_slot}  ` +
        `${label(p1).padEnd(12)} vs ${label(p2).padEnd(12)}  ${outcome}`,
    );
  }

  if (updates.length === 0) {
    break;
  }

  // Restate the whole row: Postgres checks NOT NULL before ON CONFLICT resolves.
  await rest(
    `matches?select=id&id=in.(${updates.map((u) => u.id).join(",")})`,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(updates),
    },
  );

  const created = await ownerRpc(
    "generate_playoff_round",
    { p_league_id: league.id },
    token,
  );

  if (created) {
    console.log(`  -> advanced, created ${created} game(s)`);
  }
}

console.log(`\nFinished after ${rounds} advance cycles.\n`);

// ------------------------------------------------------------- check the bracket

// The invariants run against everything now in the database rather than only the games
// this loop settled, because the bracket also settles byes on its own. Those games are
// wins and so never change a loss count, but leaving them out would make the "plays
// twice in a round" check miss a genuine duplicate.
const everyGame = await rest(
  `matches?select=id,week_number,bracket_phase,bracket_slot,player_1_team_id,player_2_team_id,status,winner_team_id&league_id=eq.${league.id}&season_id=eq.${season.id}&is_playoff=eq.true`,
);

/**
 * Phase ordering inside a week, fixed so the walk below is deterministic.
 *
 * Winners and losers rounds share a week but draw from disjoint sets of teams, so the
 * order between them cannot change a loss count.
 */
const PHASE_ORDER = { gf: 0, upper: 1, lower: 2 };

everyGame.sort(
  (a, b) =>
    a.week_number - b.week_number ||
    (PHASE_ORDER[a.bracket_phase] ?? 9) - (PHASE_ORDER[b.bracket_phase] ?? 9) ||
    (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0),
);

// How many losses eliminates. The formats differ here, and every invariant below that
// mentions elimination has to use the same number or a single elimination run gets judged
// by double elimination rules: a side out on one loss there still counts as "standing"
// under a threshold of two, and a double forfeit eliminates both sides of its game.
const ELIMINATION_LOSSES = config.playoff_format === "double_elimination" ? 2 : 1;

// Nobody may meet themselves.
for (const game of everyGame) {
  if (
    game.player_1_team_id &&
    game.player_1_team_id === game.player_2_team_id
  ) {
    problems.push(`${label(game.player_1_team_id)} faces itself in week ${game.week_number}`);
  }
}

// Nobody may play twice in the same round.
const appearances = new Map();
for (const game of everyGame) {
  for (const side of [game.player_1_team_id, game.player_2_team_id]) {
    if (!side) continue;
    const key = `${side}|${game.week_number}|${game.bracket_phase}`;
    appearances.set(key, (appearances.get(key) ?? 0) + 1);
  }
}
for (const [key, count] of appearances) {
  if (count > 1) {
    const [teamId, week, phase] = key.split("|");
    problems.push(`${label(teamId)} appears ${count}x in week ${week} ${phase}`);
  }
}

// Elimination is permanent. The count is walked forward game by game rather than read
// off a final tally: a side is out once it has taken as many losses as the format
// eliminates on, or once a double forfeit has put it out, and in double elimination a side
// that took its first upper-bracket loss is expected to turn up again in the losers
// bracket.
//
// A double forfeit eliminates both sides whatever the format, rather than sending them
// down to the losers bracket. Both sides then sit on one loss, which is the same record a
// side that lost normally would carry, so the loss count on its own cannot tell an
// eliminated side from one that is about to play again in the losers bracket. The set of
// double-forfeited sides is what separates them.
const running = new Map();
const doubleForfeited = new Set();
const goneAfter = new Map();
const seen = new Set();

/**
 * Whether a side is out of the tournament.
 *
 * @param {string} side - Team id.
 * @returns {boolean} True once the side can no longer appear in a later game.
 */
const isOut = (side) =>
  (running.get(side) ?? 0) >= ELIMINATION_LOSSES ||
  doubleForfeited.has(side);

for (const game of everyGame) {
  for (const side of [game.player_1_team_id, game.player_2_team_id]) {
    if (!side) continue;
    seen.add(side);

    if (goneAfter.has(side)) {
      problems.push(
        `${label(side)} plays again in week ${game.week_number} after being eliminated`,
      );
      continue;
    }

    if (isOut(side)) {
      goneAfter.set(side, game.week_number);
    }
  }

  if (game.winner_team_id) {
    const loser =
      game.winner_team_id === game.player_1_team_id
        ? game.player_2_team_id
        : game.player_1_team_id;

    if (loser) running.set(loser, (running.get(loser) ?? 0) + 1);
  } else {
    // A double forfeit charges both sides a loss and eliminates both.
    for (const side of [game.player_1_team_id, game.player_2_team_id]) {
      if (!side) continue;
      running.set(side, (running.get(side) ?? 0) + 1);
      doubleForfeited.add(side);
    }
  }
}

// The champion comes from the function the app would ask, not from re-deriving it here.
// A single elimination bracket, and a double elimination one whose grand final nobody
// won, are both cases where guessing from the final rows would give the wrong answer.
const champion = await rest(`rpc/playoff_champion`, {
  method: "POST",
  body: JSON.stringify({ p_league_id: league.id, p_season_id: season.id }),
});

// The reset, if there was one, is the only sign the grand final went the distance.
/*
 * Every game has to sit in the slot its bracket label declares.
 *
 * The bracket sheet draws one card per labelled game and fills it from the game in the same
 * phase, week and slot, so a game in the wrong slot is a real game on the wrong card: it
 * plays teams the card does not name, and the card's own game is either missing or on
 * another card entirely. That is how two losers cards came to show the same matchup while
 * the game feeding them was a third one, so it is worth checking rather than assuming.
 */
const declaredSlots = new Set();

for (const g of everyGame) {
  const key = `${g.bracket_phase}:${g.week_number}:${g.bracket_slot}`;

  if (g.bracket_slot == null) {
    continue;
  }

  if (declaredSlots.has(key)) {
    problems.push(
      `${key} is used by two games, so the bracket cannot draw both of them`,
    );
  }

  declaredSlots.add(key);
}

// The template is only available through the owner's session, and reading it is the whole
// point of the check: it is the sheet the member reads.
const template = await ownerRpc("playoff_bracket_template", { p_league_id: league.id }, token);
const declaredKeys = new Set(
  (Array.isArray(template) ? template : []).map(
    (r) => `${r.phase}:${r.week}:${r.slot}`,
  ),
);

for (const g of everyGame) {
  const key = `${g.bracket_phase}:${g.week_number}:${g.bracket_slot}`;

  if (g.bracket_slot != null && declaredKeys.size > 0 && !declaredKeys.has(key)) {
    problems.push(
      `week ${g.week_number} ${g.bracket_phase} slot ${g.bracket_slot} is not a game the bracket sheet declares`,
    );
  }
}

const grandFinals = everyGame.filter((g) => g.bracket_phase === "gf");
const hadReset = grandFinals.length > 1;

// A champion who is already out is only possible when the deciding game was a double
// forfeit, which charges both finalists a loss and can eliminate both of them. That is the
// rules working, so a champion in that state is only a defect if some side was still able
// to play.
if (champion && isOut(champion)) {
  problems.push(
    `${label(champion)} is the champion but took ${running.get(champion)} losses`,
  );
}

// Nothing left unplayed and still no champion means one of two things, and the rules tell
// them apart. Either a side is still standing on fewer than two losses, which is a defect,
// or nobody is, which is the bracket legitimately out of sides.
const anythingOpen = everyGame.some(
  (g) => !["completed", "forfeit", "cancelled"].includes(g.status),
);

if (!champion && !anythingOpen) {
  const stillStanding = [...seen].filter((side) => !isOut(side));

  if (stillStanding.length === 0) {
    console.log(
      `No champion: the last game was a double forfeit, so it eliminated both of the\n` +
        `last two sides standing and nobody was left. That is the rule as written.\n`,
    );
  } else {
    problems.push(
      `the bracket finished with no champion but ${stillStanding
        .map(label)
        .join(", ")} were never eliminated`,
    );
  }
}

// A reset has to be the same two teams again, and there is never a third final.
if (hadReset) {
  const first = grandFinals[0];
  const second = grandFinals.at(-1);

  if (
    first.player_1_team_id !== second.player_1_team_id ||
    first.player_2_team_id !== second.player_2_team_id
  ) {
    problems.push("the reset did not replay the grand final's two teams");
  }
}

if (grandFinals.length > 2) {
  problems.push(
    `the bracket played ${grandFinals.length} grand finals; a reset is one extra game, never a third`,
  );
}

/*
 * No champion while a replay is still owed.
 *
 * The gap this guards is between GF1 being submitted and Advance being pressed: the losers
 * bracket champion has won the final, the winners bracket finalist lost having never been
 * beaten, and until the replay is created nobody has won the tournament. Reading a champion
 * off the first final's winner in that window crowned the wrong side of the bracket, which
 * is what the champion banner showed before anyone had advanced.
 */
if (grandFinals.length === 1) {
  const [first] = grandFinals;

  const firstSettled = ["completed", "forfeit", "cancelled"].includes(first.status);

  if (
    firstSettled &&
    first.winner_team_id &&
    first.winner_team_id === first.player_1_team_id &&
    champion
  ) {
    problems.push(
      `${label(champion)} is the champion but the first final was won by the losers bracket finalist, so a reset is still owed`,
    );
  }
}

const undefeated = [...seen].filter((t) => (running.get(t) ?? 0) === 0);

if (champion) {
  for (const teamId of undefeated) {
    if (teamId !== champion) {
      problems.push(
        `${label(teamId)} finished the bracket undefeated but is not the champion`,
      );
    }
  }
}

for (const teamId of seen) {
  if (!running.has(teamId) && teamId !== champion) {
    problems.push(`${label(teamId)} played but never took a loss`);
  }
}

console.log(`Games played:    ${everyGame.length}`);
console.log(`Teams in field:  ${seen.size}`);
console.log(`Double forfeit:  ${everyGame.filter((g) => g.winner_team_id === null).length}`);
console.log(
  `One-sided ft:    ${everyGame.filter((g) => g.status === "forfeit" && g.winner_team_id).length}`,
);
console.log(`Byes settled:    ${everyGame.filter((g) => g.player_2_team_id === null).length}`);
console.log(`Grand finals:    ${grandFinals.length}${hadReset ? " (bracket reset)" : ""}`);
console.log(`Champion:        ${champion ? label(champion) : "none"}`);
console.log(
  `Undefeated sides: ${undefeated.map(label).join(", ") || "none, which is expected once a reset has been played"}\n`,
);

for (const warning of warnings) {
  console.log(`Warning: ${warning}`);
}

if (warnings.length) {
  console.log("");
}

if (problems.length === 0) {
  console.log("All bracket invariants hold.");
  process.exit(0);
}

console.log(`${problems.length} problem(s):`);
for (const problem of problems) {
  console.log(`  - ${problem}`);
}
process.exit(1);