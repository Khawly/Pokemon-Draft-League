/*
 * Ability tooltip chip for the Pokemon Draft League.
 *
 * Renders an ability name as a small clickable/hoverable chip that shows a
 * portal-based tooltip explaining what the ability does. The tooltip is
 * rendered into <body> rather than inside the table so table scroll containers
 * that clip absolutely-positioned content don't cut the popup off. Mouse users
 * reveal it by hovering; touch/keyboard users by tapping or focusing the chip.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatAbilityName, getAbilityDescription } from "@/lib/pokeapi";

/** How far below the chip the tooltip sits, in pixels. */
const TOOLTIP_GAP_PX = 6;

/** Widest the tooltip is allowed to get, in pixels. */
const TOOLTIP_MAX_WIDTH = 320;

/**
 * A single ability chip that explains itself on hover/focus.
 *
 * @param props - Component props.
 * @param props.slug - The PokeAPI ability slug to show, e.g. "lightning-rod".
 * @returns The chip button plus its portal-rendered tooltip when open.
 */
export function AbilityTooltip({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const description = getAbilityDescription(slug);
  const label = formatAbilityName(slug);

  const reveal = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPosition({
      top: rect.bottom + TOOLTIP_GAP_PX,
      left: Math.max(TOOLTIP_GAP_PX, rect.left),
    });
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`${label} ability details`}
      onMouseEnter={reveal}
      onMouseLeave={hide}
      onFocus={reveal}
      onBlur={hide}
      onClick={reveal}
      className="pointer-events-auto inline-flex max-w-full items-center rounded px-1 py-0.5 text-left transition hover:bg-slate-700/50 hover:text-amber-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/60"
    >
      <span className="truncate">{label}</span>
      {open && typeof document !== "undefined" && position !== null
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-50 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 shadow-xl shadow-slate-950/60"
              style={{ top: position.top, left: position.left, maxWidth: TOOLTIP_MAX_WIDTH }}
            >
              <span className="block text-xs font-semibold text-amber-200">{label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-slate-300">
                {description ?? "No description found for this ability."}
              </span>
            </div>,
            document.body,
          )
        : null}
    </button>
  );
}