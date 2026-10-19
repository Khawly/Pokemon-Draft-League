/*
 * Reads a league's champions, for the Hall of Fame.
 *
 * The champions themselves come from a database function that reads playoff_champion per
 * season, so the hall is derived from the same answer the crown and the bracket use. Their
 * Pokemon are read separately, in one query for every champion team, because a roster is a
 * list per team rather than an attribute of the title.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getPokemonEntryBySlug } from "@/lib/pokeapi";
import { supabase } from "@/lib/supabase/client";

/** One Pokemon on a champion's roster, resolved for display. */
export type HallPokemon = {
  id: string;
  name: string;
  spriteId: number;
  /** Tier cost, so the roster reads in the same order as the team pages. */
  tierValue: number;
};

/** One champion, with what the hall shows of them. */
export type HallOfFameEntry = {
  season: number;
  /** The season's display name, when one was set. */
  seasonName: string | null;
  teamId: string;
  teamName: string;
  ownerUserId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  nameColor: string | null;
  avatarInitials: string | null;
  /** Richest first, matching how a roster is shown everywhere else. */
  pokemon: HallPokemon[];
};

type ChampionRow = {
  season_number: number;
  season_name: string | null;
  team_id: string;
  team_name: string;
  owner_user_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  name_color: string | null;
  avatar_initials: string | null;
};

/**
 * Loads every decided champion for a league, oldest first.
 *
 * @param leagueId - The league whose history to read.
 * @returns The champions, with their rosters attached.
 * @throws If the champion read fails; a failed roster read leaves that champion's Pokemon
 *   empty rather than losing the entry.
 */
export async function loadHallOfFame(
  leagueId: string,
  client: SupabaseClient = supabase,
): Promise<HallOfFameEntry[]> {
  const { data, error } = await client.rpc("season_champions", {
    p_league_id: leagueId,
  });

  if (error) {
    throw new Error(error.message || "The Hall of Fame could not be loaded.");
  }

  const champions = (data ?? []) as ChampionRow[];

  if (champions.length === 0) {
    return [];
  }

  /*
   * One read for every champion's roster rather than one per champion. A league with a long
   * history would otherwise make a request per trophy.
   */
  const { data: rosterData, error: rosterError } = await client
    .from("team_roster")
    .select("id, team_id, pokemon_id, tier_value")
    .in(
      "team_id",
      champions.map((champion) => champion.team_id),
    );

  const rosterRows = rosterError
    ? []
    : ((rosterData ?? []) as {
        id: string;
        team_id: string;
        pokemon_id: string;
        tier_value: number;
      }[]);

  return champions.map((champion) => {
    const pokemon = rosterRows
      .filter((row) => row.team_id === champion.team_id)
      .sort((a, b) => b.tier_value - a.tier_value || a.id.localeCompare(b.id))
      .map<HallPokemon>((row) => {
        const catalog = getPokemonEntryBySlug(row.pokemon_id);
        return {
          id: row.id,
          name: catalog?.name ?? row.pokemon_id,
          spriteId: catalog?.spriteId ?? 0,
          tierValue: row.tier_value,
        };
      });

    return {
      season: champion.season_number,
      seasonName: champion.season_name,
      teamId: champion.team_id,
      teamName: champion.team_name,
      ownerUserId: champion.owner_user_id,
      displayName: champion.display_name,
      avatarUrl: champion.avatar_url,
      nameColor: champion.name_color,
      avatarInitials: champion.avatar_initials,
      pokemon,
    };
  });
}