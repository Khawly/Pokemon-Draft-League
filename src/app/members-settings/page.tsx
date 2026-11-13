/*
 * Members settings page for the Pokemon Draft League.
 *
 * Displays the roster of an active league with per-member roles, optional
 * per-team salary editing, and owner-only actions (promote to admin, demote,
 * transfer ownership, remove). All members have read-only roster access and can
 * leave the league themselves. Join dates are shown in the time zone the member
 * picked in user settings. Each member's name is rendered in the colour they
 * picked in their own profile. The bottom section lists the selected season's
 * total-token-salary edits, newest first.
 */
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { formatDateTimeInZone } from "@/lib/datetime";
import { useUserTimeZone } from "@/lib/user-timezone";
import { useConfirm } from "@/components/confirm-dialog";
import { MemberName } from "@/components/member-name";
import { MemberAvatar } from "@/components/member-avatar";
import { LoadingGif } from "@/components/loading-gif";
import { getSelectedSeason } from "@/lib/season-selection";
import { formatSeasonLabel, loadSeason } from "@/lib/supabase/seasons";

/** Normalized representation of an active league member for display and mutation. */
type MemberRow = {
  /** Supabase auth user identifier. */
  user_id: string;
  /** Member's role within the league: owner, admin, or member. */
  role: "owner" | "admin" | "member";
  /** ISO timestamp of when the member joined, or null if unknown. */
  joined_at: string | null;
  /** Display name from the user's profile, or a fallback. */
  display_name: string | null;
  /** URL of the user's avatar image, or null if unset. */
  avatar_url: string | null;
  /**
   * The member's stored avatar initials, raw, or null when they have not picked
   * any and the shared derivation from their name applies.
   */
  avatar_initials: string | null;
  /** The member's stored name colour, raw, or null when they have not chosen one. */
  name_color: string | null;
  /**
   * The member's token salary for the selected season: their team override when
   * one is set, otherwise that season's league default.
   */
  total_token_salary: number | null;
};

/** One recorded total-token-salary change, enriched with both members' names. */
type SalaryEditRow = {
  id: string;
  /** The member whose salary changed. */
  user_id: string;
  /** Their effective salary before the edit, or null when it inherited a default. */
  previous_salary: number | null;
  /** The salary after the edit. */
  new_salary: number;
  /** The user who made the edit. */
  changed_by: string;
  created_at: string;
  member_name: string | null;
  member_color: string | null;
  editor_name: string | null;
  editor_color: string | null;
};

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
async function loadSalaryEditHistory(
  leagueId: string,
  seasonId: string,
): Promise<SalaryEditRow[]> {
  const { data, error } = await supabase
    .from("member_salary_edits")
    .select(
      "id, user_id, previous_salary, new_salary, changed_by, created_at",
    )
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
 * Members settings page that suspends rendering until the client-only
 * content component has been resolved.
 */
export default function MembersSettingsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100 sm:px-6 sm:py-10">
          <div className="mx-auto max-w-[96rem] rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            <LoadingGif label="Loading members settings" />
          </div>
        </main>
      }
    >
      <MembersSettingsPageContent />
    </Suspense>
  );
}

/**
 * Client component for displaying and managing a league's active members.
 * Non-owners get read-only roster access; only the league owner can change
 * roles, remove members, or edit salaries. Anyone can leave the league.
 */
