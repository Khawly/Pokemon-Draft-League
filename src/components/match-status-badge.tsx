/*
 * Match status pill shared by the dashboard and the schedule page.
 *
 * Keeping the labels and colours in one component is what makes a matchup read
 * the same wherever it appears, rather than the dashboard inventing its own
 * wording for the same stored status.
 */
import type { ScheduleMatch } from "@/lib/supabase/schedule";

/** Tailwind classes for each match status. */
const STATUS_STYLES: Record<string, string> = {
  unscheduled: "bg-red-500/15 text-red-300",
  scheduled: "bg-sky-500/15 text-sky-300",
  in_progress: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  forfeit: "bg-rose-500/15 text-rose-300",
  cancelled: "bg-slate-800 text-slate-500",
};

/** Human-readable label for each match status. */
const STATUS_LABELS: Record<string, string> = {
  unscheduled: "Unscheduled",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  forfeit: "Forfeit",
  cancelled: "Cancelled",
};

/**
 * Renders a match's status as the standard pill.
 *
 * @param props.status - The stored match status.
 * @returns The status pill.
 */
export function MatchStatusBadge({
  status,
}: {
  status: ScheduleMatch["status"];
}) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
        STATUS_STYLES[status] ?? "bg-slate-800 text-slate-300"
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
