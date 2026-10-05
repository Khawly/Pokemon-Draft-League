/*
 * Draft arena data layer for the Pokemon Draft League.
 *
 * Loads the full live-draft state (league, season, settings, teams, members,
 * pick ledger, pool Pokemon, and the current user's priority list) and exposes
 * the RPC-backed mutations (make/submit picks, resolve timeouts, save priority
 * lists) plus pure helpers the draft UI uses to derive the current turn, the
 * pick deadline, per-team salary, and picked status.
 */
import { supabase } from "@/lib/supabase/client";
import { loadLatestSeason } from "@/lib/supabase/seasons";
import { getPokemonEntryBySlug } from "@/lib/pokeapi";
import { toZonedParts, zonedTimeToInstant } from "@/lib/datetime";

/** Lifecycle status of a season's draft. */
export type DraftStatus =
  | "draft_pending"
  | "draft_active"
  | "draft_complete"
  | "archived";

/** League meta used by the draft arena header. */
export type DraftLeague = {
  id: string;
  name: string;
  owner_id: string;
  number_of_players: number;
};

/** Season row with the timestamps the draft timer derives its deadline from. */
export type DraftSeason = {
  id: string;
  season_number: number;
  status: DraftStatus;
  name: string | null;
  draft_started_at: string | null;
  draft_completed_at: string | null;
  draft_pick_started_at: string | null;
  /** Set while the owner has paused the on-clock pick timer; NULL when running. */
  draft_paused_at: string | null;
};

/** Per-season draft configuration read from league_settings. */
export type DraftSettings = {
  draft_format: "snake" | "set";
  total_rounds: number;
  enable_pokemon_costs: boolean;
  total_token_salary: number | null;
  allow_per_team_salary: boolean;
  pick_time_limit_minutes: number;
auto_pick_on_timeout: boolean;
  skip_player_on_timeout: boolean;
  /** Whether the league holds the draft during a nightly window. */
  quiet_hours_enabled: boolean;
  /** Local wall clock the window opens, `HH:MM`. Null when disabled. */
  quiet_hours_start: string | null;
  /** Local wall clock the window closes, `HH:MM`. Null when disabled. */
  quiet_hours_end: string | null;
  /**
   * The zone the two wall clocks are expressed in.
   *
   * The database columns are still named `_est`, which is historical: nothing ever
   * implemented a fixed Eastern window, so this is whatever zone the owner saved,
   * defaulting to UTC for a league configured before the column existed.
   */
  quiet_hours_timezone: string | null;
};

/** A team slot in the season, with its resolved draft order position. */
export type DraftTeam = {
  id: string;
  owner_user_id: string;
  team_name: string;
  draft_position: number | null;
  total_salary_override: number | null;
};

/** A league member with resolved display name/avatar for the pick cards. */
export type DraftMember = {
  user_id: string;
  role: "owner" | "admin" | "member";
  display_name: string | null;
  avatar_url: string | null;
  /** Draft order slot (1-based), set on the league member pre-start. */
  draft_position: number | null;
};

/** One entry of the pick ledger, joined to its team and picker. */
export type DraftPick = {
  id: string;
  team_id: string;
  owner_user_id: string;
  /**
   * The team's draft-time name snapshot. Not for labelling a person: that is
   * `picker_display_name`, which reads the live profile and so survives a rename.
   */
  team_name: string;
  picker_display_name: string | null;
  round_number: number;
  pick_in_round: number;
  overall_pick: number;
  pokemon_id: string | null;
  species_name: string | null;
  tier_value: number;
  cost_delta: number;
  is_pass: boolean;
  created_at: string;
};

/** A pool Pokemon row enriched with type/BST/gen and derived dex/sprite ids. */
export type DraftPoolRow = {
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  type_primary: string | null;
  type_secondary: string | null;
  bst: number | null;
  generation: string | null;
  dex: number;
  spriteId: number;
};

/**
 * A single Pokemon pinned to a round of the current user's priority list.
 *
 * `auto_pick` / `skip_pick` are the per-round arena toggles the user set in
 * the priority panel (mutually exclusive, both default false). They live on
 * every row of the round band and describe that round's draft behavior: Auto
 * picks the highest-priority Pokemon for the round, Skip passes the round.
 */
