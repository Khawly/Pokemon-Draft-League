/*
 * Draft board page for a league. The owner prepares the draft here: managing
 * invites and draft positions and starting the draft once the checklist is
 * complete.
 */

"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  loadDraftboardData,
  type DraftboardGoods,
  type DraftboardMember,
  type DraftboardTeam,
} from "@/lib/supabase/draftboard";
import { createLeagueInvite } from "@/lib/supabase/invites";

/**
 * Entry point for the draft board route.
 *
 * Wraps the draft board content in a Suspense boundary so that useSearchParams
 * meets Next.js's client-side streaming requirement.
 *
 * @returns The draft board page with a loading fallback.
 */
export default function DraftBoardPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading draft board...
          </div>
        </main>
      }
    >
      <DraftBoardPageContent />
    </Suspense>
  );
}

/** Maps league season statuses to human-readable labels shown in the header. */
const statusLabel: Record<string, string> = {
  draft_pending: "Draft not started",
  draft_active: "Draft in progress",
  draft_complete: "Draft complete",
  archived: "Season archived",
};

/**
 * Loads draft board data for the selected league and renders the full UI.
 *
 * Handles authentication, invite link setup, checklist state, team/position
 * updates, and the start-draft flow.
 *
 * @returns The draft board markup, loading placeholder, or error state.
 */
function DraftBoardPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [goods, setGoods] = useState<DraftboardGoods | null>(null);
  const [teams, setTeams] = useState<DraftboardTeam[]>([]);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          router.replace("/");
          return;
        }

        let selectedLeagueId = searchParams.get("leagueId");

        if (!selectedLeagueId) {
          const { data: memberships, error: membershipsError } = await supabase
            .from("league_members")
            .select("league_id")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("joined_at", { ascending: false })
            .limit(1);

          if (membershipsError || !memberships?.length) {
            setError("You are not a member of any active league.");
            return;
          }

          selectedLeagueId = memberships[0].league_id;
        }

        if (!selectedLeagueId) {
          setError("Select a league before opening the draft board.");
          return;
        }

        const loaded = await loadDraftboardData(selectedLeagueId);
        setGoods(loaded);
        setTeams(loaded.teams);

        // Ensure the owner always has a shareable link: reuse an existing
        // invite token or create one on first load.
        if (loaded.inviteToken) {
          setInviteToken(loaded.inviteToken);
        } else if (loaded.isOwner) {
          const created = await createLeagueInvite(loaded.league.id);
          setInviteToken(created.token);
        }
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "The draft board could not be loaded.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, [router, searchParams]);

  const inviteUrl = useMemo(() => {
    if (!inviteToken || typeof window === "undefined") {
      return null;
    }

    return `${window.location.origin}/invite/${inviteToken}`;
  }, [inviteToken]);

  // The draft can only start once every slot is filled, each team has a
  // unique draft position, and the pool is set up.
  const slotsFilled =
    !!goods && goods.teams.length >= goods.league.number_of_players;

  const positionsAssigned =
    teams.length > 0 &&
    teams.every((team) => team.draft_position != null) &&
    new Set(teams.map((team) => team.draft_position)).size === teams.length;

  const poolComplete = !!goods?.hasInPoolPokemon;

  const checklistComplete = slotsFilled && positionsAssigned && poolComplete;

  const canStartDraft =
    !!goods?.season &&
    goods.season.status === "draft_pending" &&
    checklistComplete;

  const canPreviewDraft =
    !!goods?.season && goods.season.status === "draft_pending";

  /**
   * Copies the invite URL to the clipboard and shows temporary feedback.
   */
  async function handleCopyLink() {
    if (!inviteUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Unable to copy the link. Select it manually to copy it.");
    }
  }

  /**
   * Generates a fresh invite token for the league and replaces the current one.
   */
  async function handleRegenerateInvite() {
    if (!goods || isBusy) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const created = await createLeagueInvite(goods.league.id);
      setInviteToken(created.token);
      setSuccessMessage("A new invite link has been generated.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to generate an invite link.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Renames a team when its name input loses focus.
   *
   * @param teamId - Id of the team to rename.
   * @param nextName - Raw input value; surrounding whitespace is trimmed.
   */
  async function handleRenameTeam(teamId: string, nextName: string) {
    if (!teams.some((team) => team.id === teamId)) {
      return;
    }

    const trimmedName = nextName.trim();
    // Optimistically apply the rename, rolling back to a snapshot on error.
    const snapshot = teams;

    setTeams((current) =>
      current.map((team) =>
        team.id === teamId
          ? { ...team, team_name: trimmedName || team.team_name }
          : team,
      ),
    );

    if (!trimmedName) {
      return;
    }

    const { error: updateError } = await supabase
      .from("teams")
      .update({ team_name: trimmedName })
      .eq("id", teamId);

    if (updateError) {
      setTeams(snapshot);
      setError(updateError.message || "Unable to rename the team.");
    }
  }

  /**
   * Assigns a draft position to a team via an optimistic UI update.
   *
   * @param teamId - Id of the team receiving the position.
   * @param position - Draft pick number to assign.
   */
  async function handleAssignPosition(teamId: string, position: number) {
    if (!goods || isBusy) {
      return;
    }

    // Optimistically update the position, rolling back to a snapshot on error.
    const previous = teams;

    setTeams((current) =>
      current.map((team) =>
        team.id === teamId ? { ...team, draft_position: position } : team,
      ),
    );

    try {
      const { error: updateError } = await supabase
        .from("teams")
        .update({ draft_position: position })
        .eq("id", teamId);

      if (updateError) {
        throw new Error(updateError.message);
      }
    } catch (caughtError) {
      setTeams(previous);
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to assign the draft position.";
      setError(message);
    }
  }

  /**
   * Randomizes draft positions across all teams.
   */
  async function handleRandomizePositions() {
    if (!goods || isBusy || teams.length === 0) {
      return;
    }

    const count = goods.league.number_of_players;
    const available = Array.from({ length: count }, (_, index) => index + 1);

    // Fisher-Yates shuffle so every permutation of positions is equally likely.
    for (let index = available.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [available[index], available[swapIndex]] = [
        available[swapIndex],
        available[index],
      ];
    }

    const assignments = teams.map((team, index) => ({
      id: team.id,
      position: available[index] ?? 1,
    }));

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      for (const assignment of assignments) {
        const { data: updated, error: updateError } = await supabase
          .from("teams")
          .update({ draft_position: assignment.position })
          .eq("id", assignment.id)
          .select()
          .single();

        if (updateError) {
          throw new Error(updateError.message);
        }

        setTeams((current) =>
          current.map((team) =>
            team.id === assignment.id
              ? {
                  ...team,
                  draft_position: (updated as DraftboardTeam).draft_position,
                }
              : team,
          ),
        );
      }

      setSuccessMessage("Draft positions have been randomized.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to randomize draft positions.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Starts the draft after confirmation, locking in the draft order.
   */
  async function handleStartDraft() {
    if (!goods || !canStartDraft) {
      return;
    }

    // Starting the draft locks the order, so confirm intent before proceeding.
    const confirmed = window.confirm(
      "Start the draft now? Once started, the draft order locks and picks begin.",
    );

    if (!confirmed) {
      return;
    }

    setIsStarting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      // The RPC flips the season to draft_active and returns its new status.
      const { data, error: startError } = await supabase.rpc("start_draft", {
        p_league_id: goods.league.id,
      });

      if (startError) {
        throw new Error(startError.message);
      }

      const result =
        (data as Array<{ season_id: string; status: string }> | null)?.[0] ??
        null;

      setGoods((current) =>
        current && result
          ? {
              ...current,
              season: current.season
                ? { ...current.season, status: result.status }
                : current.season,
            }
          : current,
      );

      setSuccessMessage("The draft has started. Good luck, Trainers!");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to start the draft.";
      setError(message);
    } finally {
      setIsStarting(false);
    }
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading draft board...
        </div>
      </main>
    );
  }

  if (!goods) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-2xl rounded-2xl border border-red-800 bg-red-950/60 px-6 py-5 text-sm text-red-200 shadow-xl shadow-slate-950/40">
          {error ?? "The draft board could not be loaded."}
        </div>
      </main>
    );
  }

  const takenPositions = new Set(
    teams
      .map((team) => team.draft_position)
      .filter((position): position is number => position != null),
  );

  const teamByMember = new Map(teams.map((team) => [team.owner_user_id, team]));

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">
                Draft Board
              </p>
              <h1 className="mt-2 text-3xl font-bold text-white">
                {goods.league.name}
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                Season {goods.season?.season_number ?? "—"} ·{" "}
                {goods.season
                  ? (statusLabel[goods.season.status] ?? goods.season.status)
                  : "No season available"}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {goods.isOwner && goods.season && (
                <>
                  <button
                    type="button"
                    disabled={!canStartDraft || isStarting}
                    onClick={handleStartDraft}
                    className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isStarting ? "Starting..." : "Start Draft"}
                  </button>

                  <button
                    type="button"
                    disabled={!canPreviewDraft}
                    onClick={() =>
                      router.push(
                        `/draft?leagueId=${goods.league.id}&preview=1`,
                      )
                    }
                    className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Preview Draft
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      router.push(`/pool?leagueId=${goods.league.id}&view=tier`)
                    }
                    className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
                  >
                    Tier List
                  </button>
                </>
              )}
            </div>
          </div>

          {!goods.isOwner && (
            <p className="mt-3 text-sm text-slate-400">
              The league owner prepares the draft here. Hang tight while they
              fill the Player slots.
            </p>
          )}
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

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-6">
            <InviteCard
              inviteUrl={inviteUrl}
              copied={copied}
              isBusy={isBusy}
              isOwner={goods.isOwner}
              onCopy={handleCopyLink}
              onRegenerate={handleRegenerateInvite}
            />

            {goods.isOwner && goods.season && (
              <ChecklistCard
                goods={goods}
                teams={teams}
                slotsFilled={slotsFilled}
                positionsAssigned={positionsAssigned}
                poolComplete={poolComplete}
                checklistComplete={checklistComplete}
                takenPositions={takenPositions}
                onOpenDraftSettings={() =>
                  router.push(`/draft-settings?leagueId=${goods.league.id}`)
                }
              />
            )}
          </section>

          <section className="space-y-6">
            <PlayerListCard
              goods={goods}
              teams={teams}
              teamByMember={teamByMember}
              takenPositions={takenPositions}
              isBusy={isBusy}
              isOwner={goods.isOwner}
              onAssignPosition={handleAssignPosition}
              onRandomize={handleRandomizePositions}
              onRenameTeam={handleRenameTeam}
            />
          </section>
        </div>
      </div>
    </main>
  );
}

