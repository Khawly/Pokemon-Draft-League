/*
 * The button variants used across the app.
 *
 * The same amber primary, slate secondary, rose outline, and override buttons had
 * been copied into the pages. Each variant here is the exact class list those
 * copies used, so adopting it does not change their appearance; a call site can
 * still add classes for a one-off size or spacing.
 */
import type { ButtonHTMLAttributes } from "react";

/** Visual tone of a button. */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger-outline"
  | "danger"
  | "warning";

/** Props for the {@link Button} component. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual tone. Defaults to secondary. */
  variant?: ButtonVariant;
}

/** Exact class lists per variant. */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50",
  secondary:
    "rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 disabled:opacity-50",
  "danger-outline":
    "rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-rose-800 hover:text-rose-200 disabled:opacity-50",
  danger:
    "rounded-xl border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-950/70 disabled:opacity-50",
  warning:
    "rounded-xl border border-amber-700 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50",
};

/**
 * Renders a button.
 *
 * @param props - {@link ButtonProps}
 * @returns The button element. Defaults to `type="button"` so a form button does
 *   not submit unless the caller asks it to.
 */
export function Button({
  variant = "secondary",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={
        className ? `${VARIANTS[variant]} ${className}` : VARIANTS[variant]
      }
      {...props}
    />
  );
}
