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
 *
 * When a caller passes the member's Pokemon Showdown handle, it follows the name in
 * parentheses, muted, so matchup cards name both the trainer and the account they play.
 * The champion crown and the previous season's E4 badge also sit to the left of the name,
 * supplied by the crown context rather than by each caller.
 */
"use client";

import { mergeNameColorClasses } from "@/lib/name-colors";
import { useMemberHonor } from "@/components/crown-provider";

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
  /**
   * The member's user id, when the caller has it.
   *
   * Optional so the forty-odd existing call sites keep working unchanged; a name without
   * it simply never shows a crown. Passing it is what lets a champion's title follow them
   * onto that surface.
   */
  userId?: string | null;
  /**
   * The member's Pokemon Showdown handle, when the caller has it. Rendered in
   * parentheses after the name so a matchup card names both the trainer and the
   * account they play under. Omitted when unset, so the name stands alone.
   */
  showdownUsername?: string | null;
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
  userId,
  showdownUsername,
}: MemberNameProps) {
  const resolved = name?.trim();
  const showdown = showdownUsername?.trim();
  const honor = useMemberHonor(userId, resolved);

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

  return (
    <span className={classes}>
      {honor === "champion" && (
        <span
          role="img"
          aria-label="League champion"
          title="League champion"
          className="mr-1"
        >
          👑
        </span>
      )}
      {honor === "elite" && (
        <span
          title="Top finisher in last season's playoffs"
          className="mr-1 rounded bg-amber-500/15 px-1 py-0.5 text-[0.7em] font-bold uppercase tracking-wide text-amber-300"
        >
          E4
        </span>
      )}
      {resolved}
      {showdown && (
        <span className="ml-1 text-[0.9em] font-normal text-slate-400">
          ({showdown})
        </span>
      )}
    </span>
  );
}