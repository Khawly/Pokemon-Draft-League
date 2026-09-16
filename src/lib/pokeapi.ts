/*
 * Pokémon data access for the Pokemon Draft League.
 *
 * Serves the full national-dex dataset (name, types, BST, generation) plus the
 * distinct alternate forms (regionals, Rotom appliances, Deoxys formes, etc.)
 * from bundled JSON snapshots generated from the PokeAPI (see
 * scripts/generate-pokemon-data.mjs and scripts/generate-pokemon-forms.mjs), so
 * catalog search, details, and sprites resolve instantly without runtime
 * network calls. Forms share their base species' dex number but carry their own
 * sprite id, typing, and stats, so they can be drafted as separate entries.
 * Sprites are served locally from public/sprites/ keyed by sprite id.
 */

import pokemonJson from "@/data/pokemon.json";
import formsJson from "@/data/pokemon-forms.json";

/** A single entry in the Pokémon national-dex dataset. */
export type PokemonCatalogEntry = {
  /** PokeAPI species resource name, e.g. "pikachu". */
  slug: string;
  /** National Pokédex number, e.g. 25. */
  dexNumber: number;
};

/** Rich metadata about a Pokémon species used by the draft pool table. */
export type PokemonDetails = {
  /** Primary type name, e.g. "electric". */
  primaryType: string | null;
  /** Secondary type name, e.g. "flying", or null for single-typed species. */
  secondaryType: string | null;
  /** Sum of base stats (BST). */
  baseStatTotal: number;
  /** Generation label, e.g. "Gen 1". */
  generation: string;
};

/** One record of the bundled national-dex dataset. */
export type PokemonDataEntry = {
  /** PokeAPI species resource name, e.g. "pikachu". */
  slug: string;
  /** National Pokédex number, e.g. 25. */
  dexNumber: number;
  /** Official English species name, e.g. "Farfetch'd". */
  name: string;
  /** Typing as PokeAPI type names, e.g. ["electric"]. */
  types: string[];
  /** Sum of base stats (BST). */
  bst: number;
  /** Generation label, e.g. "Gen 1". */
  generation: string;
};

/** A distinct alternate form from the bundled forms dataset. */
export type PokemonFormEntry = {
  /** PokeAPI form resource name, e.g. "deoxys-defense". */
  slug: string;
  /** Slug of the base species the form belongs to, e.g. "deoxys". */
  baseSlug: string;
  /** Sprite id: 10001+ form id, distinct from the base species' dex number. */
  spriteId: number;
  /** National Pokédex number inherited from the base species, e.g. 386. */
  dexNumber: number;
  /** Display name, e.g. "Deoxys (Defense Forme)". */
  name: string;
  /** Typing as PokeAPI type names, e.g. ["psychic"]. */
  types: string[];
  /** Sum of base stats (BST). */
  bst: number;
  /** Generation label, e.g. "Gen 3". */
  generation: string;
};

/**
 * A resolved Pokémon — species or alternate form — with enough to build a pool
 * row: the slug (pokemon_id), the base-species dex number, the sprite id, and
 * the display metadata derived from the matched entry's own typing/stats.
 */
export type PokemonMatch = {
  /** PokeAPI slug used as the pool row's pokemon_id, e.g. "deoxys-defense". */
  slug: string;
  /** National Pokédex number inherited from the base species. */
  dexNumber: number;
  /** Sprite id: the dex number for species, 10001+ for alternate forms. */
  spriteId: number;
  /** Display name, e.g. "Deoxys (Defense Forme)". */
  name: string;
  /** Typing as PokeAPI type names. */
  types: string[];
  /** Sum of base stats (BST). */
  bst: number;
  /** Generation label. */
  generation: string;
};

/** The full national-dex dataset as a typed array. */
export const POKEMON_DATA = pokemonJson as PokemonDataEntry[];

/** Index of the dataset by species slug. */
const BY_SLUG = new Map(POKEMON_DATA.map((entry) => [entry.slug, entry]));

/** Index of dex numbers by species slug. */
const DEX_BY_SLUG = new Map(
  POKEMON_DATA.map((entry) => [entry.slug, entry.dexNumber]),
);

/** The full alternate-forms dataset as a typed array. */
export const FORMS_DATA = formsJson as PokemonFormEntry[];

/** Index of alternate forms by form slug, e.g. "deoxys-defense". */
const FORM_BY_SLUG = new Map(FORMS_DATA.map((entry) => [entry.slug, entry]));

