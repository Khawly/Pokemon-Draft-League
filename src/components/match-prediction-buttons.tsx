/*
 * Compact winner-pick buttons for a matchup card.
 *
 * The detailed Matchup card, the dashboard's Schedule panel, and the schedule
 * page's Upcoming matches list all ask the same question, so they share one
 * control: two side-by-side buttons where the selected side is the member's
 * current pick. The caller owns whether the control is shown, because each of
 * those surfaces has its own explanation for a closed matchup.
 */
import type { MouseEvent } from "react";

/** One side of a matchup the member can pick to win. */
export type MatchPredictionSide = {
  /** The team the pick is stored against. */
  teamId: string;
  /** The member-facing name shown on the button. */
  name: string;
};

/** Props for {@link MatchPredictionButtons}. */
export interface MatchPredictionButtonsProps {
  /** The first team in the matchup. */
  playerOne: MatchPredictionSide;
  /** The second team, or null on a one-sided playoff bye. */
  playerTwo: MatchPredictionSide | null;
  /** The member's current pick, or null when they have not picked yet. */
  predictedTeamId: string | null;
  /** Disables both buttons while a pick is being saved. */
  disabled?: boolean;
  /** Called with the chosen team id. */
  onPick: (teamId: string) => void;
}

/**
 * Renders the two winner-pick buttons for one matchup.
 *
 * @param props - {@link MatchPredictionButtonsProps}
 * @returns The picker, or just the first side when the matchup is a bye.
 */
export function MatchPredictionButtons({
  playerOne,
  playerTwo,
  predictedTeamId,
  disabled = false,
  onPick,
}: MatchPredictionButtonsProps) {
  const sides = playerTwo ? [playerOne, playerTwo] : [playerOne];

  /**
   * Picks a side without letting the click reach a card-level handler that
   * might also select the matchup.
   *
   * @param event - The button click.
   * @param teamId - The side being picked.
   */
  function handleClick(
    event: MouseEvent<HTMLButtonElement>,
    teamId: string,
  ): void {
    event.stopPropagation();
    onPick(teamId);
  }

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {sides.map((side) => {
        const picked = predictedTeamId === side.teamId;

        return (
          <button
            key={side.teamId}
            type="button"
            disabled={disabled}
            aria-pressed={picked}
            title={`Pick ${side.name} to win`}
            onClick={(event) => handleClick(event, side.teamId)}
            className={`min-w-0 truncate rounded-lg border px-2 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
              picked
                ? "border-emerald-500 bg-emerald-500/15 text-emerald-200"
                : "border-slate-700 bg-slate-800 text-slate-200 hover:border-amber-500/60 hover:bg-slate-700"
            }`}
          >
            {picked ? "Your pick: " : ""}
            {side.name}
          </button>
        );
      })}
    </div>
  );
}