export type DraftPriorityEntry = {
  round_number: number;
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  type_primary: string | null;
  type_secondary: string | null;
  bst: number | null;
  /** Dex number for species, 10001+ for alternate forms (drives the sprite). */
  spriteId: number;
  auto_pick: boolean;
  skip_pick: boolean;
};

/**
 * Complete live-draft payload: league/season/settings, members and teams,
 * the pick ledger, draftable pool rows, the current user's priority list, plus
 * the signed-in user's identity for turn checks.
 */
export type DraftGoods = {
  league: DraftLeague;
  season: DraftSeason | null;
  settings: DraftSettings | null;
  members: DraftMember[];
  teams: DraftTeam[];
  picks: DraftPick[];
poolRows: DraftPoolRow[];
  priority: DraftPriorityEntry[];
  /**
   * Token spend per team, from the transaction ledger, keyed by team id.
   *
   * The ledger rather than the pick list, because it is the single authority every
   * other page sums: a draft pick, a free agent pickup and its fee, a release
   * refund, and both sides of a completed trade all land in it. Summing
   * `picks` instead only ever saw the draft, so a balance on the draft board
   * ignored everything that happened after it.
   */
  spentByTeam: Map<string, number>;
  /** Per-round Auto-Pick / Skip-Pick flags for the current user (round key). */
  roundFlags: Map<number, { autoPick: boolean; skipPick: boolean }>;
  currentUserId: string;
  userRole: string | null;
  myTeamId: string | null;
};

/** Derived current-turn landing spot for the draft arena. */
export type DraftSlice = {
  totalRounds: number;
  picksCount: number;
  /** 1-based overall pick number of the upcoming pick (picksCount + 1). */
  overallPick: number;
  roundNumber: number;
  pickInRound: number;
  isSnakeReversal: boolean;
  currentTeam: DraftTeam | null;
  currentMember: DraftMember | null;
  isMyTurn: boolean;
  /** True when the draft has consumed every scheduled pick (or has no teams). */
  isOver: boolean;
};

/** One pool row page; the API caps responses, so the loader pages through. */
const DRAFT_PAGE_SIZE = 1000;

type PoolRowRecord = {
  pokemon_id: string;
  species_name: string;
  tier_value: number;
  type_primary: string | null;
  type_secondary: string | null;
  bst: number | null;
  generation: string | null;
};

type PickLedgerRow = {
  id: string;
  team_id: string;
  round_number: number;
  pick_in_round: number;
  overall_pick: number;
  pokemon_id: string | null;
  species_name: string | null;
  tier_value: number;
  cost_delta: number;
  is_pass: boolean;
  created_at: string;
  teams?: { team_name?: string; owner_user_id?: string } | null;
  profiles?: { display_name?: string | null } | null;
};

/**
 * Loads the complete draft state for a league for the signed-in user.
 *
 * Guards on authentication, fetches the league and latest season, and (when a
 * season exists) resolves settings, teams, members, the pick ledger, the
 * draftable pool rows, and the user's priority list.
 *
 * @param leagueId - The id of the league whose draft to load.
 * @returns A Promise resolving to the assembled {@link DraftGoods}.
 * @throws If the user is not signed in or any core query fails.
 */
export async function loadDraftData(leagueId: string): Promise<DraftGoods> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to view the draft.");
  }

  const { data: league, error: leagueError } = await supabase
    .from("leagues")
    .select("id, name, owner_id, number_of_players")
    .eq("id", leagueId)
    .maybeSingle();

  if (leagueError || !league) {
    throw new Error("This league could not be loaded.");
  }

  const { data: seasonRow, error: seasonError } = await loadLatestSeason<DraftSeason>(
    leagueId,
    "id, season_number, status, name, draft_started_at, draft_completed_at, draft_pick_started_at, draft_paused_at",
  );

  if (seasonError) {
    throw new Error("This league's season could not be loaded.");
  }

  const season = (seasonRow as DraftSeason | null) ?? null;

  const base: DraftGoods = {
    league: {
      id: league.id,
      name: league.name,
      owner_id: league.owner_id,
      number_of_players: league.number_of_players,
    },
    season,
    settings: null,
    members: [],
    teams: [],
    picks: [],
    poolRows: [],
priority: [],
    spentByTeam: new Map<string, number>(),
    roundFlags: new Map<number, { autoPick: boolean; skipPick: boolean }>(),
    currentUserId: user.id,
    userRole: null,
    myTeamId: null,
  };

  if (!season) {
    return base;
  }

