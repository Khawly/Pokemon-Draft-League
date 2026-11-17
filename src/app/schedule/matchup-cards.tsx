/*
 * Presentational pieces shared by the schedule page's Matchup tab: the status
 * pill, the spoiler mask, roster sprites, and the completed-match card.
 */
"use client";

import { type ReactNode } from "react";
import { MemberName } from "@/components/member-name";
import { formatDateTimeInZone } from "@/lib/datetime";
import { getSpriteUrl } from "@/lib/pokeapi";
import * as scheduleApi from "@/lib/supabase/schedule";

import { Avatar, sideByTeamId } from "./schedule-ui";

/**
 * One row in the matchup card's Games list.
 *
 * `mirrored` marks the synthetic row shown for the third game of a best-of-3
 * that was decided in two. It copies game 2 so the card reads consistently, but
 * it is only ever rendered: nothing is submitted for it, so it contributes no
 * differential of its own to the season standings.
 */
export type GameRow = {
  result: scheduleApi.ScheduleMatchResult;
  mirrored: boolean;
};

/**
 * Builds the Games rows for a match, appending a mirrored third game when a
 * best-of-3 was decided in two. The mirror reuses game 2's winner, survivor
 * count and replay link; it is display-only, so unlike a submitted game it never
 * reaches season_standings and cannot skew the season differential.
 *
 * @param match - The match to list games for.
 * @param matchFormat - The match's format, which decides whether a third game
 *   can exist at all.
 * @returns The real game rows, plus the mirror when one applies.
 */
export function buildGameRows(
  match: scheduleApi.ScheduleMatch,
  matchFormat: "single" | "best_of_3" | null,
): GameRow[] {
  const rows: GameRow[] = match.results
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
    .map((result) => ({ result, mirrored: false }));

  const hasThirdGame = rows.some((row) => row.result.game_number === 3);
  const secondGame = rows.find((row) => row.result.game_number === 2);
  if (
    matchFormat === "best_of_3" &&
    rows.length === 2 &&
    !hasThirdGame &&
    secondGame
  ) {
    rows.push({
      result: {
        ...secondGame.result,
        id: `${secondGame.result.id}-mirrored-game-3`,
        game_number: 3,
      },
      mirrored: true,
    });
  }

  return rows;
}

/** Match status badge colors. */
const STATUS_STYLES: Record<string, string> = {
  unscheduled: "bg-slate-800 text-slate-400",
  scheduled: "bg-sky-500/15 text-sky-300",
  in_progress: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  forfeit: "bg-rose-500/15 text-rose-300",
  cancelled: "bg-slate-800 text-slate-500",
};

/** Human-readable label for each match status. */
const STATUS_LABELS: Record<string, string> = {
  unscheduled: "Unscheduled",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  forfeit: "Forfeit",
  cancelled: "Cancelled",
};

/**
 * Renders a match's status as a pill.
 *
 * @param props.status - The match status to label.
 * @returns The status pill.
 */
export function StatusBadge({
  status,
}: {
  status: scheduleApi.ScheduleMatch["status"];
}) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
        STATUS_STYLES[status] ?? "bg-slate-800 text-slate-300"
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/**
 * Masks a result while the spoiler filter is on.
 *
 * A solid black rectangle covers the text: the content is kept in the DOM at its
 * natural width so the card does not reflow when the filter is toggled, but the
 * text is made transparent, unselectable, and hidden from assistive tech.
 *
 * The transparent colour is forced onto descendants rather than set on this
 * element alone, because the masked values carry their own colour classes
 * (`text-emerald-300`, `text-slate-400`) and a specified colour on a child beats
 * one inherited from a parent, which would leave the text readable on black.
 *
 * @param props.hidden - Whether the mask is on.
 * @param props.children - The result values to cover.
 * @returns The children, masked when the filter is on.
 */
