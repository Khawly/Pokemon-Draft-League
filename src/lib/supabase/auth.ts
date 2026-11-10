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
import { MAX_NAME_LENGTH } from "@/lib/name-limits";

/** Longest display name the UI and database accept, in characters. */
export const MAX_DISPLAY_NAME_LENGTH = MAX_NAME_LENGTH;

/**
 * The shape of the `identities` field on a sign-up result. Only the field the
 * duplicate check needs, so the helper stays usable without importing the SDK's
 * full user type.
 */
type SignUpIdentities = { identities?: unknown[] } | null;

/**
 * Reports whether a sign-up result is Supabase's obfuscated "already registered"
 * user rather than a genuinely new account.
 *
 * When email confirmation is enabled, Supabase answers a sign-up for an address
 * that already has an account with a fake user and no error, so a caller cannot
 * use the response to discover which addresses are registered. The tell is an
 * empty `identities` array: a real new sign-up always comes back with the email
 * identity attached. Callers turn this into the message the member sees.
 *
 * @param user - The `user` from a `signUp` response, or null.
 * @returns True when the email already belongs to a confirmed account.
 */
export function isDuplicateSignUpUser(user: SignUpIdentities): boolean {
  return (
    user != null &&
    Array.isArray(user.identities) &&
    user.identities.length === 0
  );
}

/**
 * Signs up a new user with email and password, attaching the display name to
 * the auth user's metadata. The name is trimmed and capped at
 * {@link MAX_DISPLAY_NAME_LENGTH} characters before it is sent.
 *
 * @param params - Object containing the email, password, and display name.
 * @returns A Promise resolving to the Supabase `signUp` result data (session
 *   and/or created user).
 * @throws When Supabase rejects the sign-up, or when the email already belongs
 *   to an account. The second case arrives as a successful response (see
 *   {@link isDuplicateSignUpUser}) and is turned into an error here so the form
 *   can say so instead of telling the member to check an inbox that will never
 *   receive anything.
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
  const normalizedDisplayName = displayName
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        display_name: normalizedDisplayName,
      },
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  if (isDuplicateSignUpUser(data.user)) {
    throw new Error(
      "An account with that email already exists. Sign in instead, or use Reset password if you have forgotten it.",
    );
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
 * Trims display name and Showdown username, caps the display name at
 * {@link MAX_DISPLAY_NAME_LENGTH}, updates the auth user metadata, upserts the
 * matching profile row, and emits a `profile-updated` event so other components
 * can refresh.
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
  const trimmedDisplayName = displayName
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
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