const [
    settingsResult,
    teamResult,
    memberResult,
    pickResult,
    poolResult,
    ledgerResult,
  ] = await Promise.all([
      supabase
        .from("league_settings")
        .select(
          "draft_format, total_rounds, enable_pokemon_costs, total_token_salary, allow_per_team_salary, pick_time_limit_minutes, auto_pick_on_timeout, skip_player_on_timeout, quiet_hours_enabled, quiet_hours_start_est, quiet_hours_end_est, quiet_hours_timezone",
        )
        .eq("season_id", season.id)
        .maybeSingle(),
      supabase
        .from("teams")
        .select("id, owner_user_id, team_name, draft_position, total_salary_override")
        .eq("league_id", leagueId)
        .eq("season_id", season.id)
        .order("draft_position", { ascending: true, nullsFirst: false }),
      supabase
        .from("league_members")
        .select("user_id, role, draft_position, profiles: user_id (display_name, avatar_url, timezone)")
        .eq("league_id", leagueId)
        .eq("is_active", true),
      supabase
        .from("draft_picks")
        .select(
          "id, team_id, round_number, pick_in_round, overall_pick, pokemon_id, species_name, tier_value, cost_delta, is_pass, created_at, teams: team_id (team_name, owner_user_id), profiles: user_id (display_name)",
        )
        .eq("league_id", leagueId)
        .order("overall_pick", { ascending: true }),
supabase
        .from("draft_pools")
        .select("id, is_active")
        .eq("league_id", leagueId)
        .eq("season_id", season.id),
      /*
       * The season's whole token ledger, which is what a team's balance is summed
       * from. Fetched by season rather than by team id list because the team rows are
       * read in the same batch and are not available to filter on yet.
       */
      supabase
        .from("transactions")
        .select("team_id, cost_delta")
        .eq("season_id", season.id),
    ]);

  if (
    settingsResult.error ||
    teamResult.error ||
    memberResult.error ||
    pickResult.error
  ) {
    throw new Error("Draft state could not be loaded.");
  }

  const spentByTeam = new Map<string, number>();
  for (const row of (ledgerResult.data ?? []) as {
    team_id: string;
    cost_delta: number;
  }[]) {
    spentByTeam.set(
      row.team_id,
      (spentByTeam.get(row.team_id) ?? 0) + row.cost_delta,
    );
  }

  const settingsRow = settingsResult.data as {
    draft_format: string;
    total_rounds: number;
    enable_pokemon_costs: boolean;
    total_token_salary: number | null;
    allow_per_team_salary: boolean;
    pick_time_limit_minutes: number;
auto_pick_on_timeout: boolean;
    skip_player_on_timeout: boolean;
    quiet_hours_enabled?: boolean | null;
    quiet_hours_start_est?: string | null;
    quiet_hours_end_est?: string | null;
    quiet_hours_timezone?: string | null;
  } | null;

  const settings: DraftSettings | null = settingsRow
    ? {
        draft_format: settingsRow.draft_format === "snake" ? "snake" : "set",
        total_rounds: settingsRow.total_rounds,
        enable_pokemon_costs: settingsRow.enable_pokemon_costs,
        total_token_salary: settingsRow.total_token_salary,
        allow_per_team_salary: settingsRow.allow_per_team_salary,
        pick_time_limit_minutes: settingsRow.pick_time_limit_minutes,
        auto_pick_on_timeout: settingsRow.auto_pick_on_timeout,
        skip_player_on_timeout: settingsRow.skip_player_on_timeout,
        quiet_hours_enabled: Boolean(settingsRow.quiet_hours_enabled),
        quiet_hours_start: settingsRow.quiet_hours_start_est || null,
        quiet_hours_end: settingsRow.quiet_hours_end_est || null,
        quiet_hours_timezone: settingsRow.quiet_hours_timezone || null,
      }
    : null;

  const teams = ((teamResult.data ?? []) as DraftTeam[]).map((team) => ({
    id: team.id,
    owner_user_id: team.owner_user_id,
    team_name: team.team_name,
    draft_position: team.draft_position,
    total_salary_override: team.total_salary_override,
  }));

