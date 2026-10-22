/*
 * Adds the rare-species flags to the bundled Pokédex data.
 *
 * PokeAPI marks each species as legendary or mythical on its `pokemon-species`
 * resource, but the generators that produced src/data/pokemon.json and
 * src/data/pokemon-forms.json did not copy those flags. The draft pool needs
 * them to offer "remove legendaries / mythicals / gigantamax" actions without
 * shipping a hand-maintained list that will drift when a generation is added.
 *
 * Species are fetched by national dex number rather than slug, so a slug
 * difference cannot silently leave an entry unclassified. Alternate forms
 * inherit their base species' legendary/mythical status, because a form of a
 * legendary is still not a Pokémon a league normally allows; Gigantamax is
 * detected from the `-gmax` form suffix.
 *
 * Run: node scripts/generate-pokemon-rarity.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const SPECIES_PATH = "src/data/pokemon.json";
const FORMS_PATH = "src/data/pokemon-forms.json";

const CONCURRENCY = 16;
const MAX_RETRIES = 4;

async function fetchJson(url, attempt = 0) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "pokemon-draft-league-data-gen" },
    });

    if (response.status === 429 || response.status >= 500) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      const delay = Math.min(4000, 300 * Math.pow(2, attempt));
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchJson(url, attempt + 1);
    }

    throw error;
  }
}

/** Runs `worker` over `items` with a fixed number in flight. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

const species = JSON.parse(readFileSync(SPECIES_PATH, "utf8"));
const forms = JSON.parse(readFileSync(FORMS_PATH, "utf8"));

console.log(`fetching flags for ${species.length} species...`);

let done = 0;

const flagsByDex = new Map(
  await mapWithConcurrency(species, CONCURRENCY, async (entry) => {
    const resource = await fetchJson(
      `https://pokeapi.co/api/v2/pokemon-species/${entry.dexNumber}`,
    );

    done += 1;
    if (done % 100 === 0 || done === species.length) {
      console.log(`  ${done}/${species.length}`);
    }

    return [
      entry.dexNumber,
      {
        isLegendary: Boolean(resource.is_legendary),
        isMythical: Boolean(resource.is_mythical),
      },
    ];
  }),
);

const enrichedSpecies = species.map((entry) => {
  const flags = flagsByDex.get(entry.dexNumber) ?? {
    isLegendary: false,
    isMythical: false,
  };

  return {
    ...entry,
    isLegendary: flags.isLegendary,
    isMythical: flags.isMythical,
  };
});

const speciesBySlug = new Map(enrichedSpecies.map((entry) => [entry.slug, entry]));

const enrichedForms = forms.map((entry) => {
  const base = speciesBySlug.get(entry.baseSlug);

  return {
    ...entry,
    isLegendary: base?.isLegendary ?? false,
    isMythical: base?.isMythical ?? false,
    isGigantamax: entry.slug.endsWith("-gmax"),
  };
});

writeFileSync(SPECIES_PATH, `${JSON.stringify(enrichedSpecies, null, 2)}\n`);
writeFileSync(FORMS_PATH, `${JSON.stringify(enrichedForms, null, 2)}\n`);

const legendaryCount = enrichedSpecies.filter((entry) => entry.isLegendary).length;
const mythicalCount = enrichedSpecies.filter((entry) => entry.isMythical).length;
const gmaxCount = enrichedForms.filter((entry) => entry.isGigantamax).length;

console.log(
  `done: ${legendaryCount} legendary, ${mythicalCount} mythical, ${gmaxCount} gigantamax`,
);
