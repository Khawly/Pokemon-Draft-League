/*
 * The History tab: every posted game, plus the owner-only proposal log.
 */
"use client";

import { MemberName } from "@/components/member-name";
import { formatDateTimeInZone } from "@/lib/datetime";
import * as scheduleApi from "@/lib/supabase/schedule";
import type { SchedulePageGoods } from "@/lib/supabase/schedule";

import { ProposalHistoryPanel } from "./proposal-history-panel";
import { SectionCard, sideByTeamId } from "./schedule-ui";

/** Props for the {@link HistoryTab} component. */
export interface HistoryTabProps {
  goods: SchedulePageGoods;
  history: (scheduleApi.ScheduleMatchResult & {
    match: scheduleApi.ScheduleMatch;
  })[];
  /** The season's first playoff week, for the round labels. */
  firstPlayoffWeek: number | null;
  timeZone: string;
  isBusy: boolean;
  onDeleteMatch: (match: scheduleApi.ScheduleMatch) => void;
  proposalHistoryGroups: scheduleApi.ProposalHistoryGroup[];
  proposalHistoryIsLoading: boolean;
  proposalHistoryError: string | null;
}

/**
 * Renders the match history and, for the owner, the proposal log.
 *
 * @param props - {@link HistoryTabProps}
 * @returns The history tab.
 */
export function HistoryTab({
  goods,
  history,
  firstPlayoffWeek,
  timeZone,
  isBusy,
  onDeleteMatch,
  proposalHistoryGroups,
  proposalHistoryIsLoading,
  proposalHistoryError,
}: HistoryTabProps) {
  return (
    <>
      <SectionCard title="Match history">
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">
            No games have been posted yet.
          </p>
        ) : (
          <div className="space-y-2">
            {history.map(
              ({
                match,
                id,
                winner_team_id,
                game_number,
                replay_url,
                submitted_at,
                reporter_name,
                reporter_name_color,
              }) => {
                const winner = sideByTeamId(match, winner_team_id);

                return (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm"
                  >
                    <div>
                      <p className="font-semibold text-slate-100">
                        <span className="inline-flex flex-wrap items-baseline gap-x-1">
                          <MemberName
                            name={match.player_1_name}
                            color={match.player_1_name_color}
                            showdownUsername={match.player_1_showdown_username}
                          />
                          <span>vs</span>
                          <MemberName
                            name={match.player_2_name}
                            color={match.player_2_name_color}
                            showdownUsername={match.player_2_showdown_username}
                          />
                        </span>
                        <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                          {scheduleApi.matchWeekLabel(match, firstPlayoffWeek)} •
                          Game {game_number}
                        </span>
                      </p>
                      <p className="mt-0.5 text-slate-400">
                        <span className="text-emerald-300">
                          <MemberName
                            name={winner.name}
                            color={winner.color}
                          />
                        </span>{" "}
                        won •{" "}
                        {formatDateTimeInZone(submitted_at, timeZone)}
                      </p>
                      {reporter_name && (
                        <p className="mt-0.5 text-xs text-slate-500">
                          Submitted by{" "}
                          <MemberName
                            name={reporter_name}
                            color={reporter_name_color}
                          />
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {replay_url && (
                        <a
                          href={replay_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-400 underline decoration-sky-700 hover:text-sky-300"
                        >
                          Replay
                        </a>
                      )}
                      {goods.isStaff && goods.isCurrentSeason && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => onDeleteMatch(match)}
                          className="rounded-lg border border-rose-800 px-2.5 py-1 text-xs text-rose-300 transition hover:bg-rose-900/40"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              },
            )}
          </div>
        )}
      </SectionCard>

      {goods.isOwner && (
        <ProposalHistoryPanel
          groups={proposalHistoryGroups}
          firstPlayoffWeek={firstPlayoffWeek}
          timeZone={timeZone}
          isLoading={proposalHistoryIsLoading}
          loadError={proposalHistoryError}
        />
      )}
    </>
  );
}