const memberRows = (memberResult.data ?? []) as {
    user_id: string;
    role: "owner" | "admin" | "member";
    draft_position: number | null;
    profiles?: {
      display_name?: string | null;
      avatar_url?: string | null;
      timezone?: string | null;
    } | null;
  }[];

  const members = memberRows.map((row) => ({
    user_id: row.user_id,
    role: row.role,
    display_name: row.profiles?.display_name ?? null,
    avatar_url: row.profiles?.avatar_url ?? null,
    draft_position: row.draft_position,
  }));

  /*
   * The quiet hours window is anchored to the league owner's own profile zone, so
   * overriding whatever the settings row happens to hold. Read live rather than
   * from league_settings, because draft_quiet_hours resolves it the same way on
   * every sweep: if the two disagreed, the header would state one window while the
   * engine enforced another, which is exactly what made a zone change look like it
   * had done nothing. The stored column remains the fallback for an owner with no
   * usable profile zone.
   */
  if (settings) {
    const ownerZone =
      memberRows.find((row) => row.role === "owner")?.profiles?.timezone ??
      memberRows.find((row) => row.user_id === league.owner_id)?.profiles
        ?.timezone;

    const trimmed = ownerZone?.trim();
    if (trimmed) {
      settings.quiet_hours_timezone = trimmed;
    }
  }

  const picks = ((pickResult.data ?? []) as PickLedgerRow[]).map((row) => ({
    id: row.id,
    team_id: row.team_id,
    owner_user_id: row.teams?.owner_user_id ?? "",
    team_name: row.teams?.team_name ?? "—",
    picker_display_name: row.profiles?.display_name ?? null,
    round_number: row.round_number,
    pick_in_round: row.pick_in_round,
    overall_pick: row.overall_pick,
    pokemon_id: row.pokemon_id,
    species_name: row.species_name,
    tier_value: row.tier_value,
    cost_delta: row.cost_delta,
    is_pass: row.is_pass,
    created_at: row.created_at,
  }));

  // Resolve pool ids (active pool when set, otherwise every pool), then page
  // through the in-pool species rows past the response cap like the pool page.
  const poolRows = (poolResult.data ?? []) as { id: string; is_active: boolean }[];
  const activePools = poolRows.filter((pool) => pool.is_active);
  const poolIds = (activePools.length > 0 ? activePools : poolRows).map(
    (pool) => pool.id,
  );

  const poolPieces: PoolRowRecord[] = [];
  if (poolIds.length > 0) {
    for (let from = 0; ; from += DRAFT_PAGE_SIZE) {
      const { data, error: rowsError } = await supabase
        .from("draft_pool_pokemon")
        .select(
          "pokemon_id, species_name, tier_value, type_primary, type_secondary, bst, generation",
        )
        .in("draft_pool_id", poolIds)
        .eq("is_in_pool", true)
        .order("id", { ascending: true })
        .range(from, from + DRAFT_PAGE_SIZE - 1);

      if (rowsError) {
        throw new Error("The draft pool could not be loaded.");
      }

      const page = (data ?? []) as PoolRowRecord[];
      poolPieces.push(...page);
      if (page.length < DRAFT_PAGE_SIZE) {
        break;
      }
    }
  }

  const poolRowsMapped: DraftPoolRow[] = poolPieces.map((row) => {
    const match = getPokemonEntryBySlug(row.pokemon_id);
    return {
      pokemon_id: row.pokemon_id,
      species_name: row.species_name,
      tier_value: row.tier_value,
      type_primary: row.type_primary,
      type_secondary: row.type_secondary,
      bst: row.bst,
      generation: row.generation,
      dex: match?.dexNumber ?? 0,
      spriteId: match?.spriteId ?? 0,
    };
  });

  // Load the current user's priority list last so a save can be followed by a
  // clean refetch of the normalized order.
  const { data: priorityRows, error: priorityError } = await supabase
    .from("draft_priority_lists")
    .select(
      "round_number, pokemon_id, slot_index, auto_pick, skip_pick",
    )
    .eq("league_id", leagueId)
    .eq("season_id", season.id)
    .eq("user_id", user.id)
    .order("round_number", { ascending: true })
    .order("slot_index", { ascending: true });

  if (priorityError) {
    throw new Error("Your priority list could not be loaded.");
  }

  const poolByPokemon = new Map(
    poolRowsMapped.map((row) => [row.pokemon_id, row]),
  );

  const priority = ((priorityRows ?? []) as {
    round_number: number;
    pokemon_id: string;
    auto_pick: boolean;
    skip_pick: boolean;
  }[]).map((row): DraftPriorityEntry => {
    const poolRow = poolByPokemon.get(row.pokemon_id);
    const catalog = getPokemonEntryBySlug(row.pokemon_id);
    return {
      round_number: row.round_number,
      pokemon_id: row.pokemon_id,
      species_name: poolRow?.species_name ?? catalog?.name ?? row.pokemon_id,
      tier_value: poolRow?.tier_value ?? 0,
      type_primary: poolRow?.type_primary ?? null,
      type_secondary: poolRow?.type_secondary ?? null,
      bst: poolRow?.bst ?? null,
      auto_pick: Boolean(row.auto_pick),
      skip_pick: Boolean(row.skip_pick),
      spriteId: catalog?.spriteId ?? poolRow?.spriteId ?? 0,
    };
  });

  const myTeam = teams.find((team) => team.owner_user_id === user.id);

  // Load the current user's per-round Auto/Skip flags (they live independent of
  // the priority list, so they survive empty rounds).
  const { data: roundFlagRows, error: roundFlagError } = await supabase
    .from("draft_round_settings")
    .select("round_number, auto_pick, skip_pick")
    .eq("season_id", season.id)
    .eq("user_id", user.id);

  if (roundFlagError) {
    throw new Error("Your round settings could not be loaded.");
  }

  const roundFlags = new Map<number, { autoPick: boolean; skipPick: boolean }>(
    (roundFlagRows ?? []).map((row) => [
      row.round_number,
      { autoPick: Boolean(row.auto_pick), skipPick: Boolean(row.skip_pick) },
    ]),
  );

  return {
    ...base,
    settings,
    members,
    teams,
    picks,
poolRows: poolRowsMapped,
    priority,
    spentByTeam,
    roundFlags,
    userRole: members.find((member) => member.user_id === user.id)?.role ?? null,
    myTeamId: myTeam?.id ?? null,
  };
}

