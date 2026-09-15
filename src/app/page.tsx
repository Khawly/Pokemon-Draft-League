/*
 * Landing page for the Pokemon Draft League.
 *
 * Checks for an existing Supabase session on mount and redirects signed-in
 * users to the dashboard; otherwise renders the authentication form.
 */

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { supabase } from "@/lib/supabase/client";

/**
 * Home page. Redirects to the dashboard when a session already exists, else
 * renders the auth form.
 */
export default function Home() {
  const router = useRouter();
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function checkSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!isMounted) {
        return;
      }

      // Auth guard: signed-in visitors go straight to the dashboard.
      if (session?.user) {
        router.replace("/dashboard");
        return;
      }

      setIsCheckingSession(false);
    }

    checkSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        router.replace("/dashboard");
      } else {
        if (isMounted) {
          setIsCheckingSession(false);
        }
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [router]);

  if (isCheckingSession) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_rgba(15,23,42,0.2)_30%,_#020817_100%)] px-4 py-10">
        <div className="rounded-2xl border border-slate-700 bg-slate-900 px-6 py-4 text-sm font-medium text-slate-200 shadow-lg shadow-slate-950/40">
          Loading the Home Page...
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_rgba(15,23,42,0.2)_30%,_#020817_100%)] px-4 py-10">
      <AuthForm />
    </main>
  );
}
