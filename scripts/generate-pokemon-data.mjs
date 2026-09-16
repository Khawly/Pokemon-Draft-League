/*
 * Generates src/data/pokemon.json from the PokeAPI.
 *
 * Fetches the full species catalog plus, per species, the pokemon resource
 * (types + base stats) and the pokemon-species resource (official English name
 * and generation). Outputs a single JSON array sorted by national dex number so
 * the app can serve catalog/details locally instead of hitting the API.
 *
 * Run: node scripts/generate-pokemon-data.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATION_LABELS = {
  "generation-i": "Gen 1",
  "generation-ii": "Gen 2",
  "generation-iii": "Gen 3",
  "generation-iv": "Gen 4",
  "generation-v": "Gen 5",
  "generation-vi": "Gen 6",
  "generation-vii": "Gen 7",
  "generation-viii": "Gen 8",
  "generation-ix": "Gen 9",
};

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

async function buildOne(entry) {
  const dexMatch = entry.url?.match(/pokemon-species\/(\d+)\/?$/);
  const dexNumber = dexMatch ? Number(dexMatch[1]) : NaN;
  if (!entry.name || !Number.isFinite(dexNumber)) {
    return null;
  }

  // The default/standard form for the species (dex id maps 1:1 to the sprite).
  const pokemon = await fetchJson(
    `https://pokeapi.co/api/v2/pokemon/${dexNumber}`,
  );

  // Resolve the species resource from the pokemon payload so region/alternate
  // forms never 404, and override the dexNumber with the true national dex id.
  const speciesUrl =
    pokemon.species?.url ?? `https://pokeapi.co/api/v2/pokemon-species/${dexNumber}`;
  const species = await fetchJson(speciesUrl);

  const englishName =
    species.names?.find((named) => named.language?.name === "en")?.name ??
    entry.name;

  const types = (pokemon.types ?? [])
    .map((slot) => slot.type?.name)
    .filter(Boolean);
  const bst = (pokemon.stats ?? []).reduce(
    (sum, stat) => sum + (stat.base_stat ?? 0),
    0,
  );
  const generation =
    GENERATION_LABELS[species.generation?.name ?? ""] ?? "Unknown";

  return {
    slug: entry.name,
    dexNumber,
    name: englishName,
    types,
    bst,
    generation,
  };
}

async function main() {
  const list = await fetchJson(
    "https://pokeapi.co/api/v2/pokemon-species?limit=2000&offset=0",
  );
  const entries = list.results ?? [];

  console.log(`Catalog has ${entries.length} entries; fetching details...`);

  const results = new Array(entries.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const result = await buildOne(entries[index]);
      results[index] = result;
      if (index % 50 === 0) {
        console.log(`${index}/${entries.length}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker()),
  );

  const data = results.filter(Boolean).sort((a, b) => a.dexNumber - b.dexNumber);

  const outputPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "data",
    "pokemon.json",
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");

  console.log(`Wrote ${data.length} species to ${outputPath}`);
}

main().catch((error) => {
  console.error("Generation failed:", error);
  process.exit(1);
});