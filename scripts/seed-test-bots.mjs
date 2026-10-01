/*
 * Seeds a league with test-bot members that the draft will draft for on its own.
 *
 * The app already has the machinery for this: `is_test_bot_user` treats a member as
 * a bot when their profile name matches 'test bot%', and
 * `ensure_testbot_autopick_flags(season_id)` sets `auto_pick` on every round for
 * every such member. What was missing was any way to get members in there in the
 * first place, so this fills a league up with them.
 *
 * Why auth users and not just rows: `profiles.id` is a foreign key to
 * `auth.users(id)`, so a member cannot exist without an account. Each bot is created
 * through the Supabase admin API, and the `handle_new_user` trigger writes its
 * profile from the `display_name` we pass in `user_metadata` -- which is what makes
 * the draft treat it as a bot, so the name matters and is not cosmetic.
 *
 * The bots never sign in. `advance_bot_autopicks` is called by `start_draft` and by
 * the pick resolver, and it settles a bot's turn directly from that member's round
 * list, falling back to the best available pool Pokemon. A password is still
 * required to create an auth user, so all of them share one generated value that is
 * printed once at the end; treat it as a throwaway.
 *
 * Re-running is safe. An auth user that already exists is skipped rather than
 * duplicated, and every table insert is upserted, so a partial run can be repeated to
 * finish it.
 *
 * Usage:
 *   SUPABASE_SECRET_KEY=... node scripts/seed-test-bots.mjs "TL 2.1" 19
 *
 * The service key is read from the environment and never written anywhere. It is
 * deliberately NOT read from .env.local, so the secret does not have to be pasted
 * into a terminal history or a chat transcript; export it for this one command.
 */

import { randomBytes } from "node:crypto";

const LEAGUE_NAME = process.argv[2] ?? "TL 2.1";
const BOT_COUNT = Number.parseInt(process.argv[3] ?? "19", 10);

/**
 * The email domain for the seeded accounts.
 *
 * `example.com` is used because an existing bot account in the app is already on it,
 * so it is known to satisfy whatever email check the project applies. Swapping this
 * for a real domain is a one-line change if a project blocks disposable domains.
 */
const EMAIL_DOMAIN = "example.com";

/**
 * Names the seeded profiles `Test Bot N`, starting at N.
 *
 * The prefix is load-bearing: `is_test_bot_user` matches on `'test bot%'`, so a
 * profile named anything else would be treated as a human and sit on the clock until
 * its pick timer expired. N starts above the names already in use so a seeded bot is
 * never confused with one from another league.
 */
const FIRST_BOT_NAME = 4;

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

