/*
 * Deciding who wears the champion crown and who carries the E4 badge.
 *
 * Kept out of the provider so the rule can be tested without a DOM. The rule is small but
 * has one subtlety worth pinning: an id is exact and is preferred, while a name is only a
 * fallback for the many surfaces that render a name and nothing else. Getting the
 * precedence backwards would let a namesake outrank the real champion. A champion is
 * never also labelled with the previous season's E4 badge.
 */

/** The keys a crowned member can be recognised by. */
export type CrownKeys = {
  /** Member ids known to be crowned. */
  userIds: ReadonlySet<string>;
  /** Their display names, lower-cased. */
  names: ReadonlySet<string>;
  /** Member ids who finished second through fifth in the previous season. */
  eliteUserIds: ReadonlySet<string>;
  /** Their display names, lower-cased. */
  eliteNames: ReadonlySet<string>;
};

/** A member's playoff distinction, or null when they have none. */
export type MemberHonor = "champion" | "elite" | null;

/** Nothing crowned. */
export const NO_CROWN: CrownKeys = {
  userIds: new Set<string>(),
  names: new Set<string>(),
  eliteUserIds: new Set<string>(),
  eliteNames: new Set<string>(),
};

/**
 * Normalises display names into the lower-cased keys used for matching.
 *
 * @param names - Display names, possibly with blanks.
 * @returns The non-empty keys.
 */
function nameKeys(names: readonly string[]): Set<string> {
  return new Set(
    names
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

/**
 * Builds the lookup keys from the crowned and elite members' ids and names.
 *
 * @param userIds - Champion member ids.
 * @param names - Champion display names.
 * @param eliteUserIds - Second-through-fifth finisher ids.
 * @param eliteNames - Their display names.
 * @returns The keys, with the names normalised for matching.
 */
export function crownKeys(
  userIds: readonly string[],
  names: readonly string[],
  eliteUserIds: readonly string[] = [],
  eliteNames: readonly string[] = [],
): CrownKeys {
  return {
    userIds: new Set(userIds),
    names: nameKeys(names),
    eliteUserIds: new Set(eliteUserIds),
    eliteNames: nameKeys(eliteNames),
  };
}

/**
 * Resolves whether a member is the champion, an elite finisher, or neither.
 *
 * An id wins whenever the caller has one: it is exact, and a different member
 * who happens to share the champion's display name must not inherit the title.
 * The name is only consulted when there is no id to go on, which is the case
 * for most of the places a name is rendered. A champion is never also labelled
 * as an earlier elite finisher.
 *
 * @param crown - The published keys.
 * @param userId - The member's id, or nullish when the caller does not know it.
 * @param name - The display name being rendered.
 * @returns The member's honor, or null when they have none.
 */
export function memberHonor(
  crown: CrownKeys,
  userId: string | null | undefined,
  name: string | null | undefined,
): MemberHonor {
  if (userId) {
    if (crown.userIds.has(userId)) {
      return "champion";
    }

    return crown.eliteUserIds.has(userId) ? "elite" : null;
  }

  const trimmed = name?.trim().toLowerCase();

  if (!trimmed) {
    return null;
  }

  if (crown.names.has(trimmed)) {
    return "champion";
  }

  return crown.eliteNames.has(trimmed) ? "elite" : null;
}

/**
 * Whether a member wears the crown.
 *
 * @param crown - The crowned keys.
 * @param userId - The member's id, or nullish when the caller does not know it.
 * @param name - The display name being rendered.
 * @returns True when this member is the reigning champion.
 */
export function isCrownedMember(
  crown: CrownKeys,
  userId: string | null | undefined,
  name: string | null | undefined,
): boolean {
  return memberHonor(crown, userId, name) === "champion";
}