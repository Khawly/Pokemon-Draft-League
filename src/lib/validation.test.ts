/*
 * Tests for the shared input-validation helpers.
 *
 * The helpers throw user-facing errors, so the tests pin both the accepted
 * values and the exact failure conditions the forms rely on.
 */

import { describe, expect, it } from "vitest";

import {
  isValidEmail,
  isValidHttpUrl,
  isValidTimeZone,
  optionalHttpUrl,
  optionalInteger,
  optionalText,
  requireClock,
  requireEmail,
  requireImportFile,
  requireInteger,
  requireText,
} from "@/lib/validation";

describe("requireText", () => {
  it("trims and returns a value", () => {
    expect(requireText("  Khawly  ", "Display name", 32)).toBe("Khawly");
  });

  it("rejects blank values", () => {
    expect(() => requireText("   ", "Display name")).toThrow(
      "Display name is required.",
    );
  });

  it("rejects values over the cap", () => {
    expect(() => requireText("abcdef", "Name", 5)).toThrow(
      "Name must be 5 characters or fewer.",
    );
  });
});

describe("optionalText", () => {
  it("returns null for a blank value", () => {
    expect(optionalText("  ", "Notes", 20)).toBeNull();
  });

  it("rejects values over the cap", () => {
    expect(() => optionalText("abcdef", "Notes", 5)).toThrow(
      "Notes must be 5 characters or fewer.",
    );
  });
});

describe("requireInteger", () => {
  it("accepts a whole number in range", () => {
    expect(requireInteger(" 12 ", "Players", 2, 50)).toBe(12);
  });

  it("rejects decimals, blanks, and out-of-range values", () => {
    expect(() => requireInteger("1.5", "Players", 2, 50)).toThrow(
      "Players must be a whole number.",
    );
    expect(() => requireInteger("", "Players", 2, 50)).toThrow(
      "Players is required.",
    );
    expect(() => requireInteger("51", "Players", 2, 50)).toThrow(
      "Players must be at most 50.",
    );
    expect(() => requireInteger("1", "Players", 2, 50)).toThrow(
      "Players must be at least 2.",
    );
  });
});

describe("optionalInteger", () => {
  it("returns null when blank", () => {
    expect(optionalInteger("", "Cost", 0)).toBeNull();
  });

  it("parses and range-checks a value", () => {
    expect(optionalInteger("0", "Cost", 0)).toBe(0);
    expect(() => optionalInteger("-1", "Cost", 0)).toThrow(
      "Cost must be at least 0.",
    );
  });
});

describe("email validation", () => {
  it("accepts plausible addresses", () => {
    expect(isValidEmail(" trainer@example.com ")).toBe(true);
    expect(requireEmail(" trainer@example.com ")).toBe("trainer@example.com");
  });

  it("rejects malformed addresses", () => {
    expect(isValidEmail("trainer@example")).toBe(false);
    expect(() => requireEmail("trainer@example")).toThrow(
      "Enter a valid email address.",
    );
    expect(() => requireEmail("   ")).toThrow("Email is required.");
  });
});

describe("URL validation", () => {
  it("accepts http and https links", () => {
    expect(isValidHttpUrl("https://replay.pokemonshowdown.com/gen9-1")).toBe(
      true,
    );
    expect(optionalHttpUrl("  ", "Replay link")).toBeNull();
  });

  it("rejects other schemes and malformed links", () => {
    expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
    expect(() => optionalHttpUrl("not-a-url", "Replay link")).toThrow(
      "Replay link must be a full http:// or https:// link.",
    );
  });

  it("enforces an optional host allowlist", () => {
    expect(() =>
      optionalHttpUrl(
        "https://example.com/replay",
        "Replay link",
        ["replay.pokemonshowdown.com"],
      ),
    ).toThrow("Replay link must be on replay.pokemonshowdown.com.");
  });
});

describe("clock validation", () => {
  it("accepts a real 24-hour time", () => {
    expect(requireClock(" 18:00 ", "Availability")).toBe("18:00");
  });

  it("rejects malformed clocks", () => {
    expect(() => requireClock("24:00", "Availability")).toThrow(
      "Availability must be a valid time like 18:00.",
    );
    expect(() => requireClock("9:00", "Availability")).toThrow(
      "Availability must be a valid time like 18:00.",
    );
  });
});

describe("time zone validation", () => {
  it("accepts known IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown zones", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("requireImportFile", () => {
  /** Builds a File-shaped object without relying on the runtime's File class. */
  const file = (name: string, size: number) =>
    ({ name, size }) as File;

  it("accepts a file with an allowed extension", () => {
    expect(() => requireImportFile(file("pool.csv", 100), "CSV", [".csv"])).not
      .toThrow();
  });

  it("rejects oversized and unexpected files", () => {
    expect(() =>
      requireImportFile(file("pool.csv", 2_000_000), "CSV", [".csv"]),
    ).toThrow("CSV must be 1000 KB or smaller.");
    expect(() =>
      requireImportFile(file("pool.txt", 100), "CSV", [".csv"]),
    ).toThrow("CSV must be a .csv file.");
  });
});
