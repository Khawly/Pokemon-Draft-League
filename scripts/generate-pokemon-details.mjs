/*
 * Generates src/data/pokemon-details.json from the PokeAPI.
 *
 * For every species in src/data/pokemon.json (fetched by national dex number)
 * and every alternate form in src/data/pokemon-forms.json (fetched by its
 * 10001+ form id) this captures the six base stats (HP, Attack, Defense,
 * Sp. Atk, Sp. Def, Speed) and the ability list (normal + hidden), keyed by the
 * same slug the roster/pool rows store as pokemon_id. The Team page uses this
 * file to render the abilities and stat columns without a runtime network
 * call.
 *
 * Run: node scripts/generate-pokemon-details.mjs
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONCURRENCY = 16;
const MAX_RETRIES = 4;

const STAT_KEYS = {
  hp: "hp",
  attack: "attack",
  defense: "defense",
  "special-attack": "specialAttack",
  "special-defense": "specialDefense",
  speed: "speed",
};

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

function mapPokemon(pokemon) {
  const stats = {};
  for (const entry of pokemon.stats ?? []) {
    const key = STAT_KEYS[entry.stat?.name];
    if (key) {
      stats[key] = entry.base_stat ?? 0;
    }
  }
  const abilities = (pokemon.abilities ?? [])
    .map((ability) => ({
      name: ability.ability?.name ?? null,
      hidden: Boolean(ability.is_hidden),
    }))
    .filter((ability) => ability.name !== null);

  return { stats, abilities };
}

async function main() {
  const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
  const species = JSON.parse(
    readFileSync(join(baseDir, "pokemon.json"), "utf8"),
  );
  const forms = JSON.parse(
    readFileSync(join(baseDir, "pokemon-forms.json"), "utf8"),
  );

  // Species fetch by national dex number (1..1025); forms by their 10001+ id.
  const targets = [
    ...species.map((entry) => ({ id: entry.dexNumber, slug: entry.slug })),
    ...forms.map((entry) => ({ id: entry.spriteId, slug: entry.slug })),
  ];

  console.log(`Fetching details for ${targets.length} species/forms...`);

  const results = new Array(targets.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < targets.length) {
      const index = nextIndex;
      nextIndex += 1;
      const target = targets[index];
      try {
        const pokemon = await fetchJson(
          `https://pokeapi.co/api/v2/pokemon/${target.id}`,
        );
        results[index] = { slug: target.slug, ...mapPokemon(pokemon) };
      } catch (error) {
        // Leave the slot undefined so the row is skipped from the output.
        console.error(`Failed ${target.slug} (#${target.id}): ${error.message}`);
      }
      if (index % 50 === 0) {
        console.log(`${index}/${targets.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const data = results
    .filter(Boolean)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const outputPath = join(baseDir, "pokemon-details.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");

  console.log(`Wrote ${data.length} entries to ${outputPath}`);
}

main().catch((error) => {
  console.error("Generation failed:", error);
  process.exit(1);
});