/**
 * Resolves a member's display name, falling back to null when unavailable.
 *
 * @param member - Member whose display name is read.
 * @returns The member's display name or null when missing.
 */
function membersDisplayName(member: Pick<DraftboardMember, "display_name">) {
  return member.display_name ?? null;
}

/**
 * Card showing the league invite link with copy and regenerate actions.
 *
 * @param props.inviteUrl - Full invite URL, or null while preparing.
 * @param props.copied - Whether the link was just copied.
 * @param props.isBusy - Disables regenerate while a request is in flight.
 * @param props.isOwner - Whether the current user may regenerate the invite.
 * @param props.onCopy - Handler for copying the invite link.
 * @param props.onRegenerate - Handler for generating a fresh invite link.
 * @returns The invite link card markup.
 */
function InviteCard({
  inviteUrl,
  copied,
  isBusy,
  isOwner,
  onCopy,
  onRegenerate,
}: {
  inviteUrl: string | null;
  copied: boolean;
  isBusy: boolean;
  isOwner: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <h2 className="text-lg font-semibold text-white">Invite Link</h2>
      <p className="mt-1 text-sm text-slate-400">
        Share this link to bring new trainers into the league.
      </p>

      {inviteUrl ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
            <span className="min-w-0 flex-1 break-all text-sm text-slate-300">
              {inviteUrl}
            </span>
            <button
              type="button"
              onClick={onCopy}
              className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-400"
            >
              {copied ? "Copied!" : "Copy Link"}
            </button>
          </div>

          {isOwner && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onRegenerate}
              className="text-xs font-medium text-slate-400 underline-offset-2 transition hover:text-amber-300 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Generate new link (invalidates old ones after they expire)
            </button>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-400">
          {isOwner
            ? "Preparing your invite link..."
            : "No invite link yet. Ask the league owner to create one."}
        </p>
      )}
    </div>
  );
}

