/*
 * The Playoffs tab: bracket, owner controls, and the champion line.
 */
"use client";

import { MemberName } from "@/components/member-name";
import { PlayoffBracket } from "@/components/playoff-bracket";
import type {
  SchedulePageGoods,
  SchedulePlayoffTemplateRow,
} from "@/lib/supabase/schedule";

import { SectionCard } from "./schedule-ui";

/** Props for the {@link PlayoffsTab} component. */
export interface PlayoffsTabProps {
  /** The loaded page payload. */
  goods: SchedulePageGoods;
  /** True while a bracket mutation is in flight. */
  isBusy: boolean;
  /** Rebuilds the bracket from scratch. */
  onResetPlayoffs: () => void;
  /** Settles the next bracket round. */
  onAdvancePlayoffs: () => void;
  /** The bracket template rows. */
  rows: SchedulePlayoffTemplateRow[];
  /** Resolves a team id to its display name and colour. */
  resolveTeam: (
    teamId: string | null,
  ) => { name: string; color: string | null } | null;
  /** The crowned team, when the final has been decided. */
  championWinner: { name: string; color: string | null } | null;
}

/**
 * Renders the playoff bracket tab.
 *
 * @param props - {@link PlayoffsTabProps}
 * @returns The playoffs tab.
 */
export function PlayoffsTab({
  goods,
  isBusy,
  onResetPlayoffs,
  onAdvancePlayoffs,
  rows,
  resolveTeam,
  championWinner,
}: PlayoffsTabProps) {
  return (
    <SectionCard
      title="Playoff bracket"
      action={
        goods.isOwner &&
        goods.isCurrentSeason &&
        goods.season?.status === "draft_complete" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isBusy}
              onClick={onResetPlayoffs}
              title="Delete every playoff match and result so the bracket can be rebuilt"
              className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-rose-800 hover:text-rose-300 disabled:opacity-50"
            >
              Reset playoffs
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={onAdvancePlayoffs}
              className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
            >
              Advance playoffs
            </button>
          </div>
        ) : undefined
      }
    >
      {goods.settings && (
        <p className="mb-4 text-sm text-slate-400">
          {goods.settings.playoff_team_count} teams •{" "}
          {goods.settings.playoff_format === "single_elimination"
            ? "Single elimination"
            : "Double elimination"}{" "}
          •{" "}
          {goods.settings.playoff_match_format === "single"
            ? "Single games"
            : "Best of 3"}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">
          {goods.playoffTemplate?.unavailableReason ??
            (goods.season?.status === "draft_complete"
              ? "No bracket is defined for this league yet."
              : "The playoff bracket appears after the draft is complete.")}
        </p>
      ) : (
        <PlayoffBracket
          rows={rows}
          matches={goods.matches.filter((match) => match.is_playoff)}
          resolveTeam={resolveTeam}
        />
      )}

      {championWinner && (
        <p className="mt-4 rounded-xl border border-emerald-800 bg-emerald-900/30 p-3 text-sm text-emerald-200">
          Champion:{" "}
          <strong>
            <MemberName
              name={championWinner.name}
              color={championWinner.color}
            />
          </strong>{" "}
          <span className="text-emerald-400">— League champion</span>
        </p>
      )}
    </SectionCard>
  );
}
