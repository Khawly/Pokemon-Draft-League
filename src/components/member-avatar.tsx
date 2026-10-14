/*
 * A member's avatar: their uploaded picture, or their initials in their chosen colour.
 *
 * Every page drew its own version of this, and they had drifted: three different
 * circle sizes, two different default backgrounds, and initials in three different
 * fallback colours. That made it impossible to colour initials consistently, and it
 * is the one place a member's chosen colour is most visible when they have no image
 * at all.
 *
 * The colour is applied to the initials and tinted into the circle rather than only
 * used for the letters, because a grey disc with coloured letters reads as a mistake
 * next to the same person's name rendered in full colour a few pixels away.
 */
"use client";

import { nameColorAvatarClass, nameColorClass } from "@/lib/name-colors";
import { resolveAvatarInitials } from "@/lib/avatar-initials";

/** Props for the {@link MemberAvatar} component. */
export interface MemberAvatarProps {
  /** The member's display name, used for the alt text and the fallback initial. */
  name: string | null | undefined;
  /** The member's stored colour. Unrecognised values fall back to the default. */
  color?: string | null;
  /** The member's uploaded avatar, or null to show initials. */
  avatarUrl?: string | null;
  /**
   * Initials the member chose for themselves.
   *
   * Falls back to the shared derivation from the display name when unset, so a
   * member who never picked any gets the same letters the settings page shows them.
   */
  initials?: string | null;
  /** Circle diameter in pixels. */
  size?: number;
  /** Typography size for the initials, which should scale with the circle. */
  textClassName?: string;
  /**
   * Force-remount key for the image element.
   *
   * The settings preview uses this to bust the browser cache after an upload, since
   * the new picture lands at a new URL only once storage has settled.
   */
  imageKey?: number | string;
  /**
   * Called when the image fails to load, so the caller can drop a broken URL and
   * fall back to initials instead of showing an empty circle.
   */
  onImageError?: () => void;
  /**
   * Renders the winner highlight, which replaces the colour entirely.
   *
   * A win is a momentary, meaningful state, so it outranks a standing preference: an
   * emerald disc for the player who just won is clearer than their usual tint.
   */
  winner?: boolean;
  /** Classes for the containing circle, e.g. to add a ring. */
  className?: string;
}

/**
 * Renders a member's avatar image, or their initials in their chosen colour.
 *
 * @param props - {@link MemberAvatarProps}
 * @returns The avatar circle, sized in pixels to match the surrounding layout.
 */
export function MemberAvatar({
  name,
  color,
  avatarUrl,
  initials,
  size = 40,
  textClassName = "text-sm",
  imageKey,
  onImageError,
  winner = false,
  className,
}: MemberAvatarProps) {
  const label = name?.trim() || "Unnamed";
  const letter = resolveAvatarInitials(initials, label);

  /*
   * The container is sized inline because callers pass pixel dimensions that do not
   * line up with Tailwind's size scale (28, 36, 40, 48, 80, 88 all occur here). Only
   * the colours are classes, which keeps them statically visible to the compiler.
   */
  const colors = winner
    ? "border-emerald-400 bg-emerald-500 text-slate-950"
    : nameColorAvatarClass(color) || "bg-slate-800";

  const classes = [
    "flex shrink-0 items-center justify-center overflow-hidden rounded-full border font-bold",
    textClassName,
    colors,
    /*
     * A letter needs a legible colour, so the chosen one is applied here rather than
     * inherited: the circle's own background class is a background utility and says
     * nothing about the text. The winner state keeps its dark-on-emerald lettering,
     * which is why it opts out.
     */
    !winner ? nameColorClass(color) || "text-slate-200" : "",
    className,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return (
    <span style={{ width: size, height: size }} className={classes}>
      {avatarUrl ? (
        <img
          key={imageKey}
          src={avatarUrl}
          alt={label}
          onError={onImageError}
          className="h-full w-full object-cover"
        />
      ) : (
        <span>{letter}</span>
      )}
    </span>
  );
}