function MembersSettingsPageContent() {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const searchParams = useSearchParams();
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [leagueName, setLeagueName] = useState("");
  const [members, setMembers] = useState<MemberRow[]>([]);
  /** The selected season's recorded total-token-salary changes, newest first. */
  const [salaryHistory, setSalaryHistory] = useState<SalaryEditRow[]>([]);
  /**
   * The salary each member had when the page last loaded or saved, keyed by
   * user id. Compared against the editable row to show the previous value while
   * an unsaved edit is staged.
   */
  const [savedSalaries, setSavedSalaries] = useState<
    Record<string, number | null>
  >({});
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [allowPerTeamSalary, setAllowPerTeamSalary] = useState(false);
  const [defaultTotalTokenSalary, setDefaultTotalTokenSalary] = useState(0);
  /** The season whose team salaries this page is showing. */
  const [season, setSeason] = useState<{
    id: string;
    season_number: number;
    name: string | null;
  } | null>(null);
  const [hasMemberSalaryChanges, setHasMemberSalaryChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  /** The zone join dates are rendered in. */
  const timeZone = useUserTimeZone();

  useEffect(() => {
    /** Loads the active league's members, the current user's role, and salary settings. */
    async function loadMembers() {
      try {
        setError(null);
        setSuccessMessage(null);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.replace("/");
          return;
        }

        setCurrentUserId(user.id);

        let selectedLeagueId = searchParams.get("leagueId");

        // Fall back to the user's most recently joined active league when no league is specified.
        if (!selectedLeagueId) {
          const { data: memberships, error: membershipsError } = await supabase
            .from("league_members")
            .select("league_id")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("joined_at", { ascending: false })
            .limit(1);

          if (membershipsError || !memberships?.length) {
            setLeagueId(null);
            setLeagueName("");
            setMembers([]);
            setError("You are not a member of any active league.");
            return;
          }

          selectedLeagueId = memberships[0].league_id;
        }

        const { data: league, error: leagueError } = await supabase
          .from("leagues")
          .select("id, name, owner_id")
          .eq("id", selectedLeagueId)
          .maybeSingle();

        if (leagueError || !league) {
          setError("This league could not be loaded.");
          return;
        }

        setLeagueId(league.id);
        setLeagueName(league.name || "");
        setOwnerUserId(league.owner_id);

        const { data: seasonData, error: seasonError } = await loadSeason<{
          id: string;
          season_number: number;
          name: string | null;
        }>(
          league.id,
          "id, season_number, name",
          // The settings menu carries the season on screen; a direct visit falls
          // back to the last season the member chose, then to the newest.
          searchParams.get("seasonId") ?? getSelectedSeason(league.id),
        );

        if (seasonError || !seasonData) {
          setError("This league's season could not be loaded.");
          return;
        }

        setSeason(seasonData);

        const { data: settingsData, error: settingsError } = await supabase
          .from("league_settings")
          .select("total_token_salary, allow_per_team_salary")
          .eq("league_id", league.id)
          .eq("season_id", seasonData.id)
          .maybeSingle();

        const seasonDefaultSalary = Number(
          settingsData?.total_token_salary ?? 0,
        );

        if (!settingsError && settingsData) {
          setAllowPerTeamSalary(Boolean(settingsData.allow_per_team_salary));
          setDefaultTotalTokenSalary(seasonDefaultSalary);
        } else {
          setAllowPerTeamSalary(false);
          setDefaultTotalTokenSalary(0);
        }

        /*
         * Salaries are stored per team and season, so read the selected season's
         * team rows. league_members.total_token_salary is only a league-wide
         * template and would show a newer season's value while looking back.
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
          ((teamSalaryRows ?? []) as {
            owner_user_id: string;
            total_salary_override: number | null;
          }[]).map((row) => [row.owner_user_id, row.total_salary_override]),
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

        const normalizedMembers = (memberships ?? []).map((member) => {
          const profile = member.profiles as {
            display_name?: string | null;
            avatar_url?: string | null;
            avatar_initials?: string | null;
            name_color?: string | null;
          } | null;

          const seasonOverride = salaryByOwner.get(member.user_id);

          return {
            user_id: member.user_id,
            role:
              (member.role as "owner" | "admin" | "member") || "member",
            joined_at: member.joined_at,
            display_name: profile?.display_name || "Member",
            avatar_url: profile?.avatar_url || null,
            avatar_initials: profile?.avatar_initials ?? null,
            name_color: profile?.name_color ?? null,
            total_token_salary:
              typeof seasonOverride === "number"
                ? seasonOverride
                : settingsData?.allow_per_team_salary
                  ? seasonDefaultSalary
                  : null,
          } satisfies MemberRow;
        });

        setMembers(normalizedMembers);
        setSavedSalaries(
          Object.fromEntries(
            normalizedMembers.map((member) => [
              member.user_id,
              member.total_token_salary,
            ]),
          ),
        );

        setSalaryHistory(
          await loadSalaryEditHistory(league.id, seasonData.id),
        );

        const userRole =
          normalizedMembers.find((member) => member.user_id === user.id)
            ?.role ?? null;
        setCurrentUserRole(userRole);
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load members.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }

    loadMembers();
  }, [router, searchParams]);

  /*
   * Re-reads the roster after a change that can alter who holds which role.
   *
   * Ownership handover is the reason this exists. Promoting an admin moves
   * leagues.owner_id, so the caller's own role changes as a side effect of an action
   * they took on someone else's row. Patching the local array would leave the page
   * showing the caller as owner while the server has already demoted them, and the
   * "Promote to Owner" button would still be on screen with no permissions behind it.
   */
  const reloadMembers = useCallback(async () => {
    const { data: league } = await supabase
      .from("leagues")
      .select("owner_id")
      .eq("id", leagueId ?? "")
      .maybeSingle();

    if (league?.owner_id) {
      setOwnerUserId(league.owner_id);
    }

    const { data: freshMembers } = await supabase
      .from("league_members")
      .select("user_id, role, joined_at")
      .eq("league_id", leagueId ?? "")
      .eq("is_active", true);

    if (freshMembers) {
      const userIds = freshMembers.map((member) => member.user_id);
      const { data: freshProfiles } = await supabase
        .from("profiles")
        .select("id, display_name, avatar_url, avatar_initials, name_color")
        .in("id", userIds);

      const profileById = new Map(
        (freshProfiles ?? []).map((profile) => [profile.id, profile]),
      );

      const normalized: MemberRow[] = freshMembers.map((member) => {
        const profile = profileById.get(member.user_id);
        return {
          user_id: member.user_id,
          role: (member.role as "owner" | "admin" | "member") || "member",
          joined_at: member.joined_at,
          display_name: profile?.display_name || "Member",
          avatar_url: profile?.avatar_url || null,
          avatar_initials: profile?.avatar_initials ?? null,
          name_color: profile?.name_color ?? null,
          // Preserved: reloadMembers is about roles, so it must not discard a salary
          // edit the owner has typed but not yet saved.
          total_token_salary: members.find(
            (existing) => existing.user_id === member.user_id,
          )?.total_token_salary ?? null,
        };
      });

      setMembers(normalized);
      setCurrentUserRole(
        normalized.find((member) => member.user_id === currentUserId)?.role ??
          null,
      );
    }
  }, [leagueId, currentUserId, members]);

  const isOwner = currentUserRole === "owner" || currentUserId === ownerUserId;

  /**
   * Updates a member's per-team token salary in local state.
   * Only applies when per-team salary is enabled and the viewer is the owner.
   * @param targetUserId - The user id of the member being edited.
   * @param nextValue - The raw input value to parse into a salary.
   */
  function handleMemberSalaryChange(targetUserId: string, nextValue: string) {
    if (!allowPerTeamSalary || !isOwner) {
      return;
    }

    const numericValue = Number(nextValue);

    setMembers((currentMembers) =>
      currentMembers.map((member) =>
        member.user_id === targetUserId
          ? {
              ...member,
              total_token_salary: Number.isFinite(numericValue)
                ? Math.max(0, numericValue)
                : null,
            }
          : member,
      ),
    );
    setHasMemberSalaryChanges(true);
  }

  /** Saves all member salary overrides for the selected season in parallel. */
  async function saveMemberSalaryChanges() {
    if (!leagueId || !season?.id || !isOwner || !allowPerTeamSalary) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      // Fire all salary update requests in parallel and check for the first failure.
      // The RPC writes the selected season's team rows; it does not touch another
      // season's budgets.
      const updatePromises = members.map((member) => {
        const nextValue =
          typeof member.total_token_salary === "number"
            ? member.total_token_salary
            : defaultTotalTokenSalary;

        return supabase.rpc("update_team_salary_for_season", {
          p_league_id: leagueId,
          p_season_id: season.id,
          p_user_id: member.user_id,
          p_total_token_salary: nextValue,
        });
      });

      const results = await Promise.all(updatePromises);
      const firstError = results.find((result) => result.error)?.error;

      if (firstError) {
        throw firstError;
      }

      setHasMemberSalaryChanges(false);
      setSuccessMessage("Member total salary settings saved.");
      setSavedSalaries(
        Object.fromEntries(
          members.map((member) => [member.user_id, member.total_token_salary]),
        ),
      );
      setSalaryHistory(await loadSalaryEditHistory(leagueId, season.id));
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save member total salary settings.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Soft-deletes the current user's membership from the league.
   * Owners see a warning that ownership may transfer; non-owners are simply removed.
   */
  async function leaveLeague() {
    if (!leagueId) {
      setError("Select a league before leaving it.");
      return;
    }

    const isLeavingOwner = currentUserRole === "owner";
    const confirmed = await confirm({
      title: isLeavingOwner ? "Leave as the league owner?" : "Leave this league?",
      detail: isLeavingOwner
        ? "Ownership transfers to another member if one is available"
        : "You lose access to this league unless you are re-invited",
      confirmLabel: "Leave league",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { error: leaveError } = await supabase.rpc("leave_league", {
        p_league_id: leagueId,
      });

      if (leaveError) {
        throw leaveError;
      }

      setSuccessMessage("You left the league.");
      router.push("/dashboard");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to leave the league.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Updates a member's role between admin and member.
   * Only callable by the league owner.
   * @param targetUserId - The user whose role to change.
   * @param nextRole - The new role to assign.
   */
  async function updateMemberRole(
    targetUserId: string,
    nextRole: "admin" | "member",
  ) {
    if (!leagueId) {
      setError("Select a league before updating members.");
      return;
    }

    if (!isOwner) {
      setError("Only the league owner can change member roles.");
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { error: updateError } = await supabase
        .from("league_members")
        .update({ role: nextRole })
        .eq("league_id", leagueId)
        .eq("user_id", targetUserId);

      if (updateError) {
        throw updateError;
      }

      setMembers((currentMembers) =>
        currentMembers.map((member) =>
          member.user_id === targetUserId
            ? { ...member, role: nextRole }
            : member,
        ),
      );
      setSuccessMessage(
        nextRole === "admin"
          ? "Member promoted to Admin."
          : "Admin demoted to Member.",
      );
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to update member role.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Hands league ownership to an admin, demoting the current owner to admin.
   *
   * Ownership lives in `leagues.owner_id` rather than in the membership role, and
   * the update policy on `leagues` forbids the owner from pointing `owner_id` at
   * anyone else, so this goes through the `transfer_league_ownership` RPC rather
   * than a direct write. That RPC moves both rows in one transaction.
   *
   * The current owner loses owner-only access the moment this succeeds and there is
   * no undo, so it is always confirmed first. After the handover the caller is no
   * longer the owner, which flips `isOwner` and hides this control; the member list
   * is reloaded from the server rather than patched locally so the page reflects
   * the new state.
   *
   * @param targetUserId - The admin being promoted.
   */
  async function promoteToOwner(targetUserId: string) {
    if (!leagueId) {
      setError("Select a league before transferring ownership.");
      return;
    }

    if (!isOwner) {
      setError("Only the league owner can transfer ownership.");
      return;
    }

    if (targetUserId === ownerUserId) {
      setError("You already own this league.");
      return;
    }

    const targetMember = members.find(
      (member) => member.user_id === targetUserId,
    );

    const confirmed = await confirm({
      title: `Make ${targetMember?.display_name || "this admin"} the owner?`,
      detail:
        "They gain full owner access, including league settings, the draft pool and member management. You become an admin and lose owner-only access. This cannot be undone.",
      confirmLabel: "Transfer ownership",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { error: transferError } = await supabase.rpc(
        "transfer_league_ownership",
        {
          p_league_id: leagueId,
          p_new_owner_user_id: targetUserId,
        },
      );

      if (transferError) {
        throw transferError;
      }

      setSuccessMessage(
        `${targetMember?.display_name || "That admin"} is now the league owner. You are now an admin.`,
      );

      await reloadMembers();
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to transfer ownership.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Soft-deletes a member from the league. The owner cannot remove themselves.
   * Prompts for confirmation before proceeding.
   * @param targetUserId - The user id of the member to remove.
   */
  async function removeMember(targetUserId: string) {
    if (!leagueId) {
      setError("Select a league before removing a member.");
      return;
    }

    if (!isOwner) {
      setError("Only the league owner can remove members.");
      return;
    }

    if (targetUserId === ownerUserId) {
      setError("The league owner cannot be removed from the league.");
      return;
    }

    const targetMember = members.find(
      (member) => member.user_id === targetUserId,
    );
    const confirmed = await confirm({
      title: `Remove ${targetMember?.display_name || "this member"}?`,
      detail: "They lose access to the league immediately",
      confirmLabel: "Remove member",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { error: removeError } = await supabase
        .from("league_members")
        .update({ is_active: false })
        .eq("league_id", leagueId)
        .eq("user_id", targetUserId);

      if (removeError) {
        throw removeError;
      }

      setMembers((currentMembers) =>
        currentMembers.filter((member) => member.user_id !== targetUserId),
      );
      setSuccessMessage("Member removed from the league.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to remove member.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  }

  if (isLoading) {
    return (
      <main className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100 sm:px-6 sm:py-10">
        <div className="mx-auto max-w-[96rem] rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          <LoadingGif label="Loading members settings" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-[96rem] space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-2xl sm:p-6 shadow-slate-950/40">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">
                Members Settings
              </h1>
              <p className="mt-2 text-sm text-slate-400">
                {leagueName || "League members"}
                {season ? ` • ${formatSeasonLabel(season)}` : ""}
              </p>
            </div>

            <div className="flex items-center gap-3">
              {allowPerTeamSalary && isOwner && (
                <button
                  type="button"
                  onClick={saveMemberSalaryChanges}
                  disabled={!hasMemberSalaryChanges || isBusy}
                  className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isBusy ? "Saving..." : "Save Changes"}
                </button>
              )}

              <button
                type="button"
                onClick={() =>
                  router.push(
                    leagueId ? `/dashboard?leagueId=${leagueId}` : "/dashboard",
                  )
                }
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
              >
                Back to league
              </button>
            </div>
          </div>
        </header>

        {error && (
          <div className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="rounded-xl border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200">
            {successMessage}
          </div>
        )}

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg sm:p-6 shadow-slate-950/30">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-white">League Members</h2>
            <div className="flex items-center gap-3">
              <span className="rounded-full border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-300">
                {members.length} {members.length === 1 ? "member" : "members"}
              </span>
              <button
                type="button"
                onClick={leaveLeague}
                disabled={isBusy}
                className="rounded-xl border border-red-800 bg-red-950/60 px-3 py-2 text-sm font-medium text-red-200 transition hover:bg-red-900/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Leave League
              </button>
            </div>
          </div>

          {!isOwner && !error && (
            <div className="rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
              You can view the member list, but only the league owner can manage
              roles and remove members.
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="px-3 py-3 font-medium">Member</th>
                  <th className="px-3 py-3 font-medium">Role</th>
                  {allowPerTeamSalary && (
                    <th className="px-3 py-3 font-medium">
                      Total Token Salary
                    </th>
                  )}
                  <th className="px-3 py-3 font-medium">Joined</th>
                  <th className="px-3 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-slate-400"
                    >
                      No active members found.
                    </td>
                  </tr>
                )}

                {members.map((member) => {
                  const isCurrentUser = member.user_id === currentUserId;
                  const isOwnerMember = member.role === "owner";
                  const canManage = isOwner && !isCurrentUser && !isOwnerMember;
                  const hasSavedSalary = Object.prototype.hasOwnProperty.call(
                    savedSalaries,
                    member.user_id,
                  );
                  const previousSalary = hasSavedSalary
                    ? savedSalaries[member.user_id]
                    : null;
                  const salaryChanged =
                    hasSavedSalary &&
                    member.total_token_salary !== previousSalary;

                  return (
                    <tr
                      key={member.user_id}
                      className="border-b border-slate-800/80 text-slate-200"
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <MemberAvatar
                            name={member.display_name}
                            color={member.name_color}
                            avatarUrl={member.avatar_url}
                            initials={member.avatar_initials}
                            size={40}
                            className="border-transparent"
                          />
                          <div>
                            <MemberName
                              name={member.display_name}
                              color={member.name_color}
                              className="font-medium text-white"
                              fallback="Member"
                            />
                            {isCurrentUser && (
                              <div className="text-xs text-amber-300">You</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${
                            member.role === "owner"
                                ? "border-amber-600 bg-amber-950/60 text-amber-200"
                                : member.role === "admin"
                                  ? "border-sky-600 bg-sky-950/60 text-sky-200"
                                  : "border-slate-700 bg-slate-950 text-slate-300"
                          }`}
                        >
                          {member.role}
                        </span>
                      </td>
                      {allowPerTeamSalary && (
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-3">
                            {isOwner ? (
                              <input
                                type="number"
                                min={0}
                                value={
                                  typeof member.total_token_salary === "number"
                                    ? member.total_token_salary
                                    : defaultTotalTokenSalary
                                }
                                onChange={(event) =>
                                  handleMemberSalaryChange(
                                    member.user_id,
                                    event.target.value,
                                  )
                                }
                                className="w-32 rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-2 text-slate-100 outline-none transition focus:border-amber-400"
                              />
                            ) : (
                              <span className="text-slate-300">
                                {typeof member.total_token_salary === "number"
                                  ? member.total_token_salary
                                  : defaultTotalTokenSalary}
                              </span>
                            )}
                            {isOwner && (
                              <span className="w-32 shrink-0 truncate text-xs text-slate-500">
                                {salaryChanged ? (
                                  <>
                                    Previous:{" "}
                                    <span className="text-slate-300">
                                      {previousSalary ?? defaultTotalTokenSalary}
                                    </span>
                                  </>
                                ) : null}
                              </span>
                            )}
                          </div>
                        </td>
                      )}
                      <td className="px-3 py-3 text-slate-400">
                        {member.joined_at
                          ? formatDateTimeInZone(member.joined_at, timeZone)
                          : "—"}
                      </td>
                      <td className="px-3 py-3">
                        {canManage ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            {member.role === "admin" ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateMemberRole(member.user_id, "member")
                                  }
                                  disabled={isBusy}
                                  className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Demote
                                </button>
                                {/*
                                  Ownership handover. Only on admin rows, and only
                                  for the owner, matching the RPC's own guard. The
                                  button moves to the promoted member's card the
                                  moment this succeeds, because the clicker's own
                                  role is now admin.
                                */}
                                <button
                                  type="button"
                                  onClick={() =>
                                    promoteToOwner(member.user_id)
                                  }
                                  disabled={isBusy}
                                  title="Transfer league ownership to this admin. You become an admin."
                                  className="rounded-lg border border-amber-600 bg-amber-950/50 px-2.5 py-1.5 text-xs text-amber-200 transition hover:border-amber-500 hover:bg-amber-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Promote to Owner
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  updateMemberRole(member.user_id, "admin")
                                }
                                disabled={isBusy}
                                className="rounded-lg border border-sky-700 bg-sky-950/40 px-2.5 py-1.5 text-xs text-sky-200 transition hover:border-sky-500 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Promote to Admin
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => removeMember(member.user_id)}
                              disabled={isBusy}
                              className="rounded-lg border border-red-700 bg-red-950/40 px-2.5 py-1.5 text-xs text-red-200 transition hover:border-red-500 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </div>
                        ) : (
                          <div className="text-right text-xs text-slate-500">
                            {isOwnerMember
                              ? "Owner"
                              : isCurrentUser
                                ? "Current user"
                                : "—"}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg sm:p-6 shadow-slate-950/30">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">
                Total token salary history
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Changes to member salaries
                {season ? ` for ${formatSeasonLabel(season)}` : ""}, newest
                first.
              </p>
            </div>
          </div>

          {salaryHistory.length === 0 ? (
            <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-sm text-slate-400">
              No salary changes have been recorded for this season yet.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 font-medium">Member</th>
                    <th className="px-3 py-2 font-medium">Change</th>
                    <th className="px-3 py-2 font-medium">Changed by</th>
                    <th className="px-3 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {salaryHistory.map((edit) => (
                    <tr
                      key={edit.id}
                      className="border-b border-slate-800/80 text-slate-200"
                    >
                      <td className="px-3 py-3">
                        <MemberName
                          name={edit.member_name ?? "Member"}
                          color={edit.member_color}
                          fallback="Member"
                          className="font-medium text-white"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <span className="text-slate-400">
                          {edit.previous_salary ?? "Default"}
                        </span>
                        <span className="mx-1.5 text-slate-500">→</span>
                        <span className="font-semibold text-amber-200">
                          {edit.new_salary}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <MemberName
                          name={edit.editor_name ?? "League owner"}
                          color={edit.editor_color}
                          fallback="League owner"
                          className="text-slate-300"
                        />
                      </td>
                      <td className="px-3 py-3 text-slate-400">
                        {formatDateTimeInZone(edit.created_at, timeZone)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>

      {confirmDialog}
    </main>
  );
}