/** Headers for the Supabase admin and REST APIs, which both need the service key. */
function adminHeaders() {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

/** Calls the Supabase admin API and returns the parsed body. */
async function adminApi(path, init) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin${path}`, {
    ...init,
    headers: adminHeaders(),
  });

  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    // The admin API reports a duplicate as 422 with a "already registered" message.
    const message =
      (body && (body.msg || body.message || body.error_description)) ??
      `HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

/** Calls PostgREST and returns the parsed body, failing loudly on a non-2xx. */
async function rest(path, init = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...init.headers,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`PostgREST ${path} failed: HTTP ${response.status} ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

/** Creates one auth user, treating "already exists" as success. */
async function createBotUser(email, password, displayName) {
  try {
    const created = await adminApi("/users", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      }),
    });

    return { id: created.id, created: true };
  } catch (error) {
    // 422 with an "already registered"/"already been registered" message means the
    // account is there from an earlier run. The id is not echoed in the error, so it
    // is looked up by email below rather than parsed out of the response.
    if (error.status === 422) {
      const found = await adminApi(
        `/users?page=1&per_page=1000`,
      ).then((users) => users ?? []);

      const match = (users ?? []).find(
        (user) => user.email?.toLowerCase() === email.toLowerCase(),
      );

      if (match) {
        return { id: match.id, created: false };
      }
    }

    throw error;
  }
}

async function main() {
  console.log(`Seeding test bots into league "${LEAGUE_NAME}"\n`);

  const leagues = await rest(
    "leagues?select=id,name,number_of_players&name=eq." +
      encodeURIComponent(LEAGUE_NAME),
  );

  if (!leagues?.length) {
    throw new Error(
      `No league named "${LEAGUE_NAME}" is visible to the service key. ` +
        "Check the name and that the key belongs to the right project.",
    );
  }

  const league = leagues[0];
  console.log(
    `League: ${league.name}  players=${league.number_of_players}  id=${league.id}`,
  );

  const seasons = await rest(
    "seasons?select=id,season_number,status&league_id=eq." +
      league.id +
      "&order=season_number.desc&limit=1",
  );

  if (!seasons?.length) {
    throw new Error(`League "${LEAGUE_NAME}" has no season to seed against.`);
  }

  const season = seasons[0];
  console.log(
    `Season: #${season.season_number} (${season.status})  id=${season.id}\n`,
  );

  const existingMembers = await rest(
    "league_members?select=user_id&league_id=eq." + league.id,
  );
  const alreadyIn = new Set(
    (existingMembers ?? []).map((member) => member.user_id),
  );

  // One password for every bot, generated per run. They never sign in, so sharing it
  // costs nothing and means a single value to rotate or discard.
  const password = `Tl21!${randomBytes(12).toString("base64url")}`;

  const created = [];
  const skipped = [];

  for (let index = 0; index < BOT_COUNT; index += 1) {
    const sequence = index + 1;
    const displayName = `Test Bot ${FIRST_BOT_NAME + index}`;
    const email = `tl21bot${String(sequence).padStart(2, "0")}@${EMAIL_DOMAIN}`;

    const user = await createBotUser(email, password, displayName);

    if (user.created) {
      created.push(`${displayName} <${email}>`);
    } else {
      skipped.push(`${displayName} <${email}> (account already existed)`);
    }

    if (alreadyIn.has(user.id)) {
      continue;
    }

    /*
     * Members join with no per-member salary override, which leaves them on the
     * league's default budget rather than inventing a second number to keep in sync.
     *
     * draft_position is deliberately left NULL here and filled in as a separate pass
     * below: assigning it per-iteration would number the bots after whatever members
     * already existed, which is not the same thing as a stable order.
     */
    await rest("league_members", {
      method: "POST",
      body: JSON.stringify({
        league_id: league.id,
        user_id: user.id,
        role: "member",
        is_active: true,
      }),
    });

    alreadyIn.add(user.id);
  }

  console.log(`Created ${created.length} auth user(s), skipped ${skipped.length}.`);
  for (const line of skipped) {
    console.log(`  skipped: ${line}`);
  }

  /*
   * No teams are created here. `start_draft` builds them itself from the member
   * rows -- copying team_name off the profile's display name and carrying
   * draft_position and the salary override along -- so seeding teams would only
   * create rows that function then has to work around.
   *
   * It does, however, refuse to run unless every active member already has a
   * draft_position, so that is filled in here. Positions already set are left
   * alone: a league whose order is deliberate should not have it renumbered by a
   * re-run. New members continue from the highest position in use, in join order,
   * which puts the owner first because they joined first.
   */
  const members = await rest(
    "league_members?select=user_id,draft_position,total_token_salary,joined_at&league_id=eq." +
      league.id +
      "&is_active=eq.true&order=joined_at.asc",
  );

  const assigned = (members ?? [])
    .map((member) => member.draft_position)
    .filter((position) => typeof position === "number");
  let nextPosition = assigned.length > 0 ? Math.max(...assigned) + 1 : 1;

  const unpositioned = (members ?? []).filter(
    (member) => member.draft_position == null,
  );

  for (const member of unpositioned) {
    await rest(`league_members?league_id=eq.${league.id}&user_id=eq.${member.user_id}`, {
      method: "PATCH",
      body: JSON.stringify({ draft_position: nextPosition }),
    });
    nextPosition += 1;
  }

  console.log(
    `\nMembers: ${(members ?? []).length}  draft positions filled: ` +
      `${unpositioned.length} (from ${assigned.length > 0 ? Math.max(...assigned) + 1 : 1}).`,
  );

  // Set auto_pick on every round for every member whose profile name marks them as a
  // test bot. This is the app's own function, so the flags it writes are exactly the
  // ones `advance_bot_autopicks` reads. A season trigger does the same thing when the
  // draft starts, so this call just means the flags are already in place.
  await rest(`rpc/ensure_testbot_autopick_flags`, {
    method: "POST",
    body: JSON.stringify({ p_season_id: season.id }),
  });

  const flags = await rest(
    "draft_round_settings?select=user_id,round_number,auto_pick,skip_pick&season_id=eq." +
      season.id,
  );
  const flaggedUsers = new Set((flags ?? []).map((flag) => flag.user_id));
  const stillSkipped = (flags ?? []).filter((flag) => flag.skip_pick).length;

  console.log(
    `\nAuto-pick flags: ${(flags ?? []).length} row(s) across ` +
      `${flaggedUsers.size} member(s), ${stillSkipped} marked skip_pick.`,
  );

  const notFlagged = members.filter(
    (member) => !flaggedUsers.has(member.user_id),
  );
  if (notFlagged.length > 0) {
    console.log(
      `\nWARNING: ${notFlagged.length} member(s) have no auto-pick flag, because ` +
        "is_test_bot_user only matches a profile named 'Test Bot%'. The league " +
        "owner is expected to be one of them.",
    );
  }

  console.log(
    `\nBot account password (throwaway, bots never sign in):\n  ${password}\n`,
  );
  console.log(
    "Remaining step: the draft pool for this league needs in-pool Pokemon before it " +
      "can start. auto_pick_on_timeout is unrelated to bots drafting -- " +
      "advance_bot_autopicks settles a bot's turn from its round list directly.",
  );
}

main().catch((error) => {
  console.error(`\nSeed failed: ${error.message}`);
  process.exit(1);
});
