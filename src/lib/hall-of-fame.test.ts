import { describe, expect, it } from "vitest";

import { badgeForSeason } from "./hall-of-fame";

describe("badgeForSeason", () => {
  it("awards Kanto's badges for the first eight seasons", () => {
    expect(badgeForSeason(1)).toMatchObject({
      region: "Kanto",
      number: 1,
      name: "Boulder",
      label: "Boulder Badge",
    });
    expect(badgeForSeason(2).name).toBe("Cascade");
    expect(badgeForSeason(8)).toMatchObject({
      region: "Kanto",
      number: 8,
      name: "Earth",
    });
  });

  it("moves to the next region after eight", () => {
    // The ninth title starts Johto rather than repeating Kanto's first badge.
    expect(badgeForSeason(9)).toMatchObject({
      region: "Johto",
      number: 1,
      name: "Zephyr",
    });
    expect(badgeForSeason(16)).toMatchObject({
      region: "Johto",
      number: 8,
      name: "Rising",
    });
  });

  it("keeps moving through later regions", () => {
    expect(badgeForSeason(17).region).toBe("Hoenn");
    expect(badgeForSeason(25).region).toBe("Sinnoh");
    expect(badgeForSeason(33).region).toBe("Unova");
    expect(badgeForSeason(41).region).toBe("Kalos");
  });

  it("numbers a region whose badges have no established names", () => {
    // Alola and Galar award no numbered gym badges, so the ladder keeps counting and the
    // label says so rather than inventing a name.
    expect(badgeForSeason(49)).toMatchObject({
      region: "Alola",
      number: 1,
      name: "Badge 1",
      label: "Badge 1 Badge",
    });
  });

  it("still awards a badge beyond the listed regions", () => {
    // A league that outlives this list should not lose the ladder.
    const badge = badgeForSeason(73);
    expect(badge.region).toBe("Region 10");
    expect(badge.number).toBe(1);
  });

  it("treats nonsense as the first season rather than throwing", () => {
    // The hall renders whatever the database holds; a bad number should not break the page.
    expect(badgeForSeason(0).region).toBe("Kanto");
    expect(badgeForSeason(-3).number).toBe(1);
    expect(badgeForSeason(Number.NaN).number).toBe(1);
  });

  it("floors a fractional season", () => {
    expect(badgeForSeason(2.7).number).toBe(2);
  });
});