/**
 * Submits a pick (or a pass with a null pokemon) for the currently on-turn team.
 *
 * @param leagueId - The league whose draft is being picked from.
 * @param pokemonId - The slug of the Pokemon to draft, or null to pass.
 * @returns A Promise resolving to the new pick/status result payload.
 * @throws If the database rejects the pick (not your turn, not in the pool,
 *   already drafted, or salary would go negative).
 */
export async function submitDraftPick(
  leagueId: string,
  pokemonId: string | null,
): Promise<{ season_id: string; status: string }> {
  const { data, error } = await supabase.rpc("make_draft_pick", {
    p_league_id: leagueId,
    p_pokemon_id: pokemonId,
  });

  if (error) {
    throw new Error(error.message || "Unable to record that pick.");
  }

  return data as { season_id: string; status: string };
}

/**
 * Asks the database to advance the draft when the on-turn player's timer has
 * expired (or is forced), auto-picking or passing per the league settings.
 *
 * @param leagueId - The league whose draft should resolve.
 * @param force - When true, advance immediately regardless of the deadline.
 * @returns A Promise resolving to the resulting status ("not_due" or a season
 *   status), or throwing when the draft is not active.
 */
export async function resolveDraftTimeout(
  leagueId: string,
  force = false,
): Promise<{ season_id: string; status: string }> {
  const { data, error } = await supabase.rpc("resolve_draft_timeout", {
    p_league_id: leagueId,
    p_force: force,
  });

  if (error) {
    throw new Error(error.message || "Unable to resolve the pick timer.");
  }

  return (data as { season_id: string; status: string }[])[0];
}

/**
 * Pauses or resumes the current pick timer for a league's active draft.
 *
 * Owner-only RPC. While paused the timer is frozen (deadlines do not expire,
 * no auto-pick/pass fires); resuming shifts the start stamp forward by the
 * elapsed pause so the pick keeps its full time budget.
 *
 * @param leagueId - The league whose draft timer to toggle.
 * @param paused - True to pause the timer, false to resume it.
 * @returns The season id, status, and the resulting draft_paused_at value.
 * @throws If the caller is not the league owner or the draft is not active.
 */
