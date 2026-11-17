/*
 * The Standings tab: the season table with each team's record and roster.
 */
"use client";

import { MemberName } from "@/components/member-name";
import { getSpriteUrl } from "@/lib/pokeapi";
import type { SchedulePageGoods } from "@/lib/supabase/schedule";

import { Avatar, SectionCard } from "./schedule-ui";

/** Props for the {@link StandingsTab} component. */
export interface StandingsTabProps {
  goods: SchedulePageGoods;
  /** Resolves a team to the name shown for it. */
  teamLabel: (teamId: string, fallbackName: string) => string;
  /** Resolves a team to its owner's chosen colour. */
  teamColor: (teamId: string) => string | null;
  /** Resolves a team to its owner's stored initials. */
  teamInitials: (teamId: string) => string | null;
  /** Resolves a team to its owner's member id, or null when vacant. */
  teamOwnerId: (teamId: string) => string | null;
}

/**
 * Renders the standings table.
 *
 * @param props - {@link StandingsTabProps}
 * @returns The standings tab.
 */
export function StandingsTab({
  goods,
  teamLabel,
  teamColor,
  teamInitials,
  teamOwnerId,
}: StandingsTabProps) {
  return (
    <SectionCard title="Standings">
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950 text-slate-300">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Rank</th>
              <th className="px-4 py-3 text-left font-semibold">Player</th>
              <th className="px-4 py-3 text-center font-semibold">W</th>
              <th className="px-4 py-3 text-center font-semibold">L</th>
              <th className="px-4 py-3 text-center font-semibold">KO Diff</th>
              <th
                className="px-4 py-3 text-center font-semibold"
                title="Prediction points: one per correct winner pick"
              >
                PP
              </th>
              <th className="px-4 py-3 text-left font-semibold">Pokemon</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900">
            {goods.standings.map((row, index) => (
              <tr key={row.team_id} className="hover:bg-slate-800/80">
                <td className="px-4 py-3 font-medium text-slate-100">
                  {index + 1}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar
                      name={teamLabel(row.team_id, row.team_name)}
                      nameColor={teamColor(row.team_id)}
                      avatarUrl={
                        goods.teams.find(
                          (team) => team.id === row.team_id,
                        )?.owner_avatar_url ?? null
                      }
                      initials={teamInitials(row.team_id)}
                      size={28}
                    />
                    <span className="font-medium text-slate-100">
                      <MemberName
                        name={teamLabel(row.team_id, row.team_name)}
                        color={teamColor(row.team_id)}
                        className="font-medium text-slate-100"
                        userId={teamOwnerId(row.team_id)}
                      />
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-center text-slate-300">
                  {row.wins}
                </td>
                <td className="px-4 py-3 text-center text-slate-300">
                  {row.losses}
                </td>
                <td className="px-4 py-3 text-center font-medium text-slate-100">
                  {row.ko_diff}
                </td>
                <td className="px-4 py-3 text-center font-medium text-white">
                  {row.prediction_points}
                </td>
                <td className="px-4 py-3">
                  <ul className="flex flex-wrap items-center gap-1.5">
                    {(goods.rostersByTeam[row.team_id] ?? []).map(
                      (pokemon) => (
                        <li key={pokemon.id}>
                          {pokemon.spriteId > 0 ? (
                            <img
                              src={getSpriteUrl(pokemon.spriteId)}
                              alt={pokemon.name}
                              title={pokemon.name}
                              width={56}
                              height={56}
                              loading="lazy"
                              className="h-14 w-14 object-contain"
                            />
                          ) : (
                            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-700 text-base text-slate-400">
                              ?
                            </span>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        PP = prediction points: one for each correct winner pick, credited to the
        picker&apos;s team.
      </p>
    </SectionCard>
  );
}
