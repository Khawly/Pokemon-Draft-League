/*
 * Vitest configuration for the Pokemon Draft League.
 *
 * The suite targets the pure logic: time zone conversion, availability
 * projection, the recurrence and formatting helpers. Those are where the subtle
 * bugs live - daylight saving gaps, windows that cross midnight, degenerate
 * ranges - and they are all reachable without a browser or a database.
 *
 * The environment is Node rather than jsdom by default, which keeps the suite
 * fast. A test that genuinely needs a DOM can opt in per file with
 * `@vitest-environment jsdom`; nothing currently does.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` alias in tsconfig.json so tests import modules the same
    // way the app does.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /*
     * A few data-layer modules build a Supabase browser client at import time,
     * which throws without these. The tests only exercise their pure helpers and
     * never issue a request, so the values exist purely to satisfy that
     * constructor.
     */
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.dummy-key-for-unit-tests",
    },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      // The Supabase-backed data layers are thin wrappers whose correctness is
      // enforced by RLS and RPCs, not by unit tests; reporting them as uncovered
      // would bury the logic worth measuring.
      exclude: [
        "src/lib/**/*.test.ts",
        "src/lib/supabase/client.ts",
        "src/lib/supabase/server.ts",
      ],
    },
  },
});
