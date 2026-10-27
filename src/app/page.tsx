/*
 * Landing page for the Pokemon Draft League.
 *
 * Explains what the app does and gives visitors a single place to sign in or
 * create an account. A signed-in visitor sees the same explanation with a
 * "go to dashboard" action instead of the authentication form, so the home
 * button in the top bar can always land on this page.
 *
 * In development, `?devAccount=<key>` still signs in a registered test account
 * and sends it to the dashboard. Without that parameter the landing page stays
 * visible, which is what makes the home button useful while developing.
 */

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

import { AuthForm, type AuthMode } from "@/components/auth-form";
import { LoadingGif } from "@/components/loading-gif";
import { getSelectedLeague } from "@/lib/league-selection";
import { supabase } from "@/lib/supabase/client";

/** A feature shown in the landing page's capability grid. */
interface Feature {
  /** Short heading. */
  title: string;
  /** One-sentence description. */
  description: string;
}

/** The league capabilities highlighted on the landing page. */
const FEATURES: Feature[] = [
  {
    title: "Live drafts",
    description:
      "Run snake or set drafts with pick timers, autopick, skip flags, and priority lists.",
  },
  {
    title: "Rosters and budgets",
    description:
      "Assign tiers, track token salaries, add free agents, and keep an auditable transaction ledger.",
  },
  {
    title: "Trades",
    description:
      "Propose player or token trades, collect approvals, and settle both rosters atomically.",
  },
  {
    title: "Schedules and results",
    description:
      "Share availability, agree match times, submit results, and follow live standings.",
  },
  {
    title: "Playoffs and history",
    description:
      "Run championship brackets, the consolation Toilet Bowl, and a Hall of Fame for every champion.",
  },
  {
    title: "Commissioner tools",
    description:
      "Owners control league settings, salary rules, transaction fees, draft order, and season rollover.",
  },
];

/** The three-step explanation near the bottom of the page. */
const STEPS = [
  {
    title: "Create your league",
    description:
      "Name the league, choose the player count, and invite your trainers with a private link.",
  },
  {
    title: "Build the pool and draft",
    description:
      "Configure the Pokémon pool and tiers, set the draft order, then run the draft live.",
  },
  {
    title: "Play out the season",
    description:
      "Manage rosters, trade, schedule matches, report results, and crown a champion.",
  },
];

/**
 * Landing page. Shows the product overview plus either the auth form or a
 * dashboard action, depending on whether a session already exists.
 *
 * @returns The home page.
 */