export function Spoiler({
  hidden,
  children,
}: {
  hidden: boolean;
  children: ReactNode;
}) {
  if (!hidden) {
    return <>{children}</>;
  }

  return (
    <span
      className="select-none rounded-sm bg-black [&_*]:!text-transparent"
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

/**
 * One team's roster as sprites, shown under a player's name on a matchup card.
 * A rostered Pokemon with no sprite falls back to a "?" tile, and a team with
 * nothing rostered says so rather than rendering an empty row.
 *
 * With `showNames`, up to six sprites sit on one row. A larger roster is split
 * into the two most even rows possible (7 becomes 4 + 3, 8 becomes 4 + 4, 12
 * becomes 6 + 6) instead of wrapping into whatever the width happens to allow.
 * The sprite tile keeps its size; the name gets its own slot below it, so
 * nothing shrinks to make room. An unnamed card can request the same arrangement
 * with `splitRows`.
 *
 * @param props - {@link RosterSpritesProps}
 * @returns A row or two of roster sprites, or a short empty-state line.
 */
export function RosterSprites({
  roster,
  align = "center",
  showNames = false,
  splitRows = false,
}: RosterSpritesProps) {
  if (roster.length === 0) {
    return <p className="text-xs text-slate-500">No Pokémon yet</p>;
  }

  function renderPokemon(pokemon: scheduleApi.ScheduleRosterSprite) {
    return (
      <li key={pokemon.id} className="flex flex-col items-center gap-1">
        <div className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border-2 border-slate-900 shadow-md shadow-slate-950/50">
          {pokemon.spriteId > 0 ? (
            <img
              src={getSpriteUrl(pokemon.spriteId)}
              alt={pokemon.name}
              title={pokemon.name}
              width={48}
              height={48}
              loading="lazy"
              className="relative h-12 w-12 object-contain"
            />
          ) : (
            <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-slate-700 text-sm text-slate-400">
              ?
            </span>
          )}
        </div>
        {showNames && (
          <span className="w-20 break-words text-center text-[10px] leading-tight text-slate-300">
            {pokemon.name}
          </span>
        )}
      </li>
    );
  }

  if (showNames || splitRows) {
    /*
     * Split the roster in half rather than letting flex-wrap decide, so a
     * seven-Pokemon team reads as 4 + 3 instead of 6 + 1. Six or fewer stay on
     * a single row, which is the whole point of this layout.
     */
    const splitAt = Math.ceil(roster.length / 2);
    const rows =
      roster.length > 6
        ? [roster.slice(0, splitAt), roster.slice(splitAt)]
        : [roster];

    return (
      <div className="space-y-2">
        {rows.map((row, index) => (
          <ul
            key={row[0]?.id ?? index}
            className={`flex items-start gap-1 ${
              align === "center" ? "justify-center" : "justify-start"
            }`}
          >
            {row.map(renderPokemon)}
          </ul>
        ))}
      </div>
    );
  }

  return (
    <ul
      className={`flex flex-wrap items-start gap-1 ${
        align === "center" ? "justify-center" : "justify-start"
      }`}
    >
      {roster.map(renderPokemon)}
    </ul>
  );
}

/** Props for {@link RosterSprites}. */
interface RosterSpritesProps {
  /** The team's roster to draw, richest Pokemon first. */
  roster: scheduleApi.ScheduleRosterSprite[];
  align?: "center" | "start";
  /** Whether to print each Pokemon's name under its sprite. Off by default. */
  showNames?: boolean;
  /**
   * Apply the one-row/split-evenly layout even without names. Named sprites
   * always use it; unnamed cards opt in when they want the same arrangement.
   */
  splitRows?: boolean;
}

/** Props for {@link MatchupHistoryCard}. */
export interface MatchupHistoryCardProps {
  match: scheduleApi.ScheduleMatch;
  matchFormat: "single" | "best_of_3" | null;
  timeZone: string;
  hideSpoilers: boolean;
  selected: boolean;
  onSelect: () => void;
  /** Sprite rosters keyed by team id, so each side shows its Pokemon. */
  rostersByTeam: Record<string, scheduleApi.ScheduleRosterSprite[]>;
  /** The season's first playoff week, so a bracket round reads as "Playoffs (Week 1)". */
  firstPlayoffWeek: number | null;
}

/**
 * A read-only matchup card for a completed match, used by the match history
 * panel. Mirrors the Matchup section's layout and honours the spoiler filter, but
 * carries none of its action buttons; selecting the card loads the match into the
 * Matchup section above instead. It also names the current member's winner pick,
 * which is otherwise lost once the card stops offering the picker.
 *
 * @param props - {@link MatchupHistoryCardProps}
 * @returns The completed-match card.
 */
export function MatchupHistoryCard({
  match,
  matchFormat,
  timeZone,
  hideSpoilers,
  selected,
  onSelect,
  rostersByTeam,
  firstPlayoffWeek,
}: MatchupHistoryCardProps) {
  const rows = buildGameRows(match, matchFormat);
  const winnerSide = (teamId: string) =>
    !hideSpoilers && match.winner_team_id === teamId;
  const predictionSide = match.my_prediction_team_id
    ? {
        ...sideByTeamId(match, match.my_prediction_team_id),
        userId:
          match.my_prediction_team_id === match.player_1_team_id
            ? match.player_1_user_id
            : match.player_2_user_id,
      }
    : null;

  const side = (
    teamId: string,
    name: string,
    avatarUrl: string | null,
    nameColor: string | null,
    initials: string | null,
    showdownUsername: string | null,
  ) => (
    <div className="flex flex-1 flex-col items-center gap-1 text-center">
      <Avatar
        name={name}
        nameColor={nameColor}
        avatarUrl={avatarUrl}
        initials={initials}
        size={80}
        winner={winnerSide(teamId)}
      />
      <MemberName
        name={name}
        color={nameColor}
        className="font-semibold text-slate-100"
        userId={
          teamId === match.player_1_team_id
            ? match.player_1_user_id
            : match.player_2_user_id
        }
        showdownUsername={showdownUsername}
      />
      {scheduleApi.gameRecord(match, teamId) && (
        <Spoiler hidden={hideSpoilers}>
          <span className="text-sm text-slate-400">
            {scheduleApi.gameRecord(match, teamId)}
          </span>
        </Spoiler>
      )}
      <div className="mt-1">
        <RosterSprites roster={rostersByTeam[teamId] ?? []} />
      </div>
    </div>
  );

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border p-4 text-left transition ${
        selected
          ? "border-amber-500/60 bg-slate-800/80"
          : "border-slate-800 bg-slate-950/60 hover:bg-slate-900"
      }`}
    >
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
        {scheduleApi.matchWeekLabel(match, firstPlayoffWeek)}
        {match.scheduled_at
          ? ` • ${formatDateTimeInZone(match.scheduled_at, timeZone)}`
          : ""}
      </p>

      <div className="flex w-full items-center justify-between gap-3">
        {side(
          match.player_1_team_id,
          match.player_1_name,
          match.player_1_avatar_url,
          match.player_1_name_color,
          match.player_1_avatar_initials,
          match.player_1_showdown_username,
        )}
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
            vs
          </span>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">
            {matchFormat === "single" ? "Single" : "Best of 3"}
          </span>
          <StatusBadge status={match.status} />
        </div>
        {side(
          match.player_2_team_id ?? "",
          match.player_2_name,
          match.player_2_avatar_url,
          match.player_2_name_color,
          match.player_2_avatar_initials,
          match.player_2_showdown_username,
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-slate-800 pt-3">
          {rows.map(({ result }) => {
            const winner = sideByTeamId(match, result.winner_team_id);
            return (
              <div
                key={result.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                    Game {result.game_number}
                  </span>
                  <Spoiler hidden={hideSpoilers}>
                    <span className="font-semibold text-emerald-300">
                      <MemberName
                        name={winner.name}
                        color={winner.color}
                        className="font-semibold text-emerald-300"
                        userId={
                          result.winner_team_id === match.player_1_team_id
                            ? match.player_1_user_id
                            : match.player_2_user_id
                        }
                      />{" "}
                      wins
                    </span>
                  </Spoiler>
                  {result.pokemon_left_alive != null && (
                    <Spoiler hidden={hideSpoilers}>
                      <span className="text-slate-400">
                        • {result.pokemon_left_alive} alive
                      </span>
                    </Spoiler>
                  )}
                  {result.reporter_name && (
                    <span className="text-xs text-slate-500">
                      Submitted by{" "}
                      <MemberName
                        name={result.reporter_name}
                        color={result.reporter_name_color}
                      />
                    </span>
                  )}
                </div>
                {result.replay_url && (
                  <span
                    role="link"
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      window.open(
                        result.replay_url ?? "",
                        "_blank",
                        "noreferrer",
                      );
                    }}
                    className="text-sky-400 underline decoration-sky-700 hover:text-sky-300"
                  >
                    Replay
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {predictionSide && (
        <p className="mt-3 border-t border-slate-800 pt-3 text-xs text-slate-500">
          Your pick:{" "}
          <MemberName
            name={predictionSide.name}
            color={predictionSide.color}
            userId={predictionSide.userId}
            className="font-semibold text-slate-300"
          />
        </p>
      )}

      {match.status === "forfeit" && match.forfeited_by_name && (
        <p className="mt-3 border-t border-slate-800 pt-3 text-xs text-slate-500">
          Forfeited by{" "}
          <MemberName
            name={match.forfeited_by_name}
            color={match.forfeited_by_name_color}
          />
        </p>
      )}
    </button>
  );
}
