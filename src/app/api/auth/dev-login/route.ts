/*
 * Dev-only auto-login endpoint for the Pokemon Draft League.
 *
 * Signs a test account in on the server using credentials stored in
 * server-side environment variables (DEV_TEST_EMAIL / DEV_TEST_PASSWORD) so
 * the password never reaches the client bundle. Only active when
 * NEXT_PUBLIC_DEV_AUTO_LOGIN is set and the app is not running in production.
 *
 * Several accounts can be registered so a two-sided feature (a match time one
 * player proposes and the other accepts, for example) can be exercised from both
 * ends at once by opening a second browser profile against a different account.
 * Accounts are addressed by a short key rather than an email so a caller cannot
 * use this endpoint to read arbitrary environment variables.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * The accounts this endpoint may sign in, keyed by the `account` query
 * parameter. Each entry names the environment variables holding its
 * credentials, which are read server-side only.
 */
const LOGIN_ACCOUNTS: Record<string, { email: string; password: string }> = {
  test: {
    email: process.env.DEV_TEST_EMAIL ?? "",
    password: process.env.DEV_TEST_PASSWORD ?? "",
  },
  bot1: {
    email: process.env.DEV_BOT1_EMAIL ?? "",
    password: process.env.DEV_BOT1_PASSWORD ?? "",
  },
};

/**
 * Signs the requested account in and returns the session tokens for the client to
 * adopt via `supabase.auth.setSession`.
 *
 * @param request - The incoming request; its `account` parameter selects which
 *   registered account to sign in, defaulting to `test`.
 * @returns A JSON response containing `access_token` and `refresh_token`, or a
 *   404/503/401 when auto-login is disabled, unconfigured, or rejected.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const enabled = process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === "true";

  if (!enabled) {
    return new NextResponse("Dev auto-login is not configured.", {
      status: 503,
    });
  }

  // An unknown key is rejected rather than treated as "the default", so a typo
  // in a test URL cannot silently sign in as the wrong person.
  const account = new URL(request.url).searchParams.get("account") ?? "test";
  const credentials = LOGIN_ACCOUNTS[account];

  if (!credentials) {
    return new NextResponse("Unknown dev account.", { status: 404 });
  }

  const { email, password } = credentials;

  if (!email || !password) {
    return new NextResponse(
      `Dev auto-login is not configured for "${account}".`,
      { status: 503 },
    );
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new NextResponse("Supabase is not configured.", { status: 503 });
  }

  const client = createClient(supabaseUrl, supabaseAnonKey);

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return NextResponse.json(
      { error: error.message, account },
      { status: 401 },
    );
  }

  return NextResponse.json({
    access_token: data.session?.access_token ?? null,
    refresh_token: data.session?.refresh_token ?? null,
  });
}
