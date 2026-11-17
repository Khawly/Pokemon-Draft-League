/*
 * The frame every league page renders inside.
 *
 * The pages all use the same full-height slate frame, and most of them also need
 * the same three-card vocabulary for loading, failed loads, and "there is nothing
 * here" messages. Those wrappers used to be copied into each page - the frame
 * class alone appeared in fifteen files - so a layout change meant editing every
 * one. Keeping them here means a page only describes its own content.
 */
"use client";

import type { ReactNode } from "react";

import { LoadingGif } from "@/components/loading-gif";

/** Full-height page frame shared by every route. */
const PAGE_FRAME =
  "min-h-dvh bg-slate-950 px-4 py-8 text-slate-100 sm:px-6 sm:py-10";

/** Default inner column: the wide, vertically spaced layout most pages use. */
const WIDE_COLUMN = "mx-auto max-w-[96rem] space-y-6";

/** Props for the {@link PageShell} component. */
export interface PageShellProps {
  children: ReactNode;
  /**
   * Classes for the inner column, replacing {@link WIDE_COLUMN} entirely.
   *
   * Passed whole rather than merged so a page can use a narrower width or a
   * different vertical rhythm without fighting Tailwind's class ordering.
   */
  columnClassName?: string;
}

/**
 * Renders page content in the shared frame.
 *
 * @param props - {@link PageShellProps}
 * @returns The framed page.
 */
export function PageShell({
  children,
  columnClassName = WIDE_COLUMN,
}: PageShellProps) {
  return (
    <main className={PAGE_FRAME}>
      <div className={columnClassName}>{children}</div>
    </main>
  );
}

/** Props for the {@link PageShellCard} component. */
export interface PageShellCardProps {
  children: ReactNode;
  tone?: "muted" | "error";
  /** Card width class. Defaults to the wide page column. */
  widthClassName?: string;
  /** Card padding class. Defaults to `p-8`. */
  paddingClassName?: string;
}

/**
 * Renders a single centred card in place of page content.
 *
 * Used for the states that have nothing to lay out: a spinner while the league
 * loads, the message when it fails, and "no league selected" notices.
 *
 * @param props - {@link PageShellCardProps}
 * @returns The framed card.
 */
export function PageShellCard({
  children,
  tone = "muted",
  widthClassName = "max-w-[96rem]",
  paddingClassName = "p-8",
}: PageShellCardProps) {
  const palette =
    tone === "error"
      ? "border-red-800 bg-red-950/40 text-red-200"
      : "border-slate-800 bg-slate-900/80 text-slate-400";

  return (
    <main className={PAGE_FRAME}>
      <div
        className={`mx-auto rounded-2xl border text-sm shadow-xl shadow-slate-950/40 ${widthClassName} ${paddingClassName} ${palette}`}
      >
        {children}
      </div>
    </main>
  );
}

/**
 * Renders the standard loading card.
 *
 * @param props.label - What the spinner is waiting for, e.g. "Loading trades".
 * @returns The framed card with the shared loading animation.
 */
export function PageShellLoading({ label }: { label: string }) {
  return (
    <PageShellCard>
      <LoadingGif label={label} />
    </PageShellCard>
  );
}

/**
 * Renders the standard failed-load card.
 *
 * @param props.children - The error copy, usually a message from the loader.
 * @returns The framed error card.
 */
export function PageShellError({ children }: { children: ReactNode }) {
  return <PageShellCard tone="error">{children}</PageShellCard>;
}
