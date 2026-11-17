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
import { formatDateTimeInZone } from "@/lib/datetime";
import { useUserTimeZone } from "@/lib/user-timezone";
import { useConfirm } from "@/components/confirm-dialog";
import { MemberName } from "@/components/member-name";
import { MemberAvatar } from "@/components/member-avatar";
import { useShellLeague } from "@/components/league-shell-context";
import { PageShell, PageShellError, PageShellLoading } from "@/components/page-shell";
import { leaveLeague, transferLeagueOwnership } from "@/lib/supabase/leagues";
import {
  loadMembersPageData,
  loadMembersRoster,
  loadSalaryEditHistory,
  removeMember,
  updateMemberRole,
  type MemberRow,
  type SalaryEditRow,
} from "@/lib/supabase/members";
import { updateTeamSalaryForSeason } from "@/lib/supabase/teams";
import { formatSeasonLabel } from "@/lib/supabase/seasons";


/**
 * Members settings page that suspends rendering until the client-only
 * content component has been resolved.
 */
export default function MembersSettingsPage() {
  return (
    <Suspense fallback={<PageShellLoading label="Loading members settings" />}>
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
  const shellLeague = useShellLeague();
  /** The signed-in member's id; the shell resolved it before this page loaded. */
  const currentUserId = shellLeague.userId;
  /** True when the shell resolved no league for this member. */
  const shellLeagueMissing =
    !shellLeague.isResolving && !shellLeague.signedOut && !shellLeague.leagueId;

  useEffect(() => {
    if (shellLeague.signedOut) {
      router.replace("/");
    }
  }, [shellLeague.signedOut, router]);
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
    if (
      shellLeague.isResolving ||
      shellLeague.signedOut ||
      !shellLeague.leagueId ||
      !currentUserId
    ) {
      return;
    }

    const selectedLeagueId = shellLeague.leagueId;
    const userId = currentUserId;

    /** Loads the active league's members, the current user's role, and salary settings. */
    async function loadMembers() {
      try {
        setError(null);
        setSuccessMessage(null);

        const data = await loadMembersPageData(
          selectedLeagueId,
          searchParams.get("seasonId"),
          userId,
        );

        setLeagueId(data.league.id);
        setLeagueName(data.league.name);
        setOwnerUserId(data.league.owner_id);
        setSeason(data.season);
        setAllowPerTeamSalary(data.allowPerTeamSalary);
        setDefaultTotalTokenSalary(data.defaultTotalTokenSalary);
        setMembers(data.members);
        setSavedSalaries(
          Object.fromEntries(
            data.members.map((member) => [
              member.user_id,
              member.total_token_salary,
            ]),
          ),
        );
        setSalaryHistory(data.salaryHistory);
        setCurrentUserRole(data.currentUserRole);
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
  }, [
    router,
    searchParams,
    shellLeague.leagueId,
    shellLeague.isResolving,
    shellLeague.signedOut,
    currentUserId,
  ]);

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
    const { ownerId, members: roster } = await loadMembersRoster(leagueId ?? "");

    if (ownerId) {
      setOwnerUserId(ownerId);
    }

    const normalized: MemberRow[] = roster.map((member) => ({
      ...member,
      /* Role reloads must not discard a salary the owner has typed but not saved. */
      total_token_salary:
        members.find((existing) => existing.user_id === member.user_id)
          ?.total_token_salary ?? null,
    }));

    setMembers(normalized);
    setCurrentUserRole(
      normalized.find((member) => member.user_id === currentUserId)?.role ??
        null,
    );
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

        return updateTeamSalaryForSeason(
          leagueId,
          season.id,
          member.user_id,
          nextValue,
        );
      });

      await Promise.all(updatePromises);

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
  async function handleLeaveLeague() {
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
      await leaveLeague(leagueId);

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
  async function handleUpdateMemberRole(
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
      await updateMemberRole(leagueId, targetUserId, nextRole);

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
      await transferLeagueOwnership(leagueId, targetUserId);

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
  async function handleRemoveMember(targetUserId: string) {
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
      await removeMember(leagueId, targetUserId);

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

  if (shellLeagueMissing) {
    return (
      <PageShellError>
        You are not a member of any active league.
      </PageShellError>
    );
  }

  if (isLoading) {
    return <PageShellLoading label="Loading members settings" />;
  }

  return (
    <PageShell>
      <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-2xl sm:p-6 shadow-slate-950/40">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">
                Members Settings
              </h1>
              <p className="mt-2 text-sm text-slate-400">
                {leagueName || "League members"}
                {season ? ` â€¢ ${formatSeasonLabel(season)}` : ""}
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
                onClick={handleLeaveLeague}
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
                          : "â€”"}
                      </td>
                      <td className="px-3 py-3">
                        {canManage ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            {member.role === "admin" ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateMemberRole(member.user_id, "member")
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
                                  handleUpdateMemberRole(member.user_id, "admin")
                                }
                                disabled={isBusy}
                                className="rounded-lg border border-sky-700 bg-sky-950/40 px-2.5 py-1.5 text-xs text-sky-200 transition hover:border-sky-500 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Promote to Admin
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => handleRemoveMember(member.user_id)}
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
                                : "â€”"}
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
                        <span className="mx-1.5 text-slate-500">â†’</span>
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

      {confirmDialog}
    </PageShell>
  );
}