export default function Home() {
  const router = useRouter();
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [signedInLabel, setSignedInLabel] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");

  useEffect(() => {
    let isMounted = true;

    async function checkSession() {
      /*
       * Dev auto-login is opt-in: only a URL with `?devAccount=` adopts a test
       * session. Without it the landing page remains visible, so the home
       * button can actually show this page in development.
       */
      if (process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === "true") {
        const devAccount = new URLSearchParams(window.location.search).get(
          "devAccount",
        );

        if (devAccount) {
          try {
            const response = await fetch(
              `/api/auth/dev-login?account=${encodeURIComponent(devAccount)}`,
            );

            if (response.ok) {
              const tokens = (await response.json()) as {
                access_token: string | null;
                refresh_token: string | null;
              };

              if (tokens.access_token && tokens.refresh_token) {
                await supabase.auth.setSession({
                  access_token: tokens.access_token,
                  refresh_token: tokens.refresh_token,
                });

                if (isMounted) {
                  router.replace("/dashboard");
                  return;
                }
              }
            }
          } catch {
            // Fall through to the normal session check / auth form.
          }
        }
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!isMounted) {
        return;
      }

      setIsSignedIn(Boolean(session?.user));
      setSignedInLabel(
        (session?.user?.user_metadata?.display_name as string | undefined) ??
          session?.user?.email ??
          null,
      );
      setIsCheckingSession(false);
    }

    checkSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) {
        return;
      }

      setIsSignedIn(Boolean(session?.user));
      setSignedInLabel(
        (session?.user?.user_metadata?.display_name as string | undefined) ??
          session?.user?.email ??
          null,
      );
      setIsCheckingSession(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [router]);

  /**
   * Switches the form mode and brings the auth card into view.
   *
   * @param mode - Whether to show sign-in or sign-up.
   */
  function chooseAuth(mode: AuthMode) {
    setAuthMode(mode);
    document.getElementById("auth")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  /**
   * Opens the dashboard on the league the browser last selected, falling back
   * to the dashboard's own most-recent-league resolution.
   */
  function goToDashboard() {
    const leagueId = getSelectedLeague();
    router.push(leagueId ? `/dashboard?leagueId=${leagueId}` : "/dashboard");
  }

  if (isCheckingSession) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_rgba(15,23,42,0.2)_30%,_#020817_100%)] px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-6xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
          <LoadingGif label="Loading home page" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_rgba(15,23,42,0.2)_30%,_#020817_100%)] px-4 py-8 text-slate-100 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-6xl space-y-16">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-950/80 bg-white shadow-[0_10px_18px_rgba(2,6,23,0.65)]"
            >
              <Image
                src="/images/pokeball_3D.jpg"
                alt=""
                width={1920}
                height={1920}
                sizes="240px"
                loading="eager"
                className="h-full w-full scale-[2.65] object-contain"
              />
            </span>
            <div>
              <p className="text-sm font-semibold text-white">
                Pokémon Draft League
              </p>
              <p className="text-xs text-slate-500">Draft. Trade. Compete.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isSignedIn ? (
              <button
                type="button"
                onClick={goToDashboard}
                className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
              >
                Go to dashboard
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => chooseAuth("login")}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => chooseAuth("signup")}
                  className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
                >
                  Create account
                </button>
              </>
            )}
          </div>
        </header>

        <section className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          <div className="space-y-6">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-400">
              League management, built for trainers
            </p>
            <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
              Run your Pokémon league from the{" "}
              <span className="text-amber-400">first pick</span> to the{" "}
              <span className="text-amber-400">final crown</span>.
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-slate-300 sm:text-lg">
              Draft with your friends, manage rosters and token budgets, trade
              players, schedule matches, and crown a champion — all in one
              place.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row">
              {isSignedIn ? (
                <button
                  type="button"
                  onClick={goToDashboard}
                  className="rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
                >
                  Open your dashboard
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => chooseAuth("signup")}
                    className="rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
                  >
                    Create an account
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseAuth("login")}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                  >
                    Sign in
                  </button>
                </>
              )}
            </div>

            <ul className="flex flex-wrap gap-2 pt-2 text-xs text-slate-400">
              {[
                "Snake and set drafts",
                "Salary and transaction rules",
                "Trades and approvals",
                "Playoffs and history",
              ].map((item) => (
                <li
                  key={item}
                  className="rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1.5"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div id="auth" className="scroll-mt-6 lg:sticky lg:top-8">
            {isSignedIn ? (
              <div className="rounded-2xl border border-slate-700 bg-slate-900/90 p-6 shadow-2xl shadow-slate-950/60 backdrop-blur-sm sm:p-8">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">
                  You are signed in
                </p>
                <h2 className="mt-3 text-2xl font-bold text-white sm:text-3xl">
                  Welcome back
                  {signedInLabel ? `, ${signedInLabel}` : ""}.
                </h2>
                <p className="mt-2 text-sm text-slate-400">
                  Your session is active. Use the dashboard button above to pick
                  up with your league.
                </p>
              </div>
            ) : (
              <AuthForm mode={authMode} onModeChange={setAuthMode} />
            )}
          </div>
        </section>

        <section aria-labelledby="features-heading" className="space-y-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-400">
              What is inside
            </p>
            <h2
              id="features-heading"
              className="mt-2 text-2xl font-bold text-white sm:text-3xl"
            >
              Everything your league needs, in one place.
            </h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <article
                key={feature.title}
                className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 transition hover:border-slate-700"
              >
                <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 text-xs font-bold text-amber-300">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-4 text-base font-semibold text-white">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {feature.description}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section
          aria-labelledby="how-heading"
          className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 sm:p-8"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-400">
              How it works
            </p>
            <h2
              id="how-heading"
              className="mt-2 text-2xl font-bold text-white sm:text-3xl"
            >
              From league setup to championship night.
            </h2>
          </div>

          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-950 text-sm font-bold text-amber-300">
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-base font-semibold text-white">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-400">
                    {step.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {!isSignedIn && (
          <section className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-6 text-center sm:p-8">
            <h2 className="text-2xl font-bold text-white">
              Ready to start your league?
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-slate-300">
              Create an account or sign in to open your dashboard and get
              started.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => chooseAuth("signup")}
                className="rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-400"
              >
                Create account
              </button>
              <button
                type="button"
                onClick={() => chooseAuth("login")}
                className="rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                Sign in
              </button>
            </div>
          </section>
        )}

        <footer className="border-t border-slate-800 pt-6 text-center text-xs text-slate-500">
          Pokémon Draft League — draft, trade, schedule, and crown a champion.
        </footer>
      </div>
    </main>
  );
}
