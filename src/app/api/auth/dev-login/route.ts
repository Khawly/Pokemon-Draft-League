/*
 * Dev-only auto-login endpoint for the Pokemon Draft League.
 *
 * Signs the test account in on the server using credentials stored in
 * server-side environment variables (DEV_TEST_EMAIL / DEV_TEST_PASSWORD) so
 * the password never reaches the client bundle. Only active when
 * NEXT_PUBLIC_DEV_AUTO_LOGIN is set and the app is not running in production.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Signs the test account in and returns the session tokens for the client to
 * adopt via `supabase.auth.setSession`.
 *
 * @returns A JSON response containing `access_token` and `refresh_token`, or a
 *   404/503 when auto-login is disabled or not configured.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const enabled = process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === "true";
  const email = process.env.DEV_TEST_EMAIL;
  const password = process.env.DEV_TEST_PASSWORD;

  if (!enabled || !email || !password) {
    return new NextResponse("Dev auto-login is not configured.", {
      status: 503,
    });
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
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  return NextResponse.json({
    access_token: data.session?.access_token ?? null,
    refresh_token: data.session?.refresh_token ?? null,
  });
}