/**
 * Card listing what must be complete before the draft can start.
 *
 * @param props.goods - Loaded draft board data.
 * @param props.teams - League teams, used to show filled slot counts.
 * @param props.slotsFilled - Whether all player slots are filled.
 * @param props.positionsAssigned - Whether every team has a unique position.
 * @param props.poolComplete - Whether the draft pool is set up.
 * @param props.checklistComplete - Whether every checklist item passes.
 * @param props.takenPositions - Positions already assigned to a team.
 * @param props.onOpenDraftSettings - Opens the draft settings/pool page.
 * @returns The draft checklist card markup.
 */
function ChecklistCard({
  goods,
  teams,
  slotsFilled,
  positionsAssigned,
  poolComplete,
  checklistComplete,
  takenPositions,
  onOpenDraftSettings,
}: {
  goods: DraftboardGoods;
  teams: DraftboardTeam[];
  slotsFilled: boolean;
  positionsAssigned: boolean;
  poolComplete: boolean;
  checklistComplete: boolean;
  takenPositions: Set<number>;
  onOpenDraftSettings: () => void;
}) {
  const reachableSlots = goods.members.length;
  const remainingPositions = Array.from(
    { length: goods.league.number_of_players },
    (_, index) => index + 1,
  ).filter((position) => !takenPositions.has(position));

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <h2 className="text-lg font-semibold text-white">Draft Checklist</h2>
      <p className="mt-1 text-sm text-slate-400">
        Everything below must be complete before the draft can start.
      </p>

      {checklistComplete && (
        <div className="mt-4 rounded-xl border border-emerald-700 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
          Ready to draft. Press Start Draft to lock the order and begin.
        </div>
      )}

      <ul className="mt-4 space-y-3">
        <ChecklistItem complete={slotsFilled} label="Fill all Player slots">
          <span className="ml-auto shrink-0 text-sm text-slate-400">
            {Math.min(teams.length, goods.league.number_of_players)} /{" "}
            {goods.league.number_of_players} filled
          </span>
          {(reachableSlots < goods.league.number_of_players ||
            teams.length === 0) &&
            !slotsFilled && (
              <p className="mt-2 text-xs text-amber-300">
                Invite more players — this league needs{" "}
                {goods.league.number_of_players} Players and currently has{" "}
                {reachableSlots} members.
              </p>
            )}
        </ChecklistItem>

        <ChecklistItem
          complete={positionsAssigned}
          label="Assign a draft position to each Player"
        >
          {positionsAssigned ? (
            <span className="ml-auto shrink-0 text-sm text-emerald-300">
              All set
            </span>
          ) : (
            <span className="ml-auto shrink-0 text-sm text-slate-400">
              {teams.filter((team) => team.draft_position != null).length} /{" "}
              {goods.league.number_of_players} assigned
            </span>
          )}
        </ChecklistItem>

        <ChecklistItem complete={poolComplete} label="Draft pool complete">
          {poolComplete ? (
            <span className="ml-auto shrink-0 text-sm text-emerald-300">
              Ready
            </span>
          ) : (
            <button
              type="button"
              onClick={onOpenDraftSettings}
              className="ml-auto shrink-0 text-xs font-medium text-amber-300 underline-offset-2 transition hover:underline"
            >
              Set up pool
            </button>
          )}
        </ChecklistItem>
      </ul>

      {remainingPositions.length > 0 && teams.length > 0 && (
        <p className="mt-4 text-xs text-slate-500">
          Open positions: {remainingPositions.join(", ")}. Assign them below.
        </p>
      )}
    </div>
  );
}

/**
 * A single checklist row with a completion indicator.
 *
 * @param props.complete - Whether this checklist item is satisfied.
 * @param props.label - Text describing the checklist item.
 * @param props.children - Optional extra content alongside the label.
 * @returns A checklist list-item element.
 */
