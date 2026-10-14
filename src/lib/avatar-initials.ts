/*
 * The letters shown in an avatar when a member has not uploaded a picture.
 *
 * A member can choose their own in settings, and those letters are stored, so this
 * module also owns the derivation used when they have not. Keeping both in one
 * place is what stops the settings preview and every other page from disagreeing
 * about what a member's avatar says, which is exactly what happened when each page
 * derived its own: settings took the first two words while the rest of the app took
 * a single letter.
 */

/** The most letters a member's avatar can carry. */
export const MAX_AVATAR_INITIALS = 2;

/**
 * Coerces stored or typed initials into the letters an avatar may show.
 *
 * Uppercased and stripped of anything that is not a letter or digit, so a pasted
 * value, an emoji, or a stray space cannot leave the circle half-empty. Longer input
 * is truncated rather than rejected so the field still behaves while being typed
 * into.
 *
 * @param value - The raw stored or typed initials.
 * @returns Up to {@link MAX_AVATAR_INITIALS} uppercase letters, possibly empty.
 */
export function normalizeAvatarInitials(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, MAX_AVATAR_INITIALS)
    .toUpperCase();
}

/**
 * Derives initials from a display name, for a member who has not chosen any.
 *
 * Takes the first letter of the first two words, so "Test Bot 5" gives "TB" and
 * "Bam A" gives "BA", while a single-word name still gives its one letter. This is
 * the derivation the settings page always used; it is now shared rather than
 * reimplemented, which is what makes the preview on that page honest.
 *
 * @param name - The member's display name.
 * @returns The derived initials, or "?" when there is no name at all.
 */
export function avatarInitialsFor(name: string | null | undefined): string {
  const trimmed = name?.trim();

  if (!trimmed) {
    return "?";
  }

  const letters = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_AVATAR_INITIALS)
    .map((word) => word.charAt(0))
    .join("");

  return letters.toUpperCase() || "?".charAt(0).toUpperCase();
}

/**
 * Picks the letters an avatar should show, preferring the member's own choice.
 *
 * @param initials - The member's stored initials, if any.
 * @param name - The display name to fall back to.
 * @returns The initials to render in the avatar.
 */
export function resolveAvatarInitials(
  initials: string | null | undefined,
  name: string | null | undefined,
): string {
  return normalizeAvatarInitials(initials) || avatarInitialsFor(name);
}