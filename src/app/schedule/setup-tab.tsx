/*
 * The Setup tab: schedule method, regular season shape, playoff shape, and the
 * toilet-bowl toggle.
 */
"use client";

import { ManualScheduleEditor } from "@/components/manual-schedule-editor";
import * as scheduleApi from "@/lib/supabase/schedule";
import type { SchedulePageGoods } from "@/lib/supabase/schedule";

import { Field, SectionCard } from "./schedule-ui";

/** The setup form's values. */
export interface ScheduleFormState {
  weeks: number;
  matchFormat: "single" | "best_of_3";
  playoffTeams: number;
  playoffMatchFormat: "single" | "best_of_3";
  playoffFormat: "single_elimination" | "double_elimination";
}

/** Props for the {@link SetupTab} component. */
export interface SetupTabProps {
  goods: SchedulePageGoods;
  scheduleMode: "automatic" | "manual";
  onScheduleModeChange: (mode: "automatic" | "manual") => void;
  form: ScheduleFormState;
  onFormChange: (form: ScheduleFormState) => void;
  maxPlayoffTeams: number;
  /** First-round byes implied by the chosen playoff field. */
  byes: number;
  /** True while generating or when the form is invalid. */
  generateDisabled: boolean;
  onGenerateSchedule: () => void;
  isSavingToilet: boolean;
  onToggleToiletBowl: (enabled: boolean) => void;
  isSavingManual: boolean;
  onSaveManualSchedule: (games: scheduleApi.ManualScheduleGame[]) => void;
}

/**
 * Renders the schedule setup tab.
 *
 * @param props - {@link SetupTabProps}
 * @returns The setup tab.
 */
export function SetupTab({
  goods,
  scheduleMode,
  onScheduleModeChange,
  form,
  onFormChange,
  maxPlayoffTeams,
  byes,
  generateDisabled,
  onGenerateSchedule,
  isSavingToilet,
  onToggleToiletBowl,
  isSavingManual,
  onSaveManualSchedule,
}: SetupTabProps) {
  return (
    <SectionCard
      title="Schedule setup"
      action={
        scheduleMode === "automatic" ? (
          <button
            type="button"
            disabled={generateDisabled}
            onClick={onGenerateSchedule}
            className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Generate schedule
          </button>
        ) : null
      }
    >
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-400">Schedule method</span>
        {(
          [
            ["automatic", "Automatic"],
            ["manual", "Manual"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onScheduleModeChange(value)}
            className={`rounded-lg border px-3 py-1.5 text-sm transition ${
              scheduleMode === value
                ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
                : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        <Field label="Regular season weeks">
          <input
            type="number"
            min={1}
            max={52}
            step={1}
            value={form.weeks}
            onChange={(event) =>
              onFormChange({ ...form, weeks: Number(event.target.value) })
            }
            required
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
          />
        </Field>
        <Field label="Match format">
          <select
            value={form.matchFormat}
            onChange={(event) =>
              onFormChange({
                ...form,
                matchFormat: event.target.value as "single" | "best_of_3",
              })
            }
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
          >
            <option value="single">Single Game</option>
            <option value="best_of_3">Best of 3</option>
          </select>
        </Field>
        <Field label={`Playoff teams (max ${maxPlayoffTeams})`}>
          <input
            type="number"
            min={0}
            max={maxPlayoffTeams}
            step={1}
            value={form.playoffTeams}
            onChange={(event) =>
              onFormChange({
                ...form,
                playoffTeams: Number(event.target.value),
              })
            }
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
          />
        </Field>
        <Field label="Playoff match format">
          <select
            value={form.playoffMatchFormat}
            onChange={(event) =>
              onFormChange({
                ...form,
                playoffMatchFormat: event.target.value as
                  | "single"
                  | "best_of_3",
              })
            }
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
          >
            <option value="single">Single Game</option>
            <option value="best_of_3">Best of 3</option>
          </select>
        </Field>
        <Field label="Playoff format">
          <select
            value={form.playoffFormat}
            onChange={(event) =>
              onFormChange({
                ...form,
                playoffFormat: event.target.value as
                  | "single_elimination"
                  | "double_elimination",
              })
            }
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
          >
            <option value="single_elimination">Single Elimination</option>
            <option value="double_elimination">Double Elimination</option>
          </select>
        </Field>
        <Field label="First-round byes (calculated)">
          <div className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300">
            {form.playoffTeams >= 2 && form.playoffTeams <= maxPlayoffTeams
              ? byes
              : "—"}
          </div>
        </Field>
      </div>

      <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
        <label className="flex items-center justify-between gap-3 text-sm text-slate-200">
          <span>Toilet Bowl bracket</span>
          <input
            type="checkbox"
            checked={goods.settings?.enable_toilet_bowl === true}
            disabled={isSavingToilet}
            onChange={(event) => onToggleToiletBowl(event.target.checked)}
            className="h-4 w-4 accent-amber-500"
          />
        </label>
        <p className="mt-2 text-xs text-slate-500">
          Every team that misses the playoff field plays its own
          single-elimination consolation bracket, seeded by the regular season
          standings. It appears on the Playoffs tab and advances with the same
          button. Its winner does not get the champion crown.
        </p>
      </div>
      {scheduleMode === "automatic" ? (
        <p className="mt-4 text-sm text-slate-400">
          Generate button is enabled once regular season weeks is a valid integer
          of at least 1. Generating replaces the current season&apos;s schedule
          and draws every matchup and home/away side at random, so regenerating
          produces a different schedule. Each team meets each other team once per
          round-robin pass, so weeks beyond a full pass re-draw the matchups
          instead of replaying them. The playoff bracket is advanced from the
          Playoffs tab once the draft is complete.
        </p>
      ) : (
        <div className="mt-6 border-t border-slate-800 pt-5">
          <ManualScheduleEditor
            teams={goods.teams.map((team) => ({
              id: team.id,
              name: team.owner_name?.trim() || team.team_name,
            }))}
            weeks={Math.max(1, form.weeks)}
            initialGames={goods.matches
              .filter(
                (match) => !match.is_playoff && !scheduleApi.isByeMatch(match),
              )
              .map((match) => ({
                week: match.week_number,
                player_1_team_id: match.player_1_team_id,
                player_2_team_id: match.player_2_team_id ?? "",
              }))
              .filter((game) => game.player_2_team_id !== "")}
            saving={isSavingManual}
            onSave={onSaveManualSchedule}
          />
        </div>
      )}
    </SectionCard>
  );
}
