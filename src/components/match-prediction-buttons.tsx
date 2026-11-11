/*
 * A compact winner-pick button for one side of a matchup.
 *
 * Each card places one of these under its side's roster, so the button sits
 * beneath the player it picks instead of in a separate two-column control. The
 * dashboard Schedule panel, the schedule page's Upcoming matches list, and the
 * detailed Matchup card all share it.
 */
"use client";

import type { MouseEvent } from "react";

import { MemberName } from "@/components/member-name";

/** One side of a matchup the member can pick to win. */
export type MatchPredictionSide = {
  /** The team the pick is stored against. */
  teamId: string;
  /** The member-facing name shown on the button. */
  name: string;
};

/** Props for {@link MatchPredictionButton}. */
export interface MatchPredictionButtonProps {
  /** The side this button picks. */
  side: MatchPredictionSide;
  /** The member's current pick, or null when they have not picked yet. */
  predictedTeamId: string | null;
  /**
   * How many members picked each side, keyed by team id. A side nobody picked is
   * absent from the map rather than stored as zero.
   */
  predictionCounts: Record<string, number>;
  /** Disables the button while a pick is being saved. */
  disabled?: boolean;
  /** Called with the chosen team id. */
  onPick: (teamId: string) => void;
}

/**
 * Renders one winner-pick button, centered under its player's roster.
 *
 * @param props - {@link MatchPredictionButtonProps}
 * @returns The pick button.
 */
export function MatchPredictionButton({
  side,
  predictedTeamId,
  predictionCounts,
  disabled = false,
  onPick,
}: MatchPredictionButtonProps) {
  const picked = predictedTeamId === side.teamId;
  const count = predictionCounts[side.teamId] ?? 0;

  /**
   * Picks the side without letting the click reach a card-level handler that
   * might also select the matchup.
   *
   * @param event - The button click.
   */
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    onPick(side.teamId);
  }

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={picked}
      title={`Pick ${side.name} to win (${count} ${
        count === 1 ? "member has" : "members have"
      } predicted)`}
      onClick={handleClick}
      className={`mx-auto flex w-full max-w-[14rem] items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
        picked
          ? "border-emerald-500 bg-emerald-500/15 text-emerald-200"
          : "border-slate-700 bg-slate-800 text-slate-200 hover:border-amber-500/60 hover:bg-slate-700"
      }`}
    >
      <span className="truncate">
        {picked ? "Your pick: " : "Pick "}
        <MemberName name={side.name} />
      </span>
      <span
        className={`shrink-0 text-[10px] font-semibold ${
          picked ? "text-emerald-300/80" : "text-slate-400"
        }`}
      >
        {count} {count === 1 ? "pick" : "picks"}
      </span>
    </button>
  );
}
