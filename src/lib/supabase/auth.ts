/*
 * Authentication helpers for the Pokemon Draft League.
 *
 * Provides client-side wrappers around Supabase auth (sign up, sign in,
 * password reset, profile update, sign out) that throw on failure.
 */
import { supabase } from "@/lib/supabase/client";

/**
 * Signs up a new user with email and password, attaching the display name to
 * the auth user's metadata.
 *
 * @param params - Object containing the email, password, and display name.
 * @returns A Promise resolving to the Supabase `signUp` result data (session
 *   and/or created user).
 */
export async function signUpWithEmail({
  email,
  password,
  displayName,
}: {
  email: string;
  password: string;
  displayName: string;
}) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        display_name: displayName,
      },
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

/**
 * Signs in an existing user with email and password.
 *
 * @param params - Object containing the email and password.
 * @returns A Promise resolving to the Supabase `signInWithPassword` result data
 *   (session and/or user).
 */
export async function signInWithEmail({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

/**
 * Sends a password reset email, directing the user to the reset page.
 *
 * @param email - The email address to send the reset link to.
 * @returns A Promise resolving to the Supabase reset result data.
 */
export async function resetPassword(email: string) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/reset`,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

/**
 * Updates the current user's auth metadata and profile record.
 *
 * Trims display name and Showdown username, updates the auth user metadata,
 * upserts the matching profile row, and emits a `profile-updated` event so
 * other components can refresh.
 *
 * @param params - Object containing the user id, display name, Showdown
 *   username, and optional avatar URL.
 * @returns A Promise that resolves once both the auth metadata and profile row
 *   are updated.
 */
export async function updateUserProfile({
  userId,
  displayName,
  showdownUsername,
  avatarUrl,
}: {
  userId: string;
  displayName: string;
  showdownUsername: string;
  avatarUrl: string | null;
}) {
  const trimmedDisplayName = displayName.trim();
  const trimmedShowdownUsername = showdownUsername.trim();

  const { error: authError } = await supabase.auth.updateUser({
    data: {
      display_name: trimmedDisplayName,
      pokemon_showdown_username: trimmedShowdownUsername,
    },
  });

  if (authError) {
    throw new Error(authError.message);
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert(
      {
        id: userId,
        display_name: trimmedDisplayName || null,
        pokemon_showdown_username: trimmedShowdownUsername || null,
        avatar_url: avatarUrl || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

  if (profileError) {
    throw new Error(profileError.message);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("profile-updated", {
        detail: {
          avatarUrl: avatarUrl || null,
          displayName: trimmedDisplayName || null,
          showdownUsername: trimmedShowdownUsername || null,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }
}

/**
 * Signs the current user out.
 *
 * @returns A Promise that resolves once the session is cleared.
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();

  if (error) {
    throw new Error(error.message);
  }
}
