/*
 * The owner-only log of every match-time proposal made this season.
 */
"use client";

import { LoadingGif } from "@/components/loading-gif";
import { MemberName } from "@/components/member-name";
import { formatDateTimeInZone } from "@/lib/datetime";
import * as scheduleApi from "@/lib/supabase/schedule";

import { SectionCard } from "./schedule-ui";

/*
 * Wider than the page default because the log stacks an offered time, a proposed
 * time, and an answered time in adjacent rows. The weekday anchors each to a day
 * of the week, and the short zone name says which wall clock a converted time is.
 */
const LOG_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/** Props for the {@link ProposalHistoryPanel} component. */
export interface ProposalHistoryPanelProps {
  groups: scheduleApi.ProposalHistoryGroup[];
  /** The owner's zone, so every offered time is shown in one wall clock. */
  timeZone: string;
  /** The season's first playoff week, so a bracket round reads as a week. */
  firstPlayoffWeek: number | null;
  isLoading: boolean;
  loadError: string | null;
}

/**
 * Renders the proposal history, or its loading/error/empty state.
 *
 * @param props - {@link ProposalHistoryPanelProps}
 * @returns The proposal history panel.
 */
export function ProposalHistoryPanel({
  groups,
  timeZone,
  firstPlayoffWeek,
  isLoading,
  loadError,
}: ProposalHistoryPanelProps) {
  if (isLoading) {
    return (
      <SectionCard title="Match proposal history">
        <p className="text-sm text-slate-400">
          <LoadingGif label="Loading the match proposal log" />
        </p>
      </SectionCard>
    );
  }

  if (loadError) {
    return (
      <SectionCard title="Match proposal history">
        <p className="text-sm text-rose-300">{loadError}</p>
      </SectionCard>
    );
  }

  if (groups.length === 0) {
    return (
      <SectionCard title="Match proposal history">
        <p className="text-sm text-slate-400">
          No match times have been proposed this season.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Match proposal history">
      <p className="mb-4 text-sm text-slate-400">
        Every proposed match time this season and how it was answered. Times are
        converted into your own zone and labelled with it, since each was
        proposed by whichever player suggested it.
      </p>
      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.week_number}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.15em] text-slate-300">
              {scheduleApi.proposalWeekLabel(group, firstPlayoffWeek)}
            </h3>
            <div className="space-y-2">
              {group.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex flex-wrap items-center gap-x-1 text-sm text-slate-200">
                      <MemberName
                        name={entry.player_1_name}
                        color={entry.player_1_name_color}
                      />
                      <span>vs</span>
                      <MemberName
                        name={entry.player_2_name}
                        color={entry.player_2_name_color}
                      />
                    </p>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${scheduleApi.proposalOutcomeTone(entry.status)}`}
                    >
                      {scheduleApi.proposalOutcomeLabel(entry)}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-400 sm:grid-cols-2">
                    <div className="flex gap-1.5">
                      <dt className="text-slate-500">Offered time</dt>
                      <dd className="text-slate-300">
                        {formatDateTimeInZone(
                          entry.proposed_at,
                          timeZone,
                          LOG_TIMESTAMP_FORMAT,
                        )}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-slate-500">Proposed by</dt>
                      <dd className="text-slate-300">
                        <MemberName
                          name={entry.proposed_by_name}
                          color={entry.proposed_by_name_color}
                        />
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-slate-500">Proposed at</dt>
                      <dd className="text-slate-300">
                        {formatDateTimeInZone(
                          entry.created_at,
                          timeZone,
                          LOG_TIMESTAMP_FORMAT,
                        )}
                      </dd>
                    </div>
                    {entry.responded_at && (
                      <div className="flex gap-1.5">
                        <dt className="text-slate-500">Answered at</dt>
                        <dd className="text-slate-300">
                          {formatDateTimeInZone(
                            entry.responded_at,
                            timeZone,
                            LOG_TIMESTAMP_FORMAT,
                          )}
                        </dd>
                      </div>
                    )}
                    {entry.notes && (
                      <div className="flex gap-1.5 sm:col-span-2">
                        <dt className="shrink-0 text-slate-500">Notes</dt>
                        <dd className="text-slate-300">{entry.notes}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
