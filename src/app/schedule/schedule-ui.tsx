/*
 * Presentational pieces shared by the schedule page and its tab components.
 */
"use client";

import type { ReactNode } from "react";

import { Card } from "@/components/card";
import { MemberAvatar } from "@/components/member-avatar";

/**
 * A player's avatar: their uploaded image or an initial-based circle.
 *
 * Delegates to the shared avatar so a member's initials pick up the colour they
 * chose, while keeping the winner highlight a matchup card adds.
 *
 * @param props.name - Display name used for the fallback initial.
 * @param props.nameColor - The member's chosen name colour.
 * @param props.avatarUrl - Their uploaded avatar, or null.
 * @param props.initials - Stored initials, or null to derive them from the name.
 * @param props.size - Square pixel dimensions.
 * @param props.winner - Whether to highlight the ring.
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
 * @param props.title - The section heading.
 * @param props.action - An optional control aligned to the right of the heading.
 * @param props.children - The section body.
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