/**
 * Returns the full Pokémon catalog from the bundled dataset.
 *
 * @returns A promise resolving to every species as a catalog entry.
 */
export async function fetchPokemonCatalog(): Promise<PokemonCatalogEntry[]> {
  return POKEMON_DATA.map((entry) => ({
    slug: entry.slug,
    dexNumber: entry.dexNumber,
  }));
}

/**
 * Formats a PokeAPI slug into a human-readable species name, capitalizing each
 * hyphen-separated segment (e.g. "nidoran-f" -> "Nidoran F").
 *
 * @param slug - The PokeAPI species slug.
 * @returns The formatted display name.
 */
export function formatSpeciesName(slug: string): string {
  return slug
    .split("-")
    .map((segment) =>
      segment ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment,
    )
    .join(" ");
}

/**
 * Returns the official English name for a species slug.
 *
 * @param slug - The PokeAPI species slug.
 * @returns The official name, or the formatted slug if unknown.
 */
export function getSpeciesName(slug: string): string {
  return BY_SLUG.get(slug)?.name ?? formatSpeciesName(slug);
}

/**
 * Returns the national dex number for a species slug.
 *
 * @param slug - The PokeAPI species slug.
 * @returns The dex number, or 0 if unknown.
 */
export function getDexNumber(slug: string): number {
  return DEX_BY_SLUG.get(slug) ?? 0;
}

/**
 * Returns the path of the locally bundled sprite for a sprite id.
 *
 * Sprites live in `public/sprites/` (downloaded by
 * scripts/download-sprites.mjs) so they are served from the app itself with no
 * external dependency; Next.js optimizes and caches them automatically. The id
 * is the national dex number for species and an alternate-form id (10001+) for
 * forms.
 *
 * @param spriteId - The numeric sprite id.
 * @returns The local sprite path, e.g. "/sprites/25.png".
 */
export function getSpriteUrl(spriteId: number): string {
  return `/sprites/${spriteId}.png`;
}

/**
 * Searches the national-dex dataset by name substring.
 *
 * Matches against the species slug, the official name, and the formatted
 * display name, case-insensitively.
 *
 * @param query - The substring to match against species names.
 * @param limit - The maximum number of results to return.
 * @returns Matching catalog entries, or [].
 */
export async function searchPokemonCatalog(
  query: string,
  limit = 48,
): Promise<PokemonCatalogEntry[]> {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return [];
  }

  return POKEMON_DATA.filter(
    (entry) =>
      entry.slug.includes(normalized) ||
      entry.name.toLowerCase().includes(normalized) ||
      formatSpeciesName(entry.slug).toLowerCase().includes(normalized),
  )
    .slice(0, limit)
    .map((entry) => ({ slug: entry.slug, dexNumber: entry.dexNumber }));
}

/**
 * Resolves species details from the bundled dataset.
 *
 * @param slug - The PokeAPI species slug, e.g. "pikachu".
 * @returns A promise resolving to the species details, or null if unknown.
 */
export async function fetchPokemonDetails(
  slug: string,
): Promise<PokemonDetails | null> {
  const entry = BY_SLUG.get(slug);

  if (!entry) {
    return null;
  }

  return {
    primaryType: entry.types[0] ?? null,
    secondaryType: entry.types[1] ?? null,
    baseStatTotal: entry.bst,
    generation: entry.generation,
  };
}

/**
 * Words describing region/form variants that, when no distinct alternate-form
 * entry matches, reduce to the base species. A CSV like "Galarian Mr. Mime" or
 * "Thundurus (Therian Forme)" first attempts a distinct-form match, and only
 * falls back to collapsing these qualifiers for names that are really the base
 * species (e.g. "(No Mega)").
 */
const VARIANT_STOP_WORDS = new Set([
  "form",
  "forme",
  "forms",
  "style",
  "styles",
  "breed",
  "mega",
  "nerf",
  "no",
  "ordinary",
  "incarnate",
  "therian",
  "defense",
  "attack",
  "land",
  "sky",
  "blue",
  "striped",
  "super",
  "size",
  "aqua",
  "female",
  "male",
  "mow",
  "heat",
  "wash",
  "fan",
  "frost",
  "pau",
  "pompom",
  "sensu",
  "baile",
  "alolan",
  "alola",
  "galarian",
  "galar",
  "hisuian",
  "hisui",
  "paldean",
  "paldea",
  "kantonian",
  "kanto",
]);

