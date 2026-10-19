/*
 * Deciding who wears the champion crown.
 *
 * Kept out of the provider so the rule can be tested without a DOM. The rule is small but
 * has one subtlety worth pinning: an id is exact and is preferred, while a name is only a
 * fallback for the many surfaces that render a name and nothing else. Getting the
 * precedence backwards would let a namesake outrank the real champion.
 */

/** The keys a crowned member can be recognised by. */
export type CrownKeys = {
  /** Member ids known to be crowned. */
  userIds: ReadonlySet<string>;
  /** Their display names, lower-cased. */
  names: ReadonlySet<string>;
};

/** Nothing crowned. */
export const NO_CROWN: CrownKeys = {
  userIds: new Set<string>(),
  names: new Set<string>(),
};

/**
 * Builds the lookup keys from the crowned members' ids and names.
 *
 * @param userIds - Member ids.
 * @param names - Their display names.
 * @returns The keys, with the names normalised for matching.
 */
export function crownKeys(
  userIds: readonly string[],
  names: readonly string[],
): CrownKeys {
  return {
    userIds: new Set(userIds),
    names: new Set(
      names
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    ),
  };
}

/**
 * Whether a member wears the crown.
 *
 * An id wins whenever the caller has one: it is exact, and a different member who happens
 * to share the champion's display name must not inherit the title. The name is only
 * consulted when there is no id to go on, which is the case for most of the places a name
 * is rendered.
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
  if (userId) {
    return crown.userIds.has(userId);
  }

  const trimmed = name?.trim().toLowerCase();
  return trimmed ? crown.names.has(trimmed) : false;
}