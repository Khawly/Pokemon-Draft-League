/*
 * Tests for avatar initials.
 *
 * The bug these cover was a member choosing "TB", seeing it in the settings preview,
 * and finding it absent everywhere else and gone after a reload. The cause was that
 * the value was never stored and every page derived its own letters, so the two
 * derivations had to be made to agree as well as the storage being fixed.
 */
import { describe, expect, it } from "vitest";
import {
  avatarInitialsFor,
  MAX_AVATAR_INITIALS,
  normalizeAvatarInitials,
  resolveAvatarInitials,
} from "@/lib/avatar-initials";

describe("normalizeAvatarInitials", () => {
  it("keeps a member's chosen letters", () => {
    expect(normalizeAvatarInitials("TB")).toBe("TB");
    expect(normalizeAvatarInitials("K")).toBe("K");
  });

  it("uppercases so a circle never mixes cases", () => {
    expect(normalizeAvatarInitials("tb")).toBe("TB");
    expect(normalizeAvatarInitials("kHaWly")).toBe("KH");
  });

  it("strips anything that is not a letter or digit", () => {
    // Pasting an emoji or a symbol would otherwise leave the circle half-empty,
    // which looks like a rendering fault rather than a rejected character.
    expect(normalizeAvatarInitials("A B")).toBe("AB");
    expect(normalizeAvatarInitials("🔥")).toBe("");
    expect(normalizeAvatarInitials("!!")).toBe("");
    expect(normalizeAvatarInitials("T-B")).toBe("TB");
  });

  it("truncates to the maximum rather than rejecting", () => {
    // The settings field is typed into, so over-long input has to degrade quietly.
    expect(normalizeAvatarInitials("ABCD")).toBe("AB");
    expect(normalizeAvatarInitials("ABCDEFG")).toBe("AB");
    expect(MAX_AVATAR_INITIALS).toBe(2);
  });

  it("treats nothing as nothing", () => {
    expect(normalizeAvatarInitials(null)).toBe("");
    expect(normalizeAvatarInitials(undefined)).toBe("");
    expect(normalizeAvatarInitials("")).toBe("");
    expect(normalizeAvatarInitials("   ")).toBe("");
  });

  it("survives a non-string without throwing", () => {
    expect(normalizeAvatarInitials(7 as unknown as string)).toBe("");
  });
});

describe("avatarInitialsFor", () => {
  it("takes the first letter of the first two words", () => {
    // This is the derivation the settings page always used. It is now shared, which
    // is what makes the preview there honest about what other pages will show.
    expect(avatarInitialsFor("Test Bot 5")).toBe("TB");
    expect(avatarInitialsFor("Bam A")).toBe("BA");
    expect(avatarInitialsFor("Khawly")).toBe("K");
  });

  it("ignores extra words past the second", () => {
    expect(avatarInitialsFor("Test Bot Five")).toBe("TB");
    expect(avatarInitialsFor("a b c d")).toBe("AB");
  });

  it("tolerates ragged spacing", () => {
    expect(avatarInitialsFor("  Test   Bot  5 ")).toBe("TB");
  });

  it("falls back to a question mark with no name", () => {
    expect(avatarInitialsFor(null)).toBe("?");
    expect(avatarInitialsFor("")).toBe("?");
    expect(avatarInitialsFor("   ")).toBe("?");
  });

  it("always returns something drawable", () => {
    for (const name of ["Khawly", "Test Bot 5", "a", " ", "🔥🔥", "x y z"]) {
      expect(avatarInitialsFor(name).length).toBeGreaterThan(0);
    }
  });
});

describe("resolveAvatarInitials", () => {
  it("prefers the member's own initials", () => {
    // The whole point: a chosen value must win over the derived one, or a member's
    // "TB" would be silently replaced by the name's own letters.
    expect(resolveAvatarInitials("TB", "Khawly")).toBe("TB");
    expect(resolveAvatarInitials("K", "Test Bot 5")).toBe("K");
  });

  it("falls back to the name when nothing is stored", () => {
    expect(resolveAvatarInitials(null, "Test Bot 5")).toBe("TB");
    expect(resolveAvatarInitials(undefined, "Khawly")).toBe("K");
  });

  it("falls back when the stored value is unusable", () => {
    // A stored value of emoji or spaces normalizes to empty, and must not leave the
    // avatar blank. This is the path a hand-edited row takes.
    expect(resolveAvatarInitials("🔥", "Test Bot 5")).toBe("TB");
    expect(resolveAvatarInitials("   ", "Khawly")).toBe("K");
  });

  it("normalizes what it returns", () => {
    expect(resolveAvatarInitials(" tb ", "Khawly")).toBe("TB");
    expect(resolveAvatarInitials("t-b", "Khawly")).toBe("TB");
  });

  it("still draws something when both are unusable", () => {
    expect(resolveAvatarInitials(null, null)).toBe("?");
    expect(resolveAvatarInitials("", "")).toBe("?");
  });
});