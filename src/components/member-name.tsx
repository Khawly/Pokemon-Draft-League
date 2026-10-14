/*
 * The one place a member's display name is rendered with its chosen colour.
 *
 * Names appear in roughly forty places across the app and every one of them was a
 * bare `{name}` expression inside whatever element the surrounding layout already
 * had, so there was nothing to attach a colour to. This component supplies that
 * element, which is what lets a name be recoloured everywhere without each page
 * reinventing the lookup.
 *
 * It renders a span and nothing else. Callers keep their own text colour as the
 * default by passing the classes they already used; the chosen colour is layered on
 * top, so a member who has not picked one sees exactly what they saw before.
 */
"use client";

import { mergeNameColorClasses } from "@/lib/name-colors";

/** Props for the {@link MemberName} component. */
export interface MemberNameProps {
  /** The name to show. Nullish renders as the fallback so callers need no guard. */
  name: string | null | undefined;
  /**
   * The member's stored colour, as `profiles.name_color`. Unrecognised values fall
   * back to the default colour rather than rendering unstyled.
   */
  color?: string | null;
  /**
   * Text classes the name would have carried anyway, e.g. `text-sm font-medium`.
   * Passed through so adopting the component does not restyle a name.
   */
  className?: string;
  /** Shown when there is no name at all. */
  fallback?: string;
}

/**
 * Renders a member's display name in their chosen colour.
 *
 * @param props - {@link MemberNameProps}
 * @returns The name as a span, or the fallback when the name is empty.
 */
export function MemberName({
  name,
  color,
  className,
  fallback = "Unnamed",
}: MemberNameProps) {
  const resolved = name?.trim();

  if (!resolved) {
    return <span className={className}>{fallback}</span>;
  }

  /*
   * mergeNameColorClasses strips any competing text colour from `className` before
   * layering the chosen one on. That is not cosmetic: two text-colour utilities have
   * identical specificity, so without it the caller's own `text-slate-100` or
   * `text-white` wins purely by landing later in the compiled stylesheet, and the
   * member's choice silently does nothing on that page.
   */
  const classes = mergeNameColorClasses(className, color);

  return <span className={classes}>{resolved}</span>;
}