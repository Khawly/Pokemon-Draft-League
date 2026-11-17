/*
 * League member reads and writes for the members settings page.
 *
 * Assembles the roster with each member's season salary, the league's salary
 * defaults, the edit history, and the caller's role, and owns the role and
 * membership writes the page performs.
 */
import { getSelectedSeason } from "@/lib/season-selection";
import { supabase } from "@/lib/supabase/client";
import { loadSeason } from "@/lib/supabase/seasons";

/** A league member row with resolved profile fields and season salary. */
export interface MemberRow {
  user_id: string;
  role: "owner" | "admin" | "member";
  joined_at: string | null;
  display_name: string | null;
  avatar_url: string | null;
  avatar_initials: string | null;
  name_color: string | null;
  total_token_salary: number | null;
}

/** One recorded salary change, enriched with both members' names. */
export interface SalaryEditRow {
  id: string;
  user_id: string;
  previous_salary: number | null;
  new_salary: number;
  changed_by: string;
  created_at: string;
  member_name: string | null;
  member_color: string | null;
  editor_name: string | null;
  editor_color: string | null;
}

/** Everything the members settings page needs for one league-season. */
export interface MembersPageData {
  league: { id: string; name: string; owner_id: string };
  season: { id: string; season_number: number; name: string | null };
  allowPerTeamSalary: boolean;
  defaultTotalTokenSalary: number;
  members: MemberRow[];
  salaryHistory: SalaryEditRow[];
  currentUserRole: "owner" | "admin" | "member" | null;
}

/**
 * Turns a raw membership row plus its profile into the row the page renders.
 *
 * @param member - The membership row.
 * @param salaryByOwner - Season salary overrides keyed by member id.
 * @param allowPerTeamSalary - Whether the league uses per-team salaries.
 * @param defaultSalary - The season's default salary.
 * @returns The normalized member row.
 */
function toMemberRow(
  member: {
    user_id: string;
    role: string | null;
    joined_at: string | null;
    profiles: unknown;
  },
  salaryByOwner: Map<string, number | null>,
  allowPerTeamSalary: boolean,
  defaultSalary: number,
): MemberRow {
  const profile = member.profiles as {
    display_name?: string | null;
    avatar_url?: string | null;
    avatar_initials?: string | null;
    name_color?: string | null;
  } | null;

  const seasonOverride = salaryByOwner.get(member.user_id);

  return {
    user_id: member.user_id,
    role: (member.role as "owner" | "admin" | "member") || "member",
    joined_at: member.joined_at,
    display_name: profile?.display_name || "Member",
    avatar_url: profile?.avatar_url || null,
    avatar_initials: profile?.avatar_initials ?? null,
    name_color: profile?.name_color ?? null,
    total_token_salary:
      typeof seasonOverride === "number"
        ? seasonOverride
        : allowPerTeamSalary
          ? defaultSalary
          : null,
  };
}

/**
 * Loads one season's salary edit history, newest first.
 *
 * Names are resolved with a second query rather than an embedded join because
 * both foreign keys point at `profiles`; the separate lookup stays readable and
 * still shows a member who has since left the league.
 *
 * @param leagueId - League whose history to read.
 * @param seasonId - Season whose edits to read.
 * @returns The edits with display names and colours attached.
 */
export async function loadSalaryEditHistory(
  leagueId: string,
  seasonId: string,
): Promise<SalaryEditRow[]> {
  const { data, error } = await supabase
    .from("member_salary_edits")
    .select("id, user_id, previous_salary, new_salary, changed_by, created_at")
    .eq("league_id", leagueId)
    .eq("season_id", seasonId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error || !data) {
    return [];
  }

  const edits = data as {
    id: string;
    user_id: string;
    previous_salary: number | null;
    new_salary: number;
    changed_by: string;
    created_at: string;
  }[];

  const userIds = [
    ...new Set(edits.flatMap((edit) => [edit.user_id, edit.changed_by])),
  ];

  const profileById = new Map<
    string,
    { display_name: string | null; name_color: string | null }
  >();

  if (userIds.length > 0) {
    const { data: profileRows } = await supabase
      .from("profiles")
      .select("id, display_name, name_color")
      .in("id", userIds);

    for (const profile of (profileRows ?? []) as {
      id: string;
      display_name: string | null;
      name_color: string | null;
    }[]) {
      profileById.set(profile.id, {
        display_name: profile.display_name,
        name_color: profile.name_color,
      });
    }
  }

  return edits.map((edit) => ({
    ...edit,
    member_name: profileById.get(edit.user_id)?.display_name ?? null,
    member_color: profileById.get(edit.user_id)?.name_color ?? null,
    editor_name: profileById.get(edit.changed_by)?.display_name ?? null,
    editor_color: profileById.get(edit.changed_by)?.name_color ?? null,
  }));
}

/**
 * Loads the roster, salary defaults, edit history, and caller role.
 *
 * @param leagueId - The league whose members to load.
 * @param requestedSeasonId - The season on screen, or null to use the stored one.
 * @param currentUserId - The signed-in member whose role is returned.
 * @returns The page payload.
 * @throws When the league or its season cannot be read.
 */
