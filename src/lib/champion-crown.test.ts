import { describe, expect, it } from "vitest";

import { crownKeys, isCrownedMember, NO_CROWN } from "./champion-crown";

describe("isCrownedMember", () => {
  const crown = crownKeys(["winner-id"], ["Test Bot 5"]);

  it("crowns the champion by id", () => {
    expect(isCrownedMember(crown, "winner-id", "Anything")).toBe(true);
  });

  it("crowns a surface that only has the champion's name", () => {
    // Most places a name is rendered have no member id, and this is what reaches them.
    expect(isCrownedMember(crown, null, "Test Bot 5")).toBe(true);
    expect(isCrownedMember(crown, undefined, "  test bot 5  ")).toBe(true);
  });

  it("does not crown somebody else", () => {
    expect(isCrownedMember(crown, "other-id", "Test Bot 6")).toBe(false);
    expect(isCrownedMember(crown, null, "Test Bot 6")).toBe(false);
  });

  it("trusts the id over the name", () => {
    // A namesake must not inherit the title. With an id in hand the name is not consulted,
    // so a non-champion who shares the champion's display name stays uncrowned.
    expect(isCrownedMember(crown, "other-id", "Test Bot 5")).toBe(false);
  });

  it("crowns nobody when nothing is crowned", () => {
    expect(isCrownedMember(NO_CROWN, "winner-id", "Test Bot 5")).toBe(false);
    expect(isCrownedMember(NO_CROWN, null, "Test Bot 5")).toBe(false);
  });

  it("ignores an empty name", () => {
    expect(isCrownedMember(crown, null, "")).toBe(false);
    expect(isCrownedMember(crown, null, "   ")).toBe(false);
    expect(isCrownedMember(crown, null, null)).toBe(false);
  });

  it("drops blank names when building the keys", () => {
    // A crowned member with no display name simply cannot be matched by name, which is the
    // right failure: better no crown than the wrong one.
    const keys = crownKeys(["id"], ["", "  "]);
    expect(keys.names.size).toBe(0);
    expect(isCrownedMember(keys, "id", null)).toBe(true);
  });
});