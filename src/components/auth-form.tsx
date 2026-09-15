/*
 * Login and sign-up form for the Pokemon Draft League app.
 *
 * Provides email/password authentication via Supabase, with a toggle
 * between login and signup modes and a password-reset flow.
 */
"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  resetPassword,
  signInWithEmail,
  signUpWithEmail,
} from "@/lib/supabase/auth";

/**
 * Combined login/signup/reset-password form.
 *
 * Toggles between login and signup modes, calls the appropriate
 * Supabase auth helper, and displays status or error messages.
 * @returns A styled card containing the authentication form.
 */
export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Derive the page heading from the current auth mode.
  const title = useMemo(
    () => (mode === "login" ? "Welcome back" : "Create your league account"),
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
    <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-lg shadow-slate-200/60">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500">
          Pokémon Draft League
        </p>
        <h1 className="mt-3 text-3xl font-bold text-slate-900">{title}</h1>
      </div>

      <div className="mb-6 grid grid-cols-2 rounded-xl bg-slate-100 p-1">
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
            mode === "login"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-600"
          }`}
          onClick={() => setMode("login")}
        >
          Log in
        </button>
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
            mode === "signup"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-600"
          }`}
          onClick={() => setMode("signup")}
        >
          Sign up
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === "signup" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Display name
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition focus:border-amber-400 focus:bg-white"
              placeholder="Ash Ketchum"
              required
            />
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition focus:border-amber-400 focus:bg-white"
            placeholder="trainer@example.com"
            required
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition focus:border-amber-400 focus:bg-white"
            placeholder="••••••••"
            minLength={6}
            required
          />
        </label>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {message && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {message}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
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
          className="mt-4 text-sm font-medium text-amber-600 underline-offset-4 hover:underline"
        >
          Reset password
        </button>
      )}
    </div>
  );
}
