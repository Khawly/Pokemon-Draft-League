/*
 * Authentication helpers for the Pokemon Draft League.
 *
 * Provides client-side wrappers around Supabase auth (sign up, sign in,
 * password reset, profile update, sign out) that throw on failure.
 *
 * The profile update also carries the member's display preferences, so the
 * chosen time zone and name colour persist alongside the identity fields.
 */
import { supabase } from "@/lib/supabase/client";
import { normalizeNameColor } from "@/lib/name-colors";
import { normalizeAvatarInitials } from "@/lib/avatar-initials";

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
 *   username, optional avatar URL, the IANA time zone league timestamps
 *   should be rendered in, and the chosen name colour.
 * @returns A Promise that resolves once both the auth metadata and profile row
 *   are updated.
 */
export async function updateUserProfile({
  userId,
  displayName,
  showdownUsername,
  avatarUrl,
  avatarInitials,
  timeZone,
  nameColor,
}: {
  userId: string;
  displayName: string;
  showdownUsername: string;
  avatarUrl: string | null;
  /**
   * Letters to show in the avatar when the member has no picture. Stored rather than
   * derived, because the settings page let a member choose these and the value used
   * to be discarded on save.
   */
  avatarInitials?: string | null;
  timeZone: string;
  /** The member's chosen name colour. Normalized to the palette before writing. */
  nameColor?: string | null;
}) {
  const trimmedDisplayName = displayName.trim();
  const trimmedShowdownUsername = showdownUsername.trim();
  /*
   * Normalized on the way in rather than trusted from the caller. The column has no
   * CHECK constraint, so an unvalidated write would store a value no page can render
   * and the member would silently lose their colour until they picked a new one.
   */
  const normalizedNameColor = normalizeNameColor(nameColor);
  const normalizedInitials = normalizeAvatarInitials(avatarInitials);

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
        // NULL rather than an empty string, so "never chose any" stays
        // distinguishable from "chose an empty set" and the shared derivation
        // applies to the former.
        avatar_initials: normalizedInitials || null,
        timezone: timeZone.trim() || "UTC",
        // NULL rather than the string "default", so a member who has not chosen a
        // colour keeps the same row state as before the column existed.
        name_color: normalizedNameColor === "default" ? null : normalizedNameColor,
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
          avatarInitials: normalizedInitials || null,
          displayName: trimmedDisplayName || null,
          showdownUsername: trimmedShowdownUsername || null,
          timeZone: timeZone.trim() || "UTC",
          nameColor: normalizedNameColor,
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
