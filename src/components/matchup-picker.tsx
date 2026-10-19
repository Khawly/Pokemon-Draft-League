/*
 * The Week / matchup picker on the Schedule page.
 *
 * A native `<select>` is what was here, and it had one behaviour that could not be worked
 * around: opening it scrolls to the selected option. The list is ordered latest week
 * first and the page selects the member's current-week matchup, so opening it landed
 * somewhere in the middle of a long season every time. There is no way to ask a native
 * select to start at the top.
 *
 * This renders the control instead, so the list always opens at the first entry while the
 * current matchup stays highlighted. It closes on an outside click or Escape, and the
 * trigger keeps the selected matchup visible so the page still says what is being looked
 * at without opening anything.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** One choice in the picker. */
export type MatchupPickerOption = {
  id: string;
  /** The week or round label, e.g. "Week 3" or "Playoffs (Week 2)". */
  label: string;
  /** The two sides, already resolved to display names. */
  matchup: string;
};

/** Props for the {@link MatchupPicker} component. */
export interface MatchupPickerProps {
  options: MatchupPickerOption[];
  /** The currently selected option id, or null when nothing is selected. */
  selectedId: string | null;
  /** Called with the chosen option id. */
  onSelect: (id: string) => void;
  /** Shown on the trigger when nothing is selected. */
  placeholder?: string;
  /** Hidden label text beside the trigger, for the surrounding layout. */
  caption?: string;
}

/**
 * A listbox that opens at the top of its list rather than at the current selection.
 *
 * @param props - {@link MatchupPickerProps}
 * @returns The trigger and, while open, the list.
 */
export function MatchupPicker({
  options,
  selectedId,
  onSelect,
  placeholder = "Select a match",
  caption,
}: MatchupPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((option) => option.id === selectedId) ?? null;

  /*
   * Before paint, so the list is never seen scrolled to the bottom for a frame. This is
   * the whole reason the component exists, so it is not left to the browser.
   */
  useLayoutEffect(() => {
    if (isOpen && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative flex items-center gap-2 text-sm text-slate-400">
      {caption && <span className="hidden sm:inline">{caption}</span>}

      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="flex max-w-[26rem] items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition hover:border-slate-500 focus:border-amber-500"
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? (
            <>
              <span className="text-slate-400">{selected.label}</span>
              {" • "}
              {selected.matchup}
            </>
          ) : (
            <span className="text-slate-500">{placeholder}</span>
          )}
        </span>
        <span aria-hidden="true" className="text-slate-500">
          ▾
        </span>
      </button>

      {isOpen && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={caption ?? placeholder}
          className="absolute top-full right-0 z-40 mt-1 max-h-80 w-[26rem] overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 py-1 shadow-2xl shadow-slate-950/60"
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-slate-500">No matches yet.</p>
          ) : (
            options.map((option) => {
              const isSelected = option.id === selectedId;

              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onSelect(option.id);
                    setIsOpen(false);
                  }}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-slate-800/70 ${
                    isSelected
                      ? "bg-amber-500/10 text-amber-100"
                      : "text-slate-200"
                  }`}
                >
                  <span className="shrink-0 text-xs text-slate-400">
                    {option.label}
                  </span>
                  <span className="min-w-0 truncate">{option.matchup}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}