export async function setDraftPaused(
  leagueId: string,
  paused: boolean,
): Promise<{
  season_id: string;
  status: string;
  draft_paused_at: string | null;
}> {
  const { data, error } = await supabase.rpc("set_draft_paused", {
    p_league_id: leagueId,
    p_paused: paused,
  });

  if (error) {
    throw new Error(error.message || "Unable to update the draft timer.");
  }

  return (data as {
    season_id: string;
    status: string;
    draft_paused_at: string | null;
  }[])[0];
}

/**
 * Returns the latest season of a league to its pre-draft state.
 *
 * Owner-only RPC; it clears the auto-created team mirror, pick ledger,
 * rosters, and transactions for the season and flips it back to
 * `draft_pending` so the order can be re-arranged and the draft started again.
 *
 * Priority lists are restored rather than cleared: the server snapshots every
 * player's list when the draft starts (the draft consumes those lists as picks
 * land) and puts them back here, so a reset does not throw away a list the
 * league built. A season started before snapshots existed has none to restore
 * from, and its lists are left cleared.
 *
 * @param leagueId - The league whose latest season should be reset.
 * @returns A promise resolving to the season id and its new status.
 * @throws If the caller is not the league owner, no season exists, or the
 *   reset fails.
 */
export async function resetDraft(
  leagueId: string,
): Promise<{ season_id: string; status: string }> {
  const { data, error } = await supabase.rpc("reset_draft", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message || "Unable to reset the draft.");
  }

  return (data as { season_id: string; status: string }[])[0];
}

/**
 * Persists the current user's priority list from an ordered entry payload.
 *
 * @param leagueId - The league the list belongs to.
 * @param entries - Ordered {round_number, pokemon_id} entries; slot order
 *   within a round is normalized by the database.
 * @returns A Promise resolving to the number of entries saved.
 * @throws If the payload has duplicates within a round or lists Pokemon that
 *   are not in the season's draft pool.
 */
export async function savePriorityList(
  leagueId: string,
  entries: { round_number: number; pokemon_id: string }[],
): Promise<number> {
  const { data, error } = await supabase.rpc("save_priority_list", {
    p_league_id: leagueId,
    p_entries: entries,
  });

  if (error) {
    throw new Error(error.message || "Unable to save your priority list.");
  }

  return (data as number) ?? 0;
}

/**
 * Persists the mutually-exclusive auto-pick / skip-pick toggles for a single
 * round of the current user's priority list.
 *
 * The DB RPC (`set_priority_round_flags`) flips the flags on every priority
 * row in the user's round band and rejects the call if both flags are passed
 * as TRUE. The UI enforces exclusivity before it invokes this wrapper.
 *
 * @param leagueId - The league whose priority round is being toggled.
 * @param roundNumber - The round number to flag (1-based).
 * @param autoPick - TRUE to auto-pick this round, FALSE otherwise.
 * @param skipPick - TRUE to skip this round, FALSE otherwise. Supplying both
 * TRUE throws from the RPC; callers must pass at most one TRUE.
 */
export async function setPriorityRoundFlags(
  leagueId: string,
  roundNumber: number,
  autoPick: boolean,
  skipPick: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_priority_round_flags", {
    p_league_id: leagueId,
    p_round_number: roundNumber,
    p_auto_pick: autoPick,
    p_skip_pick: skipPick,
  });

  if (error) {
    throw new Error(error.message || "Unable to update this round's flags.");
  }
}

/**
 * Derives the current turn and pick metadata from the loaded draft state.
 *
 * Uses snake order (reversed on even-numbered rounds) per the league's draft
 * format setting; "set" format keeps the same order every round.
 *
 * @param goods - The loaded draft state.
 * @returns The resolved {@link DraftSlice} (current round, pick, team, turn).
 */
export function computeDraftSlice(goods: DraftGoods): DraftSlice {
  const totalRounds = goods.settings?.total_rounds ?? 1;
  const teamsCount = goods.teams.length;
  const picksCount = goods.picks.length;
  const overallPick = picksCount + 1;
  const isOver = teamsCount <= 0 || overallPick > teamsCount * totalRounds;

  let roundNumber = 0;
  let pickInRound = 0;
  let isSnakeReversal = false;
  let currentTeam: DraftTeam | null = null;

  if (!isOver) {
    roundNumber = Math.floor((overallPick - 1) / teamsCount) + 1;
    pickInRound = ((overallPick - 1) % teamsCount) + 1;
    isSnakeReversal =
      goods.settings?.draft_format === "snake" && roundNumber % 2 === 0;
    const effectiveSlot = isSnakeReversal
      ? teamsCount - pickInRound + 1
      : pickInRound;
    currentTeam =
      goods.teams.find((team) => team.draft_position === effectiveSlot) ?? null;
  }

  const currentMember = currentTeam
    ? (goods.members.find((member) => member.user_id === currentTeam.owner_user_id) ??
      null)
    : null;

  return {
    totalRounds,
    picksCount,
    overallPick,
    roundNumber,
    pickInRound,
    isSnakeReversal,
    currentTeam,
    currentMember,
    isMyTurn:
      currentTeam != null && currentTeam.owner_user_id === goods.currentUserId,
    isOver,
  };
}

/**
 * Computes a team's salary budget, spent, and remaining for the draft.
 *
 * The Pokemon "cost" is its tier value; budgets come from the league settings
 * (or a per-team override when enabled) and are only meaningful when costs are
 * enabled. When costs are disabled, remaining salary is effectively unlimited.
 *
 * Spend is the team's transaction ledger sum, matching the trades, teams, and
 * Pokemon pages. Summing `draft_picks` was only ever correct while the draft was
 * the sole thing that could move a balance: it sees the picks and nothing else,
 * so a free agent pickup, its fee, a release refund, or a completed trade left
 * the board quoting a budget that no other page agreed with. The pick list stays
 * as the fallback for a season whose ledger has not been written yet, matching
 * how the teams page falls back to roster tiers.
 *
 * @param goods - The loaded draft state.
 * @param teamId - The team to evaluate.
 * @returns Budget, spent, and remaining salary amounts.
 */
export function getTeamSalary(goods: DraftGoods, teamId: string): {
  budget: number;
  spent: number;
  remaining: number;
} {
  if (!goods.settings?.enable_pokemon_costs) {
    return { budget: 0, spent: 0, remaining: Number.POSITIVE_INFINITY };
  }

  const team = goods.teams.find((candidate) => candidate.id === teamId);
  const usesOverride =
    goods.settings.allow_per_team_salary &&
    team?.total_salary_override != null;
  const budget = usesOverride
    ? (team?.total_salary_override ?? 0)
    : (goods.settings.total_token_salary ?? 0);

  const fromPicks = goods.picks
    .filter((pick) => pick.team_id === teamId)
    .reduce((sum, pick) => sum + pick.cost_delta, 0);
  const spent = goods.spentByTeam.get(teamId) ?? fromPicks;

  return { budget, spent, remaining: budget - spent };
}

/**
 * Reports whether a pool Pokemon has already been drafted this season.
 *
 * @param goods - The loaded draft state.
 * @param pokemonId - The slug to check.
 * @returns True when any pick claimed the Pokemon.
 */
export function isPokemonPicked(goods: DraftGoods, pokemonId: string): boolean {
  return goods.picks.some((pick) => pick.pokemon_id === pokemonId);
}

/**
 * Computes the current pick's deadline in epoch milliseconds.
 *
 * @param goods - The loaded draft state.
 * @returns The deadline timestamp, or null when no pick timer is running (no
 *   start stamp, the draft is not active, or the timer is paused).
 */
export function getPickDeadlineMs(goods: DraftGoods): number | null {
  const start = goods.season?.draft_pick_started_at;
  if (
    !start ||
    goods.season?.status !== "draft_active" ||
    goods.season?.draft_paused_at != null
  ) {
    return null;
  }

const minutes = goods.settings?.pick_time_limit_minutes ?? 5;
  return new Date(start).getTime() + minutes * 60_000;
}

/** The league's quiet hours window, resolved into something displayable. */
export type QuietHoursWindow = {
  /** True when the league has the window switched on with usable clocks. */
  enabled: boolean;
  /**
   * The window expressed in `toZone`, formatted for display, e.g. `8:00 PM – 5:00 AM`.
   * Null when the window is off or its clocks are unusable.
   */
  label: string | null;
  /** The zone the two clocks are stored in, for showing alongside the label. */
  zone: string | null;
  /** True when `now` falls inside the window in the stored zone. */
  activeNow: boolean;
};

/**
 * Minutes since midnight for an `HH:MM` clock, or null when it will not parse.
 *
 * Mirrors `formatClock`'s tolerance of `24:00`, which the availability windows use
 * to mean midnight.
 *
 * @param clock - The stored clock string.
 * @returns Minutes past midnight, or null.
 */
