/*
 * Tests for the Rules page data layer's pure helper.
 *
 * `normalizeRulesText` runs on whatever an owner uploads, and the two things it
 * strips are the two that a plain text file picked off Windows or out of Notepad
 * reliably carries and that would otherwise be rendered into the rules.
 */

import { describe, expect, it } from "vitest";

import { normalizeRulesText } from "@/lib/supabase/rules";

describe("normalizeRulesText", () => {
  it("strips a UTF-8 byte order mark", () => {
    // Notepad and older Windows editors write one, and it renders as a stray
    // character ahead of the first line of the rules.
    expect(normalizeRulesText("\uFEFF1. Snake draft")).toBe("1. Snake draft");
  });

  it("normalizes CRLF line endings", () => {
    expect(normalizeRulesText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("leaves already-clean text alone", () => {
    const clean = "1. Snake draft\n2. Best of 3\n   - Ties go to KO diff";
    expect(normalizeRulesText(clean)).toBe(clean);
  });

  it("preserves leading whitespace, which rules lists rely on", () => {
    // Indentation is meaningful in an authored rules document; trimming it would
    // silently change what the rules say.
    expect(normalizeRulesText("Rules:\n    - indented\n")).toBe(
      "Rules:\n    - indented\n",
    );
  });

  it("returns an empty string unchanged", () => {
    expect(normalizeRulesText("")).toBe("");
  });
});