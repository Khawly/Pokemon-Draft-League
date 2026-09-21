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
  const [stagedPositions, setStagedPositions] = useState<
    Record<string, number>
  >({});
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
        setStagedPositions({});

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

  // The position choice shown for each team overlays staged (unsaved) picks on
  // top of what is persisted, so checklist validation keeps reading the saved
  // values while the Players card lets the owner stage edits.
  const effectiveTeams = useMemo(
    () =>
      teams.map((team) => ({
        ...team,
        draft_position: stagedPositions[team.id] ?? team.draft_position,
      })),
    [teams, stagedPositions],
  );

  const takenPositions = useMemo(
    () =>
      new Set(
        effectiveTeams
          .map((team) => team.draft_position)
          .filter((position): position is number => position != null),
      ),
    [effectiveTeams],
  );

  const teamByMember = useMemo(
    () => new Map(effectiveTeams.map((team) => [team.owner_user_id, team])),
    [effectiveTeams],
  );

  const hasPositionChanges = useMemo(
    () =>
      Object.entries(stagedPositions).some(
        ([teamId, position]) =>
          teams.find((team) => team.id === teamId)?.draft_position !== position,
      ),
    [stagedPositions, teams],
  );

  // The draft can only start once every slot is filled, each team has a
  // unique draft position, and the pool is set up.
  const slotsFilled =
    !!goods && goods.members.length >= goods.league.number_of_players;

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

  const canPreviewDraft = !!goods?.league;

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
   * Stages a draft position assignment for a team in local state.
   *
   * The change is not written to the database until the owner clicks the Save
   * Changes button in the Players card.
   *
   * @param teamId - Id of the team receiving the position.
   * @param position - Draft pick number to assign.
   */
  function handleStagePosition(teamId: string, position: number) {
    if (!goods || isBusy) {
      return;
    }

    setStagedPositions((current) => ({
      ...current,
      [teamId]: position,
    }));
  }

  /**
   * Randomizes draft positions across all teams as a staged change.
   *
   * Generates a uniformly random permutation (Fisher-Yates shuffle) of the
   * available positions and stages it for every team; nothing is written to
   * the database until the owner saves.
   */
  function handleRandomizePositions() {
    if (!goods || teams.length === 0) {
      return;
    }

    const count = goods.league.number_of_players;
    const available = Array.from({ length: count }, (_, index) => index + 1);

    for (let index = available.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [available[index], available[swapIndex]] = [
        available[swapIndex],
        available[index],
      ];
    }

    const randomized = Object.fromEntries(
      teams.map((team, index) => [team.id, available[index] ?? 1]),
    );
    setStagedPositions((current) => ({ ...current, ...randomized }));
    setError(null);
    setSuccessMessage(
      "Draft positions randomized. Click Save Changes to persist them.",
    );
  }

  /**
   * Persists every staged draft position change to the database.
   *
   * Writes only the teams whose staged pick differs from their persisted value,
   * then clears the staged overlay and refreshes the loaded teams.
   *
   * @returns A promise resolving once the writes complete.
   */
  async function handleSavePositions() {
    if (!goods || isBusy) {
      return;
    }

    const dirtyEntries = Object.entries(stagedPositions)
      .map(([teamId, position]) => {
        const team = teams.find((candidate) => candidate.id === teamId);
        return team && team.draft_position !== position
          ? { teamId, position }
          : null;
      })
      .filter(
        (entry): entry is { teamId: string; position: number } =>
          entry !== null,
      );

    if (dirtyEntries.length === 0) {
      setStagedPositions({});
      return;
    }

    setIsBusy(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const idToPosition = new Map(
        dirtyEntries.map((entry) => [entry.teamId, entry.position]),
      );
      const results = await Promise.all(
        dirtyEntries.map(({ teamId, position }) =>
          supabase
            .from("teams")
            .update({ draft_position: position })
            .eq("id", teamId),
        ),
      );

      const firstError = results.find((result) => result.error)?.error;
      if (firstError) {
        throw new Error(firstError.message);
      }

      setTeams((current) =>
        current.map((team) =>
          idToPosition.has(team.id)
            ? { ...team, draft_position: idToPosition.get(team.id)! }
            : team,
        ),
      );
      setStagedPositions({});
      setSuccessMessage("Draft positions saved.");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save draft positions.",
      );
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
              <button
                type="button"
                disabled={!canPreviewDraft}
                onClick={() =>
                  router.push(`/draft?leagueId=${goods.league.id}&preview=1`)
                }
                className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Preview Draft
              </button>

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
                  router.push(`/pool?leagueId=${goods.league.id}`)
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
              hasPositionChanges={hasPositionChanges}
              onStagePosition={handleStagePosition}
              onRandomize={handleRandomizePositions}
              onSavePositions={handleSavePositions}
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
 * @param props.teams - League teams, used to show assigned-position counts.
 * @param props.slotsFilled - Whether all player slots are filled.
 * @param props.positionsAssigned - Whether every team has a unique position.
 * @param props.poolComplete - Whether the draft pool is set up.
 * @param props.checklistComplete - Whether every checklist item passes.
 * @param props.takenPositions - Positions already assigned to a team.
 * @param props.onOpenDraftSettings - Opens the draft pool page.
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
            {Math.min(reachableSlots, goods.league.number_of_players)} /{" "}
            {goods.league.number_of_players} filled
          </span>
          {reachableSlots < goods.league.number_of_players && !slotsFilled && (
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
          {poolComplete && (
            <span className="ml-auto shrink-0 text-sm text-emerald-300">
              Ready
            </span>
          )}
          <button
            type="button"
            onClick={onOpenDraftSettings}
            className={`shrink-0 text-xs font-medium text-amber-300 underline-offset-2 transition hover:underline ${
              poolComplete ? "ml-3" : "ml-auto"
            }`}
          >
            {poolComplete ? "Draft Pool" : "Set up pool"}
          </button>
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
        {complete ? "" : ""}
      </span>
      <span className="text-sm text-slate-200">{label}</span>
      {children}
    </li>
  );
}

/**
 * Card listing league players in a table with their draft positions.
 *
 * The owner can stage draft position picks and persist them with the Save
 * Changes button; members only see read-only values. Players without a team
 * show a dash rather than "No team".
 *
 * @param props.goods - Loaded draft board data.
 * @param props.teams - League teams, keyed for lookup by member.
 * @param props.teamByMember - Map from member user id to their team.
 * @param props.takenPositions - Positions already assigned to a team.
 * @param props.isBusy - Disables position controls while a request is in flight.
 * @param props.isOwner - Whether the current user may edit teams and positions.
 * @param props.hasPositionChanges - Whether any staged pick differs from saved.
 * @param props.onStagePosition - Stages a draft position for a team.
 * @param props.onRandomize - Stages random positions across all teams.
 * @param props.onSavePositions - Persists all staged position changes.
 * @returns The players card markup.
 */
function PlayerListCard({
  goods,
  teams,
  teamByMember,
  takenPositions,
  isBusy,
  isOwner,
  hasPositionChanges,
  onStagePosition,
  onRandomize,
  onSavePositions,
}: {
  goods: DraftboardGoods;
  teams: DraftboardTeam[];
  teamByMember: Map<string, DraftboardTeam>;
  takenPositions: Set<number>;
  isBusy: boolean;
  isOwner: boolean;
  hasPositionChanges: boolean;
  onStagePosition: (teamId: string, position: number) => void;
  onRandomize: () => void;
  onSavePositions: () => void;
}) {
  const sorted = [...goods.members].sort((a, b) => {
    const aPos = teamByMember.get(a.user_id)?.draft_position ?? Infinity;
    const bPos = teamByMember.get(b.user_id)?.draft_position ?? Infinity;
    return aPos - bPos;
  });

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Players</h2>
          <p className="mt-1 text-sm text-slate-400">
            Players and draft positions for the upcoming draft.
          </p>
        </div>
        {isOwner && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isBusy || !hasPositionChanges}
              onClick={onSavePositions}
              title={
                hasPositionChanges
                  ? "Persist the staged draft positions"
                  : "Change a draft position to enable saving"
              }
              className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? "Saving..." : "Save Changes"}
            </button>
            <button
              type="button"
              disabled={isBusy || teams.length === 0}
              onClick={onRandomize}
              className="shrink-0 rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Randomize positions
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="px-3 py-3 font-medium">Player</th>
              <th className="px-3 py-3 font-medium">Draft Position</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={2}
                  className="px-3 py-6 text-center text-slate-400"
                >
                  No players in this league yet.
                </td>
              </tr>
            )}

            {sorted.map((member) => {
              const team = teamByMember.get(member.user_id);
              const position = team?.draft_position ?? null;

              return (
                <tr
                  key={member.user_id}
                  className="border-b border-slate-800/80 text-slate-200"
                >
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      {member.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={member.avatar_url}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded-full border border-slate-700 object-cover"
                        />
                      ) : (
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-amber-300">
                          {(membersDisplayName(member) || "?")
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                      )}
                      <div>
                        <p className="truncate text-sm font-medium text-slate-100">
                          {membersDisplayName(member) || "Unnamed Trainer"}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {member.role === "owner"
                            ? "Owner"
                            : member.role === "admin"
                              ? "Admin"
                              : "Member"}
                        </p>
                      </div>
                    </div>
                  </td>

                  <td className="px-3 py-3">
                    {team ? (
                      isOwner ? (
                        <select
                          value={position ?? ""}
                          disabled={isBusy}
                          onChange={(event) =>
                            onStagePosition(team.id, Number(event.target.value))
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
                              (candidate) =>
                                candidate === position ||
                                !takenPositions.has(candidate),
                            )
                            .map((candidate) => (
                              <option key={candidate} value={candidate}>
                                #{candidate}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <span className="text-slate-300">
                          {position != null ? `Pick #${position}` : "—"}
                        </span>
                      )
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
