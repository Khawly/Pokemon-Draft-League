/*
 * Week-by-week editor for an owner-supplied regular season schedule.
 *
 * The random generator decides every pairing, which is the right default but useless when
 * the league has already agreed its fixtures elsewhere. This is the manual path: one card
 * per week, a row per game, two team pickers and a remove button, with the week's resting
 * teams named so an owner can see who has a bye instead of inferring it from the rows.
 *
 * Validation is deliberately eager and non-blocking: every problem is listed at once and
 * the save button is disabled while any remain. Waiting until save to name the third
 * duplicate team in a week would mean fixing them one round trip at a time.
 */
"use client";

import { useMemo, useState } from "react";

import type { ManualScheduleGame } from "@/lib/supabase/schedule";
import { inspectManualSchedule } from "@/lib/supabase/schedule";

/** A row being edited. Carries a local id so React keys survive reordering and removal. */
type DraftRow = ManualScheduleGame & { key: string };

/** Props for the {@link ManualScheduleEditor} component. */
export interface ManualScheduleEditorProps {
  /** Every team that can be scheduled, as id and display name. */
  teams: Array<{ id: string; name: string }>;
  /** How many weeks the regular season runs. */
  weeks: number;
  /** The pairings already saved, used to seed the editor. */
  initialGames: ManualScheduleGame[];
  /** True while a save is in flight. */
  saving: boolean;
  /** Called with the finished pairings when the owner saves. */
  onSave: (games: ManualScheduleGame[]) => void;
}

/** One team picker. An unset side is the empty string, which reads as "not chosen". */
function TeamSelect({
  value,
  teams,
  label,
  onChange,
}: {
  value: string;
  teams: Array<{ id: string; name: string }>;
  label: string;
  onChange: (teamId: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-amber-500"
    >
      <option value="">Select team</option>
      {teams.map((team) => (
        <option key={team.id} value={team.id}>
          {team.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Edits and saves an owner-supplied regular season schedule.
 *
 * @param props - {@link ManualScheduleEditorProps}
 * @returns The week-by-week grid, its validation, and the save control.
 */
export function ManualScheduleEditor({
  teams,
  weeks,
  initialGames,
  saving,
  onSave,
}: ManualScheduleEditorProps) {
  // A stable key per row, assigned once, so removing a row does not remount the next one.
  const [nextKey, setNextKey] = useState(initialGames.length);

  const [rows, setRows] = useState<DraftRow[]>(() => {
    const seeded = initialGames.map((game, index) => ({
      ...game,
      key: `row-${index}`,
    }));

    if (seeded.length > 0) {
      return seeded;
    }

    // Nothing saved yet: offer a full slate for the opening week rather than a blank
    // page, so pairing a league does not begin with pressing "add" ten times.
    const perWeek = Math.floor(teams.length / 2);
    return Array.from({ length: perWeek }, (_, index) => ({
      key: `row-${index}`,
      week: 1,
      player_1_team_id: teams[index * 2]?.id ?? "",
      player_2_team_id: teams[index * 2 + 1]?.id ?? "",
    }));
  });

  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);

  /*
   * Only rows with both sides chosen are part of the schedule. An empty row is a row the
   * owner has not used, so it is ignored rather than reported; a half-filled one is a
   * mistake and is called out.
   */
  const completeGames = useMemo(
    () =>
      rows
        .filter((row) => row.player_1_team_id && row.player_2_team_id)
        .map<ManualScheduleGame>((row) => ({
          week: row.week,
          player_1_team_id: row.player_1_team_id,
          player_2_team_id: row.player_2_team_id,
        })),
    [rows],
  );

  const halfFilled = rows.filter(
    (row) => Boolean(row.player_1_team_id) !== Boolean(row.player_2_team_id),
  );

  const inspection = useMemo(
    () => inspectManualSchedule(completeGames, weeks, teamIds),
    [completeGames, weeks, teamIds],
  );

  const problems = [
    ...inspection.problems,
    ...halfFilled.map(
      (row) => `Week ${row.week} has a matchup with only one team chosen.`,
    ),
  ];

  const nameOf = useMemo(() => {
    const lookup = new Map(teams.map((team) => [team.id, team.name]));
    return (teamId: string) => lookup.get(teamId) ?? "Unknown team";
  }, [teams]);

  const update = (key: string, patch: Partial<DraftRow>) =>
    setRows((previous) =>
      previous.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );

  const remove = (key: string) =>
    setRows((previous) => previous.filter((row) => row.key !== key));

  const add = (week: number) => {
    setRows((previous) => [
      ...previous,
      {
        key: `row-${nextKey}`,
        week,
        player_1_team_id: "",
        player_2_team_id: "",
      },
    ]);
    setNextKey((value) => value + 1);
  };

  const canSave = !saving && problems.length === 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Pick each week&apos;s matchups by hand. A team can play at most once in a
        week, and any team you leave out rests that week. Saving replaces the
        season&apos;s current schedule, including any results already recorded.
      </p>

      {problems.length > 0 && (
        <div className="rounded-xl border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">
          <p className="font-semibold">Fix these before saving</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {problems.slice(0, 8).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          {problems.length > 8 && (
            <p className="mt-1 text-xs">
              and {problems.length - 8} more.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: weeks }, (_, index) => index + 1).map((week) => {
          const weekRows = rows.filter((row) => row.week === week);
          const resting = inspection.restingByWeek.get(week) ?? [];

          return (
            <div
              key={week}
              className="rounded-xl border border-slate-800 bg-slate-950/60 p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-200">Week {week}</p>
                <button
                  type="button"
                  onClick={() => add(week)}
                  className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white"
                >
                  Add matchup
                </button>
              </div>

              {weekRows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-800 px-2 py-3 text-xs text-slate-500">
                  No matchups this week.
                </p>
              ) : (
                <div className="space-y-2">
                  {weekRows.map((row) => (
                    <div key={row.key} className="flex items-center gap-1.5">
                      <TeamSelect
                        value={row.player_1_team_id}
                        teams={teams}
                        label={`Week ${week} first team`}
                        onChange={(teamId) =>
                          update(row.key, { player_1_team_id: teamId })
                        }
                      />
                      <span className="shrink-0 text-xs text-slate-500">vs</span>
                      <TeamSelect
                        value={row.player_2_team_id}
                        teams={teams}
                        label={`Week ${week} second team`}
                        onChange={(teamId) =>
                          update(row.key, { player_2_team_id: teamId })
                        }
                      />
                      <button
                        type="button"
                        aria-label={`Remove the week ${week} matchup between ${nameOf(
                          row.player_1_team_id,
                        )} and ${nameOf(row.player_2_team_id)}`}
                        onClick={() => remove(row.key)}
                        className="shrink-0 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-400 transition hover:border-rose-700 hover:text-rose-300"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-2 text-xs text-slate-500">
                {resting.length === 0
                  ? "Every team plays this week."
                  : `Resting: ${resting.map(nameOf).join(", ")}`}
              </p>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          {completeGames.length} matchup{completeGames.length === 1 ? "" : "s"}{" "}
          across {weeks} week{weeks === 1 ? "" : "s"}.
        </p>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => onSave(completeGames)}
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save schedule"}
        </button>
      </div>
    </div>
  );
}