export async function loadMembersPageData(
  leagueId: string,
  requestedSeasonId: string | null,
  currentUserId: string,
): Promise<MembersPageData> {
  const { data: league, error: leagueError } = await supabase
    .from("leagues")
    .select("id, name, owner_id")
    .eq("id", leagueId)
    .maybeSingle();

  if (leagueError || !league) {
    throw new Error("This league could not be loaded.");
  }

  const { data: seasonData, error: seasonError } = await loadSeason<{
    id: string;
    season_number: number;
    name: string | null;
  }>(
    league.id,
    "id, season_number, name",
    requestedSeasonId ?? getSelectedSeason(league.id),
  );

  if (seasonError || !seasonData) {
    throw new Error("This league's season could not be loaded.");
  }

  const { data: settingsData, error: settingsError } = await supabase
    .from("league_settings")
    .select("total_token_salary, allow_per_team_salary")
    .eq("league_id", league.id)
    .eq("season_id", seasonData.id)
    .maybeSingle();

  const seasonDefaultSalary = Number(settingsData?.total_token_salary ?? 0);
  const allowPerTeamSalary =
    !settingsError && settingsData
      ? Boolean(settingsData.allow_per_team_salary)
      : false;
  const defaultTotalTokenSalary =
    !settingsError && settingsData ? seasonDefaultSalary : 0;

  /*
   * Salaries are stored per team and season, so read the selected season's team
   * rows. league_members.total_token_salary is only a league-wide template and
   * would show a newer season's value while looking back.
   */
  const { data: teamSalaryRows, error: teamSalaryError } = await supabase
    .from("teams")
    .select("owner_user_id, total_salary_override")
    .eq("league_id", league.id)
    .eq("season_id", seasonData.id);

  if (teamSalaryError) {
    throw teamSalaryError;
  }

  const salaryByOwner = new Map(
    (
      (teamSalaryRows ?? []) as {
        owner_user_id: string;
        total_salary_override: number | null;
      }[]
    ).map((row) => [row.owner_user_id, row.total_salary_override]),
  );

  const { data: memberships, error: membershipsError } = await supabase
    .from("league_members")
    .select(
      "user_id, role, joined_at, is_active, profiles: user_id (display_name, avatar_url, avatar_initials, name_color)",
    )
    .eq("league_id", league.id)
    .eq("is_active", true)
    .order("joined_at", { ascending: true });

  if (membershipsError) {
    throw membershipsError;
  }

  const members = (memberships ?? []).map((member) =>
    toMemberRow(
      member,
      salaryByOwner,
      allowPerTeamSalary,
      seasonDefaultSalary,
    ),
  );

  return {
    league: { id: league.id, name: league.name || "", owner_id: league.owner_id },
    season: seasonData,
    allowPerTeamSalary,
    defaultTotalTokenSalary,
    members,
    salaryHistory: await loadSalaryEditHistory(league.id, seasonData.id),
    currentUserRole:
      members.find((member) => member.user_id === currentUserId)?.role ?? null,
  };
}

/**
 * Re-reads the owner and active roster after a change that can move roles.
 *
 * @param leagueId - The league whose roster to read.
 * @returns The current owner id and normalized members without salary values.
 */
export async function loadMembersRoster(
  leagueId: string,
): Promise<{ ownerId: string | null; members: MemberRow[] }> {
  const { data: league } = await supabase
    .from("leagues")
    .select("owner_id")
    .eq("id", leagueId)
    .maybeSingle();

  const { data: freshMembers } = await supabase
    .from("league_members")
    .select("user_id, role, joined_at")
    .eq("league_id", leagueId)
    .eq("is_active", true);

  if (!freshMembers) {
    return { ownerId: league?.owner_id ?? null, members: [] };
  }

  const userIds = freshMembers.map((member) => member.user_id);
  const { data: freshProfiles } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, avatar_initials, name_color")
    .in("id", userIds);

  const profileById = new Map(
    (freshProfiles ?? []).map((profile) => [profile.id, profile]),
  );

  const members: MemberRow[] = freshMembers.map((member) => {
    const profile = profileById.get(member.user_id);

    return {
      user_id: member.user_id,
      role: (member.role as "owner" | "admin" | "member") || "member",
      joined_at: member.joined_at,
      display_name: profile?.display_name || "Member",
      avatar_url: profile?.avatar_url || null,
      avatar_initials: profile?.avatar_initials ?? null,
      name_color: profile?.name_color ?? null,
      total_token_salary: null,
    };
  });

  return { ownerId: league?.owner_id ?? null, members };
}

/**
 * Updates a member's role.
 *
 * @param leagueId - The league the member belongs to.
 * @param userId - The member whose role changes.
 * @param role - The new role.
 * @throws When the write is rejected.
 */
export async function updateMemberRole(
  leagueId: string,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  const { error } = await supabase
    .from("league_members")
    .update({ role })
    .eq("league_id", leagueId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Removes a member from the league by clearing their membership.
 *
 * @param leagueId - The league the member belongs to.
 * @param userId - The member to remove.
 * @throws When the write is rejected.
 */
export async function removeMember(
  leagueId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from("league_members")
    .update({ is_active: false })
    .eq("league_id", leagueId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(error.message);
  }
}
