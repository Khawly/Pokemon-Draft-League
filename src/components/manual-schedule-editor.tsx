/*
 * Week-by-week editor for an owner-supplied regular season schedule.
 *
 * The random generator decides every pairing, which is the right default but useless when
 * the league has already agreed its fixtures elsewhere. This is the manual path: one card
 * per week, a row per game, two team pickers and a clear button, with the week's resting
 * teams named so an owner can see who has a bye instead of inferring it from the rows.
 *
 * Every week opens with the same full slate of pickers as week one, so the season can be
 * filled in week order without adding rows to each card first. A row whose sides are not
 * both chosen is ignored on save, which is also how a team is given the week off.
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
 * How many pairing rows a full slate needs: one per pair of teams, never zero.
 *
 * An odd team count rounds down and leaves the extra team resting, which the
 * resting line on each week card already names.
 *
 * @param teamCount - Number of schedulable teams.
 * @returns The number of rows one week card should show.
 */
function fullSlateRows(teamCount: number): number {
  return Math.max(1, Math.floor(teamCount / 2));
}

/**
 * Builds the editor's opening rows, one week card per week of the season.
 *
 * Saved pairings are kept as they are. A week with nothing saved is padded to a
 * full slate of blank pickers so every card matches week one's format. When the
 * season has no saved schedule at all, week one instead keeps its drafting
 * convenience: teams are paired in draft order rather than left blank.
 *
 * @param initialGames - Pairings already saved for the season.
 * @param teams - Schedulable teams, in display order.
 * @param weeks - How many week cards the season has.
 * @returns Rows in week order, ready to seed state.
 */
function buildInitialRows(
  initialGames: ManualScheduleGame[],
  teams: Array<{ id: string }>,
  weeks: number,
): DraftRow[] {
  const perWeek = fullSlateRows(teams.length);
  const rows: DraftRow[] = [];

  for (let week = 1; week <= weeks; week += 1) {
    const saved = initialGames.filter((game) => game.week === week);

    rows.push(
      ...saved.map((game, index) => ({
        ...game,
        key: `week-${week}-row-${index}`,
      })),
    );

    for (let index = saved.length; index < perWeek; index += 1) {
      const isOpeningWeek = initialGames.length === 0 && week === 1;
      rows.push({
        key: `week-${week}-row-${index}`,
        week,
        player_1_team_id: isOpeningWeek ? (teams[index * 2]?.id ?? "") : "",
        player_2_team_id: isOpeningWeek
          ? (teams[index * 2 + 1]?.id ?? "")
          : "",
      });
    }
  }

  return rows;
}

/**
 * Appends blank rows to any week that is short of a full slate.
 *
 * Used when the owner changes the number of regular season weeks while the
 * editor is open, so the new cards arrive in the same shape as the rest. Rows
 * are only ever added, never removed, so the existing keys stay put.
 *
 * @param rows - Rows currently in state.
 * @param weeks - How many week cards the season now has.
 * @param perWeek - Rows a full slate needs.
 * @returns The same rows plus any padding, or the original array when complete.
 */
function padToFullSlate(
  rows: DraftRow[],
  weeks: number,
  perWeek: number,
): DraftRow[] {
  const padding: DraftRow[] = [];

  for (let week = 1; week <= weeks; week += 1) {
    const existing = rows.filter((row) => row.week === week).length;

    for (let index = existing; index < perWeek; index += 1) {
      padding.push({
        key: `week-${week}-row-${index}`,
        week,
        player_1_team_id: "",
        player_2_team_id: "",
      });
    }
  }

  return padding.length > 0 ? [...rows, ...padding] : rows;
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
  const perWeek = fullSlateRows(teams.length);

  // Every week opens at the season's full slate size, so the editor never asks
  // the owner to build a card up row by row before it can be filled in.
  const [rows, setRows] = useState<DraftRow[]>(() =>
    buildInitialRows(initialGames, teams, weeks),
  );

  /*
   * Raising the week count while the editor is open adds cards that did not
   * exist when the rows were seeded. Padded during render rather than from an
   * effect so the new card arrives complete on its first frame; the guard keeps
   * it a one-off adjustment per week count.
   */
  const [paddedWeeks, setPaddedWeeks] = useState(weeks);

  if (paddedWeeks !== weeks) {
    setPaddedWeeks(weeks);
    setRows((previous) => padToFullSlate(previous, weeks, perWeek));
  }

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

  // A cleared row keeps its place in the week's slate: both sides go back to
  // "Select team" and the row is simply ignored on save. With no add control the
  // grid has to stay whole, and an empty pairing is already how a bye is written.
  const clear = (key: string) =>
    setRows((previous) =>
      previous.map((row) =>
        row.key === key
          ? { ...row, player_1_team_id: "", player_2_team_id: "" }
          : row,
      ),
    );

  const canSave = !saving && problems.length === 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Pick each week&apos;s matchups by hand. Every week starts with a full
        slate of pairings. A team can play at most once in a week, and any team
        you leave out rests that week, so clear a pairing to give teams a bye.
        Saving replaces the season&apos;s current schedule, including any results
        already recorded.
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
              </div>

              {weekRows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-800 px-2 py-3 text-xs text-slate-500">
                  No matchups this week.
                </p>
              ) : (
                <div className="space-y-2">
                  {weekRows.map((row) => {
                    const pairingLabel =
                      row.player_1_team_id && row.player_2_team_id
                        ? `${nameOf(row.player_1_team_id)} and ${nameOf(
                            row.player_2_team_id,
                          )}`
                        : "this pairing";

                    return (
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
                          aria-label={`Clear week ${week}'s matchup between ${pairingLabel}`}
                          onClick={() => clear(row.key)}
                          className="shrink-0 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-400 transition hover:border-rose-700 hover:text-rose-300"
                        >
                          Clear
                        </button>
                      </div>
                    );
                  })}
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