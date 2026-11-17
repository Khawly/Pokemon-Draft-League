/*
 * The small uppercase heading that labels a panel or field group.
 *
 * The tracking and size drifted between pages; this is the trades page's
 * variant, which is the most common one.
 */
import type { ReactNode } from "react";

/** Props for the {@link SectionLabel} component. */
export interface SectionLabelProps {
  /** The label text. */
  children: ReactNode;
  /** Extra classes, e.g. a different tracking width. */
  className?: string;
}

/**
 * Renders a section label.
 *
 * @param props - {@link SectionLabelProps}
 * @returns The label.
 */
export function SectionLabel({ children, className }: SectionLabelProps) {
  const base =
    "text-sm font-semibold uppercase tracking-[0.2em] text-slate-400";

  return <p className={className ? `${base} ${className}` : base}>{children}</p>;
}
