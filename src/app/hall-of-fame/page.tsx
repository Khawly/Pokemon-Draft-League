/*
 * Hall of Fame for a league.
 *
 * One entry per season that has crowned a champion, oldest first. Each shows who won, the
 * badge that title is worth, and the Pokemon they won it with. The badge walks the gym badge
 * sequence a season at a time -- Kanto's eight, then Johto's, and on through the regions --
 * so a long-running league reads as a ladder rather than as a list of identical trophies.
 *
 * The champion comes from the same database function the crown and the bracket use, so a
 * replayed final or a corrected result is reflected here without anything to backfill.
 */
"use client";

import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";

import { GymBadge } from "@/components/gym-badge";
import { MemberAvatar } from "@/components/member-avatar";
import { MemberName } from "@/components/member-name";
import { badgeForSeason } from "@/lib/hall-of-fame";
import {
  getSelectedLeague,
  SELECTED_LEAGUE_CHANGED_EVENT,
} from "@/lib/league-selection";
import { getSpriteUrl } from "@/lib/pokeapi";
import {
  loadHallOfFame,
  type HallOfFameEntry,
} from "@/lib/supabase/hall-of-fame";

/**
 * Entry point for the Hall of Fame route.
 *
 * Wraps the content in a Suspense boundary so that useSearchParams meets Next.js's
 * client-side streaming requirement.
 *
 * @returns The hall, with a loading fallback.
 */
export default function HallOfFamePage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-6xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400 shadow-xl shadow-slate-950/40">
            Loading the Hall of Fame...
          </div>
        </main>
      }
    >
      <HallOfFameContent />
    </Suspense>
  );
}

/**
 * One champion's card: who they are, the badge they won, and the team they won it with.
 *
 * @param props.entry - The champion.
 * @returns The card.
 */
function ChampionCard({ entry }: { entry: HallOfFameEntry }) {
  const badge = badgeForSeason(entry.season);
  const displayName = entry.displayName?.trim() || entry.teamName;

  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg shadow-slate-950/30">
      <div className="flex items-start gap-5">
        <GymBadge
          region={badge.region}
          number={badge.number}
          label={badge.label}
        />

        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {entry.seasonName?.trim() || `Season ${entry.season}`}
          </p>

          <div className="mt-2 flex items-center gap-3">
            <MemberAvatar
              name={displayName}
              color={entry.nameColor}
              avatarUrl={entry.avatarUrl}
              initials={entry.avatarInitials}
              size={48}
            />
            <div className="min-w-0">
              <MemberName
                name={displayName}
                color={entry.nameColor}
                userId={entry.ownerUserId}
                className="block truncate text-lg font-bold text-white"
              />
              <p className="truncate text-xs text-slate-500">
                {entry.teamName}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-slate-800 pt-3">
        {entry.pokemon.length === 0 ? (
          <p className="text-xs text-slate-500">
            No roster was recorded for this season.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {entry.pokemon.map((pokemon) => (
              <li key={pokemon.id}>
                <span
                  title={pokemon.name}
                  className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/60 px-1.5 py-1"
                >
                  {/* Sprites are local files; a plain img is right here. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={getSpriteUrl(pokemon.spriteId)}
                    alt={pokemon.name}
                    width={40}
                    height={40}
                    loading="lazy"
                    className="h-10 w-10 [image-rendering:pixelated]"
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/**
 * The interactive hall: resolves the league and loads its champions.
 *
 * @returns The hall, or the states that replace it.
 */
function HallOfFameContent() {
  const searchParams = useSearchParams();
  const requestedLeagueId = searchParams.get("leagueId");

  /*
   * The league the member last looked at, read without an effect.
   *
   * useSyncExternalStore is what React wants for a value that lives outside React: it
   * re-renders on the league-changed event, keeps the server and client snapshots separate,
   * and avoids setting state from an effect just to copy storage into it.
   */
  const storedLeagueId = useSyncExternalStore(
    (onChange) => {
      window.addEventListener(SELECTED_LEAGUE_CHANGED_EVENT, onChange);
      window.addEventListener("storage", onChange);

      return () => {
        window.removeEventListener(SELECTED_LEAGUE_CHANGED_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => getSelectedLeague(),
    () => null,
  );

  const leagueId = requestedLeagueId ?? storedLeagueId;

  const [result, setResult] = useState<{
    leagueId: string;
    entries: HallOfFameEntry[];
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!leagueId) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const entries = await loadHallOfFame(leagueId);

        if (!cancelled) {
          setResult({ leagueId, entries, error: null });
        }
      } catch (cause) {
        if (!cancelled) {
          setResult({
            leagueId,
            entries: [],
            error:
              cause instanceof Error
                ? cause.message
                : "The Hall of Fame could not be loaded.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  /*
   * A result for the league just switched away from is not shown, so the previous league's
   * champions never flash up under the new league's heading.
   */
  const current = result && result.leagueId === leagueId ? result : null;
  const loading = Boolean(leagueId) && current === null;
  const entries = current?.entries ?? [];
  const error = current?.error ?? null;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-slate-950/40">
          <h1 className="text-3xl font-bold text-white">Hall of Fame</h1>
          <p className="mt-1 text-sm text-slate-400">
            Every champion this league has crowned, with the badge their
            title is worth. Eight titles earn a region&apos;s badges, then the
            next region begins.
          </p>
        </header>

        {!leagueId ? (
          <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
            Choose a league to see its history.
          </p>
        ) : loading ? (
          <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
            Loading the Hall of Fame...
          </p>
        ) : error ? (
          <p className="rounded-2xl border border-rose-900 bg-rose-950/40 p-6 text-sm text-rose-200">
            {error}
          </p>
        ) : entries.length === 0 ? (
          <p className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-400">
            No champion yet. The first entry appears once a season&apos;s grand
            final is settled.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {entries.map((entry) => (
              <ChampionCard key={entry.season} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}