function ChecklistItem({
  complete,
  label,
  children,
}: {
  complete: boolean;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <li
      className={`flex flex-col gap-1 rounded-xl border px-4 py-3 sm:flex-row sm:items-center ${
        complete
          ? "border-emerald-800 bg-emerald-950/30"
          : "border-slate-700 bg-slate-950/60"
      }`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          complete
            ? "bg-emerald-500 text-slate-950"
            : "bg-slate-700 text-slate-300"
        }`}
        aria-hidden="true"
      >
        {complete ? "✓" : ""}
      </span>
      <span className="text-sm text-slate-200">{label}</span>
      {children}
    </li>
  );
}

/**
 * Card listing league players with their teams and draft position controls.
 *
 * @param props.goods - Loaded draft board data.
 * @param props.teams - League teams, keyed for lookup by member.
 * @param props.teamByMember - Map from member user id to their team.
 * @param props.takenPositions - Positions already assigned to a team.
 * @param props.isBusy - Disables position controls while a request is in flight.
 * @param props.isOwner - Whether the current user may edit teams and positions.
 * @param props.onAssignPosition - Assigns a draft position to a team.
 * @param props.onRandomize - Randomizes all draft positions.
 * @param props.onRenameTeam - Renames a team.
 * @returns The players card markup.
 */
function PlayerListCard({
  goods,
  teams,
  teamByMember,
  takenPositions,
  isBusy,
  isOwner,
  onAssignPosition,
  onRandomize,
  onRenameTeam,
}: {
  goods: DraftboardGoods;
  teams: DraftboardTeam[];
  teamByMember: Map<string, DraftboardTeam>;
  takenPositions: Set<number>;
  isBusy: boolean;
  isOwner: boolean;
  onAssignPosition: (teamId: string, position: number) => void;
  onRandomize: () => void;
  onRenameTeam: (teamId: string, nextName: string) => void;
}) {
  const sorted = [...goods.members].sort((a, b) => {
    const aPos = teamByMember.get(a.user_id)?.draft_position ?? Infinity;
    const bPos = teamByMember.get(b.user_id)?.draft_position ?? Infinity;
    return aPos - bPos;
  });

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Players</h2>
          <p className="mt-1 text-sm text-slate-400">
            Players and draft positions for the upcoming draft.
          </p>
        </div>
        {isOwner && (
          <button
            type="button"
            disabled={isBusy || teams.length === 0}
            onClick={onRandomize}
            className="shrink-0 rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Randomize positions
          </button>
        )}
      </div>

      <ul className="mt-4 space-y-2">
        {sorted.map((member) => {
          const team = teamByMember.get(member.user_id);

          return (
            <li
              key={member.user_id}
              className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 sm:flex-row sm:items-center"
            >
              {member.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={member.avatar_url}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-full border border-slate-700 object-cover"
                />
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-amber-300">
                  {(membersDisplayName(member) || "?").charAt(0).toUpperCase()}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-100">
                  {membersDisplayName(member) || "Unnamed Trainer"}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {member.role === "owner"
                    ? "Owner"
                    : member.role === "admin"
                      ? "Admin"
                      : "Member"}{" "}
                  ·{" "}
                  {team?.draft_position != null
                    ? `Pick #${team.draft_position}`
                    : "No pick yet"}
                </p>
              </div>

              {team ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    defaultValue={team.team_name}
                    disabled={!isOwner}
                    onBlur={(event) =>
                      onRenameTeam(team.id, event.target.value)
                    }
                    placeholder={team.team_name}
                    className="w-40 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  {isOwner && (
                    <select
                      value={team.draft_position ?? ""}
                      disabled={isBusy}
                      onChange={(event) =>
                        onAssignPosition(team.id, Number(event.target.value))
                      }
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="" disabled>
                        Position
                      </option>
                      {Array.from(
                        { length: goods.league.number_of_players },
                        (_, positionIndex) => positionIndex + 1,
                      )
                        .filter(
                          (position) =>
                            position === team.draft_position ||
                            !takenPositions.has(position),
                        )
                        .map((position) => (
                          <option key={position} value={position}>
                            #{position}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              ) : (
                <span className="text-sm text-slate-500">No team</span>
              )}
            </li>
          );
        })}

        {goods.members.length === 0 && (
          <li className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-400">
            No players in this league yet.
          </li>
        )}
      </ul>
    </div>
  );
}