function clockMinutes(clock: string | null): number | null {
  if (!clock) {
    return null;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * Formats an absolute instant as a clock time in the given zone.
 *
 * @param instant - The instant to render.
 * @param zone - The IANA zone to render it in.
 * @returns A localized time string, e.g. `8:00 PM`.
 */
function formatClockInZone(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  }).format(instant);
}

/**
 * Renders one of the stored wall clocks as it reads in the reader's own zone.
 *
 * A real conversion, not a relabelling: "20:00" in the league's zone is a wall
 * clock that only becomes an instant once a date is attached, so the stored zone's
 * current date anchors it and the resulting instant is then rendered in the
 * reader's zone. Formatting the number as typed would have looked right while
 * never changing with the reader, which is the whole thing the label is for.
 *
 * Falls back to the clock as the owner typed it when it falls in a DST
 * spring-forward gap, where the wall time does not exist and there is no instant
 * to convert.
 *
 * @param minutes - Minutes past midnight in the stored zone.
 * @param anchorDate - `YYYY-MM-DD` in the stored zone, used to place the clock.
 * @param storedZone - The zone the clock is expressed in.
 * @param toZone - The zone to render the result in.
 * @returns A localized time string.
 */
function renderStoredClock(
  minutes: number,
  anchorDate: string,
  storedZone: string,
  toZone: string,
): string {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mins = String(minutes % 60).padStart(2, "0");

  const instant = zonedTimeToInstant(anchorDate, `${hours}:${mins}`, storedZone);
  if (instant) {
    return formatClockInZone(instant, toZone);
  }

  // No such wall time today (DST gap): show what the owner entered, unconverted.
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, 0, minutes)));
}

/**
 * Resolves the league's quiet hours for display.
 *
 * The stored clocks are wall times in the league's configured zone, so this
 * re-labels them into whatever zone the reader is looking in: a member in Europe
 * sees the same window as `9:00 PM – 6:00 AM` rather than the owner's `3:00 PM –
 * 12:00 PM`. `activeNow` deliberately stays in the stored zone, because that is the
 * one the database decides the window in and a reader's own clock must not be able
 * to disagree with it about whether the draft is currently held.
 *
 * @param goods - The loaded draft state.
 * @param toZone - The zone to render the label in, normally the viewer's.
 * @param now - The instant to test against the window. Defaults to the current time.
 * @returns The window's display state.
 */
export function resolveQuietHours(
  goods: DraftGoods,
  toZone: string,
  now: Date = new Date(),
): QuietHoursWindow {
  const settings = goods.settings;
  const zone = settings?.quiet_hours_timezone || null;
  const startMinutes = clockMinutes(settings?.quiet_hours_start ?? null);
  const endMinutes = clockMinutes(settings?.quiet_hours_end ?? null);

  const off: QuietHoursWindow = {
    enabled: false,
    label: null,
    zone,
    activeNow: false,
  };

  if (
    !settings?.quiet_hours_enabled ||
    startMinutes == null ||
    endMinutes == null
  ) {
    return off;
  }

  /*
   * Equal bounds would be a window that is either always open or never open. The
   * database reads it as never, so this does too rather than showing a 24-hour
   * quiet period the engine would not honour.
   */
  if (startMinutes === endMinutes) {
    return off;
  }

  const storedZone = zone ?? "UTC";
  const localNow = toZonedParts(now, storedZone);

  const label = `${renderStoredClock(startMinutes, localNow?.date ?? "", storedZone, toZone)} – ${renderStoredClock(endMinutes, localNow?.date ?? "", storedZone, toZone)}`;

  /*
   * Active-now stays in the stored zone. That is the one the database decides the
   * window in, so a reader's own clock must not be able to disagree with the
   * engine about whether the draft is currently held.
   */
  const localMinutes =
    localNow == null
      ? null
      : Number(localNow.time.slice(0, 2)) * 60 + Number(localNow.time.slice(3, 5));

  let activeNow = false;
  if (localMinutes != null) {
    activeNow =
      startMinutes < endMinutes
        ? localMinutes >= startMinutes && localMinutes < endMinutes
        : localMinutes >= startMinutes || localMinutes < endMinutes;
  }

  return { enabled: true, label, zone, activeNow };
}