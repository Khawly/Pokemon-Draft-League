/*
 * Server-side Supabase helpers for the Pokemon Draft League.
 *
 * Provides a server client bound to the request cookie store plus helpers to
 * fetch the active session and the current user's profile.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Reads the first defined environment variable from the given candidate keys.
const getEnvValue = (...keys: string[]) => {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
};

/**
 * Creates a Supabase server client for the current request.
 *
 * Resolves the Supabase URL and anon key from environment variables, falling
 * back to local/dev defaults, and wires cookie reads/writes to the request's
 * cookie store.
 *
 * @returns A Promise resolving to a `createServerClient` instance bound to the
 *   current server request context.
 */
export async function createSupabaseServerClient() {
  const supabaseUrl =
    getEnvValue("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL") ?? "http://localhost:54321";
  const supabaseAnonKey =
    getEnvValue(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_ANON_KEY",
    ) ?? "demo-anon-key";

  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const cookie of cookiesToSet) {
            cookieStore.set(cookie.name, cookie.value, cookie.options);
          }
        } catch {
          // Server components may not allow cookie writes in this context.
        }
      },
    },
  });
}

/**
 * Fetches the current session and user for the active request.
 *
 * @returns A Promise resolving to `{ session, user, error }`, where `session`
 *   is the active session (or null), `user` is the session's user (or null),
 *   and `error` is any session retrieval error.
 */
export async function getServerSession() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) {
    return { session: null, user: null, error };
  }

  return { session, user: session?.user ?? null, error: null };
}

/**
 * Loads the profile row for the given user id.
 *
 * @param userId - The id of the user whose profile should be fetched.
 * @returns A Promise resolving to `{ profile, error }`, where `profile` is the
 *   full profile row (or null) and `error` is any query error.
 */
export async function getCurrentUserProfile(userId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    return { profile: null, error };
  }

  return { profile: data, error: null };
}
