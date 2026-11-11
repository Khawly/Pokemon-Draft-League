import { describe, expect, it } from "vitest";

import { crownKeys, isCrownedMember, memberHonor, NO_CROWN } from "./champion-crown";

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

describe("memberHonor", () => {
  const honors = crownKeys(
    ["champion-id"],
    ["Champion"],
    ["elite-id"],
    ["Elite One"],
  );

  it("recognises the champion and an elite finisher by id", () => {
    expect(memberHonor(honors, "champion-id", "Anything")).toBe("champion");
    expect(memberHonor(honors, "elite-id", "Anything")).toBe("elite");
    expect(memberHonor(honors, "other-id", "Anything")).toBeNull();
  });

  it("recognises both by name when no id is available", () => {
    expect(memberHonor(honors, null, "Champion")).toBe("champion");
    expect(memberHonor(honors, null, "  elite one ")).toBe("elite");
  });

  it("gives the champion precedence over an overlapping elite key", () => {
    const overlapping = crownKeys(
      ["same-id"],
      ["Same Name"],
      ["same-id"],
      ["Same Name"],
    );
    expect(memberHonor(overlapping, "same-id", "Same Name")).toBe("champion");
    expect(memberHonor(overlapping, null, "Same Name")).toBe("champion");
  });

  it("trusts an id over a matching elite name", () => {
    // A namesake must not inherit the E4 badge either.
    expect(memberHonor(honors, "other-id", "Elite One")).toBeNull();
  });
});