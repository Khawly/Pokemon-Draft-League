/*
 * The card surface used across the app.
 *
 * Every panel is the same slate panel: rounded, a thin border, and the
 * translucent background. Padding and layout stay at the call site because they
 * differ per panel.
 */
import type { ReactNode } from "react";

/** Classes shared by every card surface. */
const CARD_BASE = "rounded-2xl border border-slate-800 bg-slate-900/80";

/** Props for the {@link Card} component. */
export interface CardProps {
  /** The card's content. */
  children: ReactNode;
  /** Padding and layout classes for this panel. */
  className?: string;
}

/**
 * Renders a panel surface.
 *
 * @param props - {@link CardProps}
 * @returns The card.
 */
export function Card({ children, className }: CardProps) {
  return (
    <div className={className ? `${CARD_BASE} ${className}` : CARD_BASE}>
      {children}
    </div>
  );
}
