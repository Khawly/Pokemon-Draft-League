/*
 * Presentational pieces shared by the schedule page and its tab components.
 */
"use client";

import type { ReactNode } from "react";

import { Card } from "@/components/card";
import { MemberAvatar } from "@/components/member-avatar";
import type * as scheduleApi from "@/lib/supabase/schedule";

/**
 * A player's avatar: their uploaded image or an initial-based circle.
 *
 * Delegates to the shared avatar so a member's initials pick up the colour they
 * chose, while keeping the winner highlight a matchup card adds.
 *
 * @returns The avatar.
 */
export function Avatar({
  name,
  nameColor,
  avatarUrl,
  initials,
  size = 36,
  winner = false,
}: {
  name: string;
  nameColor?: string | null;
  avatarUrl: string | null;
  initials?: string | null;
  size?: number;
  winner?: boolean;
}) {
  return (
    <MemberAvatar
      name={name}
      color={nameColor}
      avatarUrl={avatarUrl}
      initials={initials}
      size={size}
      winner={winner}
    />
  );
}

/**
 * Wraps a schedule section in the app's card styling.
 *
 * @returns The card.
 */
export function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-4 shadow-lg sm:p-6 shadow-slate-950/30">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-bold text-white">{title}</h2>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

/**
 * A labelled form field wrapper.
 *
 * @returns The labelled field.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-slate-400">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * The winning side of a match.
 *
 * @param match - The matchup the winning side belongs to.
 * @param teamId - The winning team's id.
 * @returns The winner's display name and stored name colour.
 */
export function sideByTeamId(
  match: scheduleApi.ScheduleMatch,
  teamId: string,
): { name: string; color: string | null } {
  return teamId === match.player_1_team_id
    ? { name: match.player_1_name, color: match.player_1_name_color }
    : { name: match.player_2_name, color: match.player_2_name_color };
}