/**
 * Reduces a (possibly variant-qualified) name to a canonical base-name key.
 *
 * Drops parenthetical qualifiers ("(Defense Forme)"), region prefixes
 * ("Alolan", "Hisuian"), and known form descriptors ("Mow Rotom", "(No Mega)")
 * so the remaining tokens identify the species.
 *
 * @param value - The name to reduce.
 * @returns The canonical base-name key, or "" when nothing remains.
 */
function variantKey(value: string): string {
  const cleaned = value.replace(/\([^)]*\)/g, " ");
  const tokens = cleaned
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return tokens
    .filter(
      (token) => !VARIANT_STOP_WORDS.has(token) && !/^\d+$/.test(token),
    )
    .join("");
}

/**
 * Normalizes a name for matching by lowercasing and stripping every
 * non-alphanumeric character (handles symbols, hyphens, spaces, apostrophes).
 *
 * @param value - The raw name to normalize.
 * @returns The normalized comparison key.
 */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Finds a species entry whose slug, official name, or formatted slug normalizes
 * to the given key.
 *
 * @param key - A normalized comparison key (lowercased, alphanumeric only).
 * @returns The matching species entry, or undefined.
 */
function findSpeciesByKey(key: string): PokemonDataEntry | undefined {
  return POKEMON_DATA.find((entry) => {
    const speciesKeys = [
      normalizeName(entry.slug),
      normalizeName(entry.name),
      normalizeName(formatSpeciesName(entry.slug)),
    ];
    return speciesKeys.includes(key);
  });
}

/**
 * Finds an alternate-form entry whose slug or display name normalizes to the
 * given key.
 *
 * @param key - A normalized comparison key (lowercased, alphanumeric only).
 * @returns The matching form entry, or undefined.
 */
function findFormByKey(key: string): PokemonFormEntry | undefined {
  return FORMS_DATA.find((entry) => {
    const formKeys = [normalizeName(entry.slug), normalizeName(entry.name)];
    return formKeys.includes(key);
  });
}

/** Builds a {@link PokemonMatch} from a species entry. */
function speciesToMatch(entry: PokemonDataEntry): PokemonMatch {
  return {
    slug: entry.slug,
    dexNumber: entry.dexNumber,
    spriteId: entry.dexNumber,
    name: entry.name,
    types: entry.types,
    bst: entry.bst,
    generation: entry.generation,
  };
}

/** Builds a {@link PokemonMatch} from an alternate-form entry. */
function formToMatch(entry: PokemonFormEntry): PokemonMatch {
  return {
    slug: entry.slug,
    dexNumber: entry.dexNumber,
    spriteId: entry.spriteId,
    name: entry.name,
    types: entry.types,
    bst: entry.bst,
    generation: entry.generation,
  };
}

/**
 * Resolves a human-entered Pokémon name to a species or distinct alternate form.
 *
 * Matching order: (1) a species whose slug/name matches directly (so "Deoxys"
 * stays the base species), (2) an alternate form whose slug or display name
 * matches directly (so "Deoxys (Defense Forme)" resolves to deoxys-defense with
 * its own typing and sprite), and (3) the variant-collapsed base species (so
 * "(No Mega)" names land on the base species rather than being skipped).
 *
 * @param name - The name to resolve from user input.
 * @returns A promise resolving to the matching entry, or null if nothing matches.
 */
export async function matchPokemonName(
  name: string,
): Promise<PokemonMatch | null> {
  const directKey = normalizeName(name);
  const baseKey = variantKey(name);
  if (!directKey && !baseKey) {
    return null;
  }

  const speciesDirect = directKey ? findSpeciesByKey(directKey) : undefined;
  if (speciesDirect) {
    return speciesToMatch(speciesDirect);
  }

  const formDirect = directKey ? findFormByKey(directKey) : undefined;
  if (formDirect) {
    return formToMatch(formDirect);
  }

  const speciesBase = baseKey ? findSpeciesByKey(baseKey) : undefined;
  if (speciesBase) {
    return speciesToMatch(speciesBase);
  }

  return null;
}

/**
 * Resolves a stored slug to its species or alternate-form entry, whichever it
 * belongs to.
 *
 * @param slug - The PokeAPI slug, e.g. "pikachu" or "deoxys-defense".
 * @returns The resolved entry, or null if the slug is unknown.
 */
export function getPokemonEntryBySlug(slug: string): PokemonMatch | null {
  const speciesEntry = BY_SLUG.get(slug);
  if (speciesEntry) {
    return speciesToMatch(speciesEntry);
  }
  const formEntry = FORM_BY_SLUG.get(slug);
  if (formEntry) {
    return formToMatch(formEntry);
  }
  return null;
}