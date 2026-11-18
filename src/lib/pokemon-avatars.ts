/*
 * Searchable Pokemon sprite avatars for member profiles.
 *
 * Members can use any bundled Pokemon sprite as their avatar instead of uploading
 * a picture. The sprite's local path is stored in the same `avatar_url` column an
 * uploaded image uses, so every page that already renders an avatar shows the
 * sprite without a schema change. This module builds the search index once and
 * recognises a sprite path again when one has to be cleared.
 */

import { FORMS_DATA, POKEMON_DATA, getSpriteUrl } from "@/lib/pokeapi";

/** One selectable Pokemon sprite in the avatar picker. */
export interface PokemonAvatarOption {
  /** Sprite id used to build the local sprite path. */
  spriteId: number;
  /** Display name, e.g. "Pikachu" or "Mega Venusaur". */
  name: string;
  /** National Pokedex number, also matched when a member types a number. */
  dexNumber: number;
  /** Local sprite path, stored as the profile's avatar URL. */
  url: string;
}

/**
 * How many matches the picker renders at once.
 *
 * The full national dex plus alternate forms is over a thousand sprites, so the
 * grid is capped rather than dumping every image into the page.
 */
export const MAX_POKEMON_AVATAR_RESULTS = 36;

/** An option plus the pre-normalized text its search matches against. */
type IndexedOption = PokemonAvatarOption & { searchText: string };

/**
 * Normalizes a name or query so punctuation, accents, and spacing cannot stop a
 * reasonable search from matching: "flabebe" finds "Flabébé", and "mega venusaur"
 * finds "Mega Venusaur" or its slug.
 *
 * @param value - The text to normalize.
 * @returns Lowercase letters and digits only.
 */
function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Every selectable sprite, ordered by dex number with base species before forms. */
const POKEMON_AVATAR_OPTIONS: IndexedOption[] = [
  ...POKEMON_DATA.map((entry) => ({
    spriteId: entry.dexNumber,
    name: entry.name,
    dexNumber: entry.dexNumber,
    url: getSpriteUrl(entry.dexNumber),
    searchText: normalizeSearch(`${entry.name} ${entry.slug}`),
  })),
  ...FORMS_DATA.map((form) => ({
    spriteId: form.spriteId,
    name: form.name,
    dexNumber: form.dexNumber,
    url: getSpriteUrl(form.spriteId),
    searchText: normalizeSearch(`${form.name} ${form.slug}`),
  })),
].sort(
  (left, right) =>
    left.dexNumber - right.dexNumber || left.spriteId - right.spriteId,
);

/**
 * Searches the bundled sprites by name, slug, or exact dex number.
 *
 * An empty query returns the start of the dex so the picker still offers a
 * browsable starting point instead of an empty grid.
 *
 * @param query - What the member typed into the search box.
 * @param limit - Maximum number of options to return.
 * @returns Matching avatar options, in dex order.
 */
export function searchPokemonAvatars(
  query: string,
  limit: number = MAX_POKEMON_AVATAR_RESULTS,
): PokemonAvatarOption[] {
  const normalized = normalizeSearch(query);
  const matches = normalized
    ? POKEMON_AVATAR_OPTIONS.filter(
        (option) =>
          option.searchText.includes(normalized) ||
          String(option.dexNumber) === normalized,
      )
    : POKEMON_AVATAR_OPTIONS;

  return matches.slice(0, Math.max(0, limit)).map((option) => ({
    spriteId: option.spriteId,
    name: option.name,
    dexNumber: option.dexNumber,
    url: option.url,
  }));
}

/**
 * Reports whether a profile avatar URL points at a bundled Pokemon sprite.
 *
 * A sprite avatar has no object in the avatars storage bucket, so clearing one
 * must not attempt a storage delete.
 *
 * @param avatarUrl - The profile's stored avatar URL, if any.
 * @returns True when the URL is one of the local sprite paths.
 */
export function isPokemonSpriteAvatarUrl(
  avatarUrl: string | null | undefined,
): boolean {
  return typeof avatarUrl === "string" && /^\/sprites\/\d+\.png$/.test(avatarUrl);
}
