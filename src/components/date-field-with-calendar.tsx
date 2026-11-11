/*
 * A date or datetime input with a calendar button.
 *
 * Browsers do not reliably open a native date picker when the input itself is
 * clicked, and the default indicator is hidden here so the league settings fields
 * look like the rest of the form. The button calls `showPicker()` and falls back
 * to focusing and clicking the input when the browser has no picker API. This is
 * the same interaction the Schedule page's proposal date uses.
 */
"use client";

import { useRef, useState } from "react";

/** Props for {@link DateFieldWithCalendar}. */
export interface DateFieldWithCalendarProps {
  /** Optional id, for a label's `htmlFor`. */
  id?: string;
  /** Which native control to render. Defaults to a plain date. */
  type?: "date" | "datetime-local";
  /** The input value, in the control's native string format. */
  value: string;
  /** Called with the new value whenever the input changes. */
  onChange: (value: string) => void;
  /** Extra classes for the input, appended to the default field styling. */
  className?: string;
  /** Disables both the input and its calendar button. */
  disabled?: boolean;
  /** Accessible label for the input when no visible label is associated. */
  ariaLabel?: string;
}

/** Default field styling, shared by every deadline control on the settings page. */
const INPUT_CLASSES =
  "min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-amber-400 disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-calendar-picker-indicator]:hidden";

/**
 * Renders a native date input with a separate calendar button to its right.
 *
 * @param props - {@link DateFieldWithCalendarProps}
 * @returns The input and its calendar button.
 */
export function DateFieldWithCalendar({
  id,
  type = "date",
  value,
  onChange,
  className,
  disabled = false,
  ariaLabel,
}: DateFieldWithCalendarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  /*
   * The ref is the source of truth for the toggle: a ref read is not stale within
   * the same render, so a double click opens then closes. The state only drives
   * `aria-expanded`.
   */
  const pickerOpenRef = useRef(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  /** Clears the open state after the browser dismisses or focus leaves the picker. */
  function closePicker() {
    pickerOpenRef.current = false;
    setIsPickerOpen(false);
  }

  /**
   * Toggles the native picker.
   *
   * `showPicker()` can open the calendar but there is no matching close call, so
   * closing blurs the input. Preventing `mousedown` keeps the button press from
   * blurring the input before the toggle reads its state.
   */
  function handleOpenPicker() {
    const input = inputRef.current;

    if (!input || disabled) {
      return;
    }

    if (pickerOpenRef.current) {
      closePicker();
      input.blur();
      return;
    }

    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        pickerOpenRef.current = true;
        setIsPickerOpen(true);
        return;
      } catch {
        // Not implemented or not permitted here; use the fallback below.
      }
    }

    input.focus();
    input.click();
  }

  return (
    <div className="flex gap-2">
      <input
        id={id}
        ref={inputRef}
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          closePicker();
          onChange(event.target.value);
        }}
        onBlur={closePicker}
        aria-label={ariaLabel}
        className={`${INPUT_CLASSES}${className ? ` ${className}` : ""}`}
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleOpenPicker}
        disabled={disabled}
        aria-label="Open the calendar to pick a date"
        aria-expanded={isPickerOpen}
        title="Open the calendar"
        className="shrink-0 rounded-xl border border-slate-700 bg-slate-950 px-2.5 text-slate-300 transition hover:border-amber-500 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-4 w-4 fill-current"
        >
          <path d="M7 1.8a1 1 0 0 1 1 1v1.4h8V2.8a1 1 0 1 1 2 0v1.4h1.6A2.4 2.4 0 0 1 22 6.6V9H2V6.6a2.4 2.4 0 0 1 2.4-2.4H6V2.8a1 1 0 0 1 1-1ZM2 11h20v9.4A2.4 2.4 0 0 1 19.6 23H4.4A2.4 2.4 0 0 1 2 20.4V11Zm4.5 1.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM6.5 16a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" />
        </svg>
      </button>
    </div>
  );
}
