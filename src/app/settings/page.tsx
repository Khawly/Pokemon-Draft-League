/*
 * User settings page for the Pokemon Draft League.
 *
 * Allows authenticated users to view and edit their profile (display name,
 * Showdown username, avatar initials), upload or remove a profile avatar, pick
 * the time zone league dates and times are shown in, declare the weekly window
 * they are available for a match, and sign out.
 */
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { signOut, updateUserProfile } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { useConfirm } from "@/components/confirm-dialog";
import {
  browserTimeZone,
  listTimeZones,
  formatTimeZoneLabel,
} from "@/lib/datetime";
import { cacheUserTimeZone } from "@/lib/user-timezone";
import {
  availabilityWeeksEqual,
  defaultAvailabilityWeek,
  formatClock,
  loadOwnAvailabilityWeek,
  normalizeAvailabilityWeek,
  saveAvailabilityWeek,
  WEEKDAY_LABELS,
  type AvailabilityWeek,
} from "@/lib/supabase/availability";

/**
 * Picks the zone to show in the settings form for a stored profile value.
 *
 * A profile that predates the preference carries the column's 'UTC' default, and
 * a member who has never chosen a zone is far better served by their own device's
 * zone than by UTC. The value is only persisted when they save, so merely opening
 * the page never records a preference they did not pick.
 *
 * @param stored - The profile's saved time zone, if any.
 * @returns The IANA time zone to preselect.
 */
function resolveInitialTimeZone(stored: string | null | undefined): string {
  const trimmed = stored?.trim();
  return trimmed && trimmed !== "UTC" ? trimmed : browserTimeZone();
}

/** User settings page component with profile editing, avatar management, availability, and sign-out. */
export default function SettingsPage() {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [displayName, setDisplayName] = useState("Trainer");
  const [showdownUsername, setShowdownUsername] = useState("");
  const [avatarInitials, setAvatarInitials] = useState("T");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarRefreshKey, setAvatarRefreshKey] = useState(0);
  const [timeZone, setTimeZone] = useState("UTC");
  const [availability, setAvailability] = useState<AvailabilityWeek>(
    defaultAvailabilityWeek,
  );
  /*
   * The last-saved availability week. Held in state rather than a ref because the
   * unsaved-changes hint reads it while rendering, which a ref cannot be read for.
   */
  const [savedAvailability, setSavedAvailability] = useState<AvailabilityWeek>(
    defaultAvailabilityWeek,
  );
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const originalProfileRef = useRef({
    displayName: "Trainer",
    showdownUsername: "",
    avatarUrl: null as string | null,
    avatarInitials: "T",
    timeZone: "UTC",
  });
  const pendingAvatarActionRef = useRef<"none" | "upload" | "remove">("none");
  const pendingAvatarFileRef = useRef<File | null>(null);

  const MAX_AVATAR_SIZE_BYTES = 100 * 1024;
  const ALLOWED_AVATAR_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);

  /*
   * The zone list only depends on the runtime's ICU data, so it is built once
   * rather than on every render of a page that re-renders on each keystroke.
   */
  const timeZoneOptions = useMemo(() => listTimeZones(), []);

  /**
   * Reads a file and returns its data URL string.
   * @param file - The file to read.
   * @returns A promise that resolves with the file's data URL.
   */
  function fileToDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Failed to read image file."));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Loads an HTMLImageElement from a data URL string.
   * @param dataUrl - The data URL of the image.
   * @returns A promise that resolves with the loaded image element.
   */
  function loadImageFromDataUrl(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new window.Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Invalid image file."));
      image.src = dataUrl;
    });
  }

  /**
   * Validates and compresses an avatar file to WebP format.
   * Rejects files exceeding 100 KB or of an unsupported type.
   * Scales images down to a max dimension of 512px before encoding at 75% quality.
   * @param file - The original image file to compress.
   * @returns A promise resolving to a compressed WebP File.
   */
  async function compressAvatarFile(file: File) {
    if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
      throw new Error("Only PNG, JPG, and WebP images are allowed.");
    }

    if (file.size > MAX_AVATAR_SIZE_BYTES) {
      throw new Error("Avatar must be 100 KB or smaller.");
    }

    const dataUrl = await fileToDataUrl(file);
    const image = await loadImageFromDataUrl(dataUrl);
    const maxDimension = 512;
    let width = image.width;
    let height = image.height;

    if (width > maxDimension || height > maxDimension) {
      const scale = Math.min(maxDimension / width, maxDimension / height, 1);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to process image data in this browser.");
    }

    context.drawImage(image, 0, 0, width, height);

    const outputType = "image/webp";
    const compressedBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Image compression failed."));
            return;
          }
          resolve(blob);
        },
        outputType,
        0.75,
      );
    });

    return new File([compressedBlob], `avatar-${Date.now()}.webp`, {
      type: outputType,
      lastModified: Date.now(),
    });
  }

  useEffect(() => {
    async function loadProfile() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.user) {
          router.replace("/");
          return;
        }

        const currentUser = session.user;
        setUserId(currentUser.id);

        const [profileResult, availabilityWeek] = await Promise.all([
          supabase
            .from("profiles")
            .select("display_name, pokemon_showdown_username, avatar_url, timezone")
            .eq("id", currentUser.id)
            .maybeSingle(),
          loadOwnAvailabilityWeek(currentUser.id),
        ]);

        const { error: profileError } = profileResult;

        if (profileError) {
          setError(profileError.message);
          return;
        }

        const data = profileResult.data;
        const nextDisplayName =
          data?.display_name ||
          (currentUser.user_metadata?.display_name as string | undefined) ||
          currentUser.email?.split("@")[0] ||
          "Trainer";
        const nextShowdownUsername =
          (data?.pokemon_showdown_username as string | undefined) || "";
        const nextAvatarUrl = (data?.avatar_url as string | undefined) || null;
        const nextTimeZone = resolveInitialTimeZone(
          data?.timezone as string | undefined,
        );
        const initials =
          nextDisplayName
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part: string) => part[0]?.toUpperCase() ?? "")
            .join("") || "T";

        const nextProfile = {
          displayName: nextDisplayName,
          showdownUsername: nextShowdownUsername,
          avatarUrl: nextAvatarUrl,
          avatarInitials: initials,
          timeZone: nextTimeZone,
        };

        originalProfileRef.current = nextProfile;
        setSavedAvailability(availabilityWeek);
        setDisplayName(nextDisplayName);
        setShowdownUsername(nextShowdownUsername);
        setAvatarInitials(initials);
        setAvatarUrl(nextAvatarUrl);
        setTimeZone(nextTimeZone);
        setAvailability(availabilityWeek);
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "Your profile could not be loaded.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }

    loadProfile();
  }, [router]);

  useEffect(() => {
    if (!hasChanges) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasChanges]);

  /** Resets all form fields and pending avatar actions to the last-saved snapshot. */
  function revertUnsavedChanges() {
    const snapshot = originalProfileRef.current;

    pendingAvatarActionRef.current = "none";
    pendingAvatarFileRef.current = null;
    setDisplayName(snapshot.displayName);
    setShowdownUsername(snapshot.showdownUsername);
    setAvatarInitials(snapshot.avatarInitials);
    setAvatarUrl(snapshot.avatarUrl);
    setTimeZone(snapshot.timeZone);
    setAvailability(savedAvailability);
    setAvatarRefreshKey((prev) => prev + 1);
    setHasChanges(false);
    setSuccessMessage(null);
    setError(null);
  }

  /**
   * Updates a form field and marks the page as having unsaved changes.
   * @param setter - The state setter function to call with the new value.
   * @param value - The new field value.
   */
  function handleFieldChange(setter: (value: string) => void, value: string) {
    setter(value);
    setHasChanges(true);
    setSuccessMessage(null);
    setError(null);
  }

  /**
   * Applies an edit to one weekday of the availability section.
   *
   * @param dayOfWeek - Weekday index to change (0 = Sunday).
   * @param patch - The fields to change on that day.
   */
  function handleAvailabilityChange(
    dayOfWeek: number,
    patch: Partial<{
      is_unavailable: boolean;
      start_time: string;
      end_time: string;
    }>,
  ) {
    setAvailability((current) =>
      normalizeAvailabilityWeek(
        current.map((day) =>
          day.day_of_week === dayOfWeek ? { ...day, ...patch } : day,
        ),
      ),
    );
    setHasChanges(true);
    setSuccessMessage(null);
    setError(null);
  }

  /**
   * Prompts the user if there are unsaved changes before executing the next action.
   * Reverts changes if the user confirms leaving.
   * @param nextAction - Optional callback to execute if the user chooses to leave.
   */
  async function confirmLeaveWithoutSaving(nextAction?: () => void) {
    if (!hasChanges) {
      nextAction?.();
      return;
    }

    const shouldLeave = await confirm({
      title: "Leave without saving?",
      detail: "Your unsaved changes to your profile, time zone, and availability are discarded",
      confirmLabel: "Discard changes",
      tone: "danger",
    });

    if (!shouldLeave) {
      return;
    }

    revertUnsavedChanges();
    nextAction?.();
  }

  /**
   * Persists profile changes (avatar upload/remove, display name, Showdown
   * username, display time zone) and the weekly availability window to Supabase
   * storage and the database.
   */
  async function handleSaveChanges() {
    if (!userId) {
      setError("You must be signed in before saving your profile.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      let nextAvatarUrl = avatarUrl;

      if (pendingAvatarActionRef.current === "remove") {
        const avatarPath = `${userId}/avatars/avatar.webp`;
        const { error: deleteError } = await supabase.storage
          .from("avatars")
          .remove([avatarPath]);

        if (deleteError) {
          throw new Error(deleteError.message);
        }

        nextAvatarUrl = null;
      }

      if (pendingAvatarActionRef.current === "upload") {
        const fileToPersist = pendingAvatarFileRef.current;
        if (!fileToPersist) {
          throw new Error("No pending avatar upload found.");
        }

        const filePath = `${userId}/avatars/avatar.webp`;
        const { error: uploadError } = await supabase.storage
          .from("avatars")
          .upload(filePath, fileToPersist, {
            cacheControl: "0",
            upsert: true,
          });

        if (uploadError) {
          throw new Error(uploadError.message);
        }

        const { data } = supabase.storage
          .from("avatars")
          .getPublicUrl(filePath);
        nextAvatarUrl = `${data.publicUrl}?t=${Date.now()}`;
      }

      await updateUserProfile({
        userId,
        displayName,
        showdownUsername,
        avatarUrl: nextAvatarUrl,
        timeZone,
      });

      // Saved after the profile so a failure here cannot leave the two views of
      // the same settings disagreeing about what is stored.
      await saveAvailabilityWeek(userId, availability);

      // Refresh the cache so every other league page renders in the new zone on
      // its next load rather than the one it happened to cache.
      cacheUserTimeZone(timeZone);

      pendingAvatarActionRef.current = "none";
      pendingAvatarFileRef.current = null;
      originalProfileRef.current = {
        displayName,
        showdownUsername,
        avatarUrl: nextAvatarUrl,
        avatarInitials,
        timeZone,
      };
      setSavedAvailability(availability);
      setAvatarUrl(nextAvatarUrl);
      setHasChanges(false);
      setSuccessMessage("Your profile was saved.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save changes.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }

  /** Stages the current avatar for removal; the actual deletion happens on save. */
  async function removeCurrentAvatar() {
    if (!userId) {
      setError("You must be signed in before removing your avatar.");
      return;
    }

    setIsUploadingAvatar(true);
    setError(null);
    setSuccessMessage(null);

    try {
      pendingAvatarActionRef.current = "remove";
      pendingAvatarFileRef.current = null;
      setAvatarUrl(null);
      setAvatarRefreshKey((prev) => prev + 1);
      setHasChanges(true);
      setSuccessMessage("Avatar removed. Save changes to confirm.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to remove avatar.";
      setError(message);
    } finally {
      setIsUploadingAvatar(false);
    }
  }

  /**
   * Handles selection of an avatar file: compresses it, stages it for upload,
   * and shows a local preview until the user saves.
   * @param event - The file input change event.
   */
  async function handleAvatarUpload(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    if (!file || !userId) {
      return;
    }

    setIsUploadingAvatar(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const normalizedFile = await compressAvatarFile(file);
      pendingAvatarActionRef.current = "upload";
      pendingAvatarFileRef.current = normalizedFile;

      const previewUrl = URL.createObjectURL(normalizedFile);
      setAvatarUrl(null);
      setAvatarRefreshKey((prev) => prev + 1);
      setAvatarUrl(previewUrl);
      setHasChanges(true);
      setSuccessMessage("Avatar updated. Save changes to confirm.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to upload avatar.";
      setError(
        `${message} Create a public 'avatars' bucket in Supabase Storage first.`,
      );
    } finally {
      setIsUploadingAvatar(false);
      if (event.target) {
        event.target.value = "";
      }
    }
  }

  /** Signs the user out of Supabase and redirects to the home page. */
  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-4xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          Loading your profile...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-white">User Settings</h1>
            </div>

            <button
              type="button"
              onClick={() => void confirmLeaveWithoutSaving(() => router.push("/dashboard"))}
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              Back to league
            </button>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.5fr]">
          <aside className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <div className="flex flex-col items-center">
              <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-amber-500 text-xl font-bold text-slate-950 shadow-md">
                {avatarUrl ? (
                  <img
                    key={avatarRefreshKey}
                    src={avatarUrl}
                    alt={displayName}
                    className="h-full w-full object-cover"
                    onError={() => setAvatarUrl(null)}
                  />
                ) : (
                  <span>{avatarInitials || "A"}</span>
                )}
              </div>

              <p className="mt-4 text-lg font-semibold text-white">
                {displayName}
              </p>
              <p className="text-sm text-slate-400">Trainer profile</p>
            </div>

            <div className="mt-6 space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarUpload}
              />

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingAvatar}
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isUploadingAvatar ? "Uploading..." : "Upload avatar"}
                </button>

                <button
                  type="button"
                  onClick={removeCurrentAvatar}
                  disabled={isUploadingAvatar || !avatarUrl}
                  className="rounded-xl border border-red-800 bg-red-950/60 p-2.5 text-red-200 transition hover:bg-red-900/80 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Remove avatar"
                  title="Remove avatar"
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className="h-4 w-4 fill-current"
                  >
                    <path d="M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1h2a1 1 0 1 1 0 2H7a1 1 0 0 1 0-2h2Zm-2 5h10l-1 11.5A2.5 2.5 0 0 1 13.5 21h-3A2.5 2.5 0 0 1 8 18.5L7 8Zm3 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z" />
                  </svg>
                </button>
              </div>
              <p className="text-center text-xs text-slate-400">
                Max size: 100 KB • PNG, JPG, or WebP
              </p>
              <button
                type="button"
                className="w-full rounded-xl border border-red-800 bg-red-950/60 px-4 py-2.5 text-sm font-medium text-red-200 transition hover:bg-red-900/80"
                onClick={() =>
                  void confirmLeaveWithoutSaving(async () => {
                    await handleSignOut();
                  })
                }
              >
                Sign Out
              </button>
            </div>
          </aside>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-950/30">
            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Display name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(event) =>
                    handleFieldChange(setDisplayName, event.target.value)
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 focus:bg-slate-950"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Pokémon Showdown username
                </label>
                <input
                  type="text"
                  value={showdownUsername}
                  onChange={(event) =>
                    handleFieldChange(setShowdownUsername, event.target.value)
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 focus:bg-slate-950"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Default avatar initials
                </label>
                <input
                  type="text"
                  value={avatarInitials}
                  onChange={(event) =>
                    handleFieldChange(setAvatarInitials, event.target.value)
                  }
                  maxLength={2}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400 focus:bg-slate-950"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Time zone
                </label>
                <select
                  value={timeZone}
                  onChange={(event) =>
                    handleFieldChange(setTimeZone, event.target.value)
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition focus:border-amber-400"
                >
                  {/* A zone outside the runtime's list would otherwise be unselectable. */}
                  {!timeZoneOptions.includes(timeZone) && (
                    <option value={timeZone}>{formatTimeZoneLabel(timeZone)}</option>
                  )}
                  {timeZoneOptions.map((zone) => (
                    <option key={zone} value={zone}>
                      {formatTimeZoneLabel(zone)}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-slate-400">
                  Every date and time on league pages, including match times and
                  the weekly deadline, is shown in this zone.
                </p>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Availability
                </label>
                <p className="mb-3 text-xs text-slate-400">
                  The window you are free to play each day, in {formatTimeZoneLabel(timeZone)}. Your
                  opponent sees this on the schedule page when they pick a match
                  time. A range that ends before it starts is read as running
                  past midnight.
                </p>

                <div className="space-y-2">
                  {availability.map((day) => (
                    <div
                      key={day.day_of_week}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5"
                    >
                      <label className="flex min-w-32 flex-1 items-center gap-2 text-sm text-slate-200">
                        <input
                          type="checkbox"
                          checked={day.is_unavailable}
                          onChange={(event) =>
                            handleAvailabilityChange(day.day_of_week, {
                              is_unavailable: event.target.checked,
                            })
                          }
                          className="size-4 accent-rose-500"
                        />
                        <span>{WEEKDAY_LABELS[day.day_of_week]}</span>
                      </label>

                      {day.is_unavailable ? (
                        <span className="text-sm text-slate-500">
                          Unavailable
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="time"
                            value={day.start_time}
                            onChange={(event) =>
                              handleAvailabilityChange(day.day_of_week, {
                                start_time: event.target.value,
                              })
                            }
                            aria-label={`${WEEKDAY_LABELS[day.day_of_week]} availability start`}
                            className="rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-amber-400"
                          />
                          <span className="text-sm text-slate-500">to</span>
                          <input
                            type="time"
                            value={day.end_time}
                            onChange={(event) =>
                              handleAvailabilityChange(day.day_of_week, {
                                end_time: event.target.value,
                              })
                            }
                            aria-label={`${WEEKDAY_LABELS[day.day_of_week]} availability end`}
                            className="rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-amber-400"
                          />
                          <span className="text-xs text-slate-500">
                            {formatClock(day.start_time)} –{" "}
                            {formatClock(day.end_time)}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {!availabilityWeeksEqual(savedAvailability, availability) && (
                  <p className="mt-2 text-xs text-amber-300">
                    Availability has unsaved changes.
                  </p>
                )}
              </div>

              {error && (
                <div className="rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              )}

              {successMessage && (
                <div className="rounded-lg border border-emerald-800 bg-emerald-950/60 px-3 py-2 text-sm text-emerald-200">
                  {successMessage}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  disabled={!hasChanges || isSaving}
                  onClick={handleSaveChanges}
                  className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </section>

        {confirmDialog}
      </div>
    </main>
  );
}
