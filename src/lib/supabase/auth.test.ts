/*
 * Unit tests for the auth duplicate-sign-up detection.
 *
 * Supabase answers a sign-up for an already registered address with a fake user
 * and no error when email confirmation is on, so the only thing to verify here is
 * that the helper recognises that shape and nothing else.
 */
import { describe, expect, it } from "vitest";

import { isDuplicateSignUpUser } from "@/lib/supabase/auth";

describe("isDuplicateSignUpUser", () => {
  it("flags the obfuscated duplicate, which has no identities", () => {
    expect(isDuplicateSignUpUser({ identities: [] })).toBe(true);
  });

  it("accepts a real sign-up, which carries the email identity", () => {
    expect(
      isDuplicateSignUpUser({ identities: [{ identity_id: "abc" }] }),
    ).toBe(false);
  });

  it("treats a missing response or missing identities as not a duplicate", () => {
    expect(isDuplicateSignUpUser(null)).toBe(false);
    expect(isDuplicateSignUpUser({})).toBe(false);
  });
});
