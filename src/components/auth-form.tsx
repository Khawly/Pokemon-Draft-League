/*
 * Login and sign-up form for the Pokemon Draft League app.
 *
 * Provides email/password authentication via Supabase, with a controlled
 * login/signup mode and a password-reset flow. The landing page owns the mode so
 * its own "Sign in" and "Create account" calls to action can switch the form
 * without duplicating auth state.
 */
"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  resetPassword,
  signInWithEmail,
  signUpWithEmail,
} from "@/lib/supabase/auth";

/** The two authentication modes the form can show. */
export type AuthMode = "login" | "signup";

/** Props for {@link AuthForm}. */
export interface AuthFormProps {
  /** Which form to show. */
  mode: AuthMode;
  /** Called when the member switches between signing in and creating an account. */
  onModeChange: (mode: AuthMode) => void;
}

/**
 * Combined login/signup/reset-password form.
 *
 * The caller controls the mode; the form keeps only the credential fields and
 * submission status. Login redirects to the dashboard, while signup shows the
 * email-verification message.
 *
 * @param props - {@link AuthFormProps}
 * @returns A dark authentication card matching the landing page.
 */
export function AuthForm({ mode, onModeChange }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Derive the card heading from the current auth mode.
  const title = useMemo(
    () => (mode === "login" ? "Welcome back" : "Create your account"),
    [mode],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setIsSubmitting(true);

    try {
      // Signup shows a verification message; login redirects to the dashboard.
      if (mode === "signup") {
        await signUpWithEmail({
          email,
          password,
          displayName,
        });
        setMessage(
          "Account created. Check your inbox for the email verification link before continuing.",
        );
      } else {
        await signInWithEmail({ email, password });
        setMessage("Signed in successfully. Redirecting...");
        router.replace("/dashboard");
      }
    } catch (caughtError) {
      // Surface Supabase error messages to the user.
      const resultMessage =
        caughtError instanceof Error
          ? caughtError.message
          : "Something went wrong.";
      setError(resultMessage);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResetPassword() {
    if (!email) {
      setError("Enter your email before requesting a reset link.");
      return;
    }

    setMessage(null);
    setError(null);

    try {
      await resetPassword(email);
      setMessage("Password reset email sent.");
    } catch (caughtError) {
      const resultMessage =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to send reset email.";
      setError(resultMessage);
    }
  }

  return (
    <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/90 p-6 shadow-2xl shadow-slate-950/60 backdrop-blur-sm sm:p-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">
          Account access
        </p>
        <h2 className="mt-3 text-2xl font-bold text-white sm:text-3xl">
          {title}
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          {mode === "login"
            ? "Sign in to open your league dashboard."
            : "Create an account to start or join a league."}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 rounded-xl bg-slate-950/70 p-1">
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
            mode === "login"
              ? "bg-slate-800 text-slate-100 shadow-sm"
              : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => onModeChange("login")}
        >
          Log in
        </button>
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
            mode === "signup"
              ? "bg-slate-800 text-slate-100 shadow-sm"
              : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => onModeChange("signup")}
        >
          Sign up
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === "signup" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-300">
              Display name
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-amber-400"
              placeholder="Ash Ketchum"
              required
            />
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-amber-400"
            placeholder="trainer@example.com"
            required
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-amber-400"
            placeholder="••••••••"
            minLength={6}
            required
          />
        </label>

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {message && (
          <div className="rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
            {message}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting
            ? "Working..."
            : mode === "login"
              ? "Log in"
              : "Create account"}
        </button>
      </form>

      {mode === "login" && (
        <button
          type="button"
          onClick={handleResetPassword}
          className="mt-4 text-sm font-medium text-amber-400 underline-offset-4 hover:text-amber-300 hover:underline"
        >
          Reset password
        </button>
      )}
    </div>
  );
}
