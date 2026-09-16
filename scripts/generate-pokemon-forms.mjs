/*
 * Generates src/data/pokemon-forms.json from the PokeAPI.
 *
 * Enumerates every alternate-form `pokemon` resource (ids >= 10001, e.g.
 * deoxys-defense, rotom-mow, samurott-hisui) and captures its typing, BST,
 * base-species dex number, and a human-friendly display name. Base species
 * (national dex 1..1025) live in src/data/pokemon.json and are not duplicated
 * here; this file only adds the distinct alternate forms.
 *
 * Run: node scripts/generate-pokemon-forms.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONCURRENCY = 16;
const MAX_RETRIES = 4;

// Forms whose "qualifying" name is just the base species (e.g. Zygarde 50% is
// the standard Zygarde) and so must NOT become a separate pool entry. This
// includes the ability-variant `-power-construct` duplicates of the standard
// 10%/50% forms and the unreleased Zygarde Mega. The 10% and Complete formes
// remain distinct entries.
const SKIP_SLUGS = new Set([
  "zygarde-50",
  "zygarde-50-power-construct",
  "zygarde-10-power-construct",
  "zygarde-mega",
]);

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

function titleCase(token) {
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Builds a display name for an alternate form, matching common conventions
 * ("Galarian Mr. Mime", "Mow Rotom", "Deoxys (Defense Forme)").
 */
function formatFormName(baseName, slug, baseSlug) {
  const tokens = slug
    .slice(baseSlug.length)
    .replace(/^-/, "")
    .split("-")
    .filter(Boolean);

  if (!tokens.length) {
    return baseName;
  }

  const regionPrefixes = {
    alola: "Alolan",
    galar: "Galarian",
    hisui: "Hisuian",
    paldea: "Paldean",
  };
  const first = tokens[0];

  if (baseSlug === "tauros") {
    const breedIndex = tokens.indexOf("breed");
    if (breedIndex >= 0 && tokens[breedIndex - 1]) {
      return `${baseName} (${titleCase(tokens[breedIndex - 1])} Breed)`;
    }
  }

  if (baseSlug === "basculin") {
    return `${baseName} (${tokens.map(titleCase).join("-")} Form)`;
  }

  if (regionPrefixes[first]) {
    const rest = tokens.slice(1).filter((token) => token !== "breed");
    const suffix = rest.map(titleCase).join(" ");
    return suffix
      ? `${regionPrefixes[first]} ${baseName} ${suffix}`
      : `${regionPrefixes[first]} ${baseName}`;
  }

  if (baseSlug === "rotom") {
    return `${titleCase(first)} ${baseName}`;
  }

  if (baseSlug === "oricorio") {
    const styleMap = {
      baile: "Baile",
      "pom-pom": "Pom-Pom",
      pau: "Pa'u",
      sensu: "Sensu",
    };
    const style = styleMap[tokens.join("-")] ?? tokens.map(titleCase).join(" ");
    return `${baseName} (${style} Style)`;
  }

  if (baseSlug === "deoxys") {
    const formeMap = { attack: "Attack", defense: "Defense", speed: "Speed" };
    return `${baseName} (${formeMap[first] ?? titleCase(first)} Forme)`;
  }

  if (first === "incarnate" || first === "therian") {
    return `${baseName} (${titleCase(first)} Forme)`;
  }

  if (baseSlug === "meowstic") {
    return `${baseName} (${titleCase(first)})`;
  }

  if (baseSlug === "gourgeist") {
    return `${baseName} (${titleCase(first)} Size)`;
  }

  if (baseSlug === "keldeo") {
    return `${baseName} (${titleCase(first)} Form)`;
  }

  if (baseSlug === "zygarde") {
    if (/^\d+$/.test(first)) {
      return `${baseName} (${first}% Forme)`;
    }
    return `${baseName} (${titleCase(first)} Forme)`;
  }

  if (first === "mega") {
    return `Mega ${baseName} ${tokens.slice(1).map(titleCase).join(" ")}`.trim();
  }

  if (first === "gmax") {
    return `Gigantamax ${baseName}`;
  }

  if (first === "primal") {
    return `Primal ${baseName}`;
  }

  if (first === "origin") {
    return `${baseName} (Origin Forme)`;
  }

  if (first === "unbound") {
    return `${baseName} (Unbound)`;
  }

  if (baseSlug === "shaymin" && first === "sky") {
    return `${baseName} (Sky Forme)`;
  }

  if (baseSlug === "wormadam") {
    const cloakMap = { plant: "Plant", sandy: "Sandy", trash: "Trash" };
    return `${baseName} (${cloakMap[first] ?? titleCase(first)} Cloak)`;
  }

  if (baseSlug === "aegislash") {
    return `${baseName} (${titleCase(first)} Forme)`;
  }

  // Default-form qualifiers reduce to the base species name.
  if (["incarnate", "ordinary", "land"].includes(first) || /^\d/.test(first)) {
    return baseName;
  }

  return `${baseName} ${tokens.map(titleCase).join(" ")}`;
}

async function buildOne(formId, baseByName) {
  const idMatch = String(formId);
  const pokemon = await fetchJson(
    `https://pokeapi.co/api/v2/pokemon/${idMatch}`,
  );

  const baseSlug = pokemon.species?.name ?? "";
  const baseInfo = baseByName.get(baseSlug) ?? null;

  const dexNumber = baseInfo?.dexNumber ?? pokemon.species?.url?.match(/(\d+)\/?$/)?.map(Number)[1] ?? 0;
  const baseName = baseInfo?.name ?? titleCase(baseSlug);
  const generation = baseInfo?.generation ?? "Unknown";

  const types = (pokemon.types ?? [])
    .map((slot) => slot.type?.name)
    .filter(Boolean);
  const bst = (pokemon.stats ?? []).reduce(
    (sum, stat) => sum + (stat.base_stat ?? 0),
    0,
  );

  const name =
    baseInfo?.name === baseName
      ? formatFormName(baseName, pokemon.name, baseSlug)
      : formatFormName(baseName, pokemon.name, baseSlug);

  return {
    slug: pokemon.name,
    baseSlug,
    spriteId: pokemon.id,
    dexNumber,
    name,
    types,
    bst,
    generation,
  };
}

async function main() {
  const baseData = JSON.parse(
    readBaseFile(),
  );
  const baseByName = new Map(baseData.map((entry) => [entry.slug, entry]));

  const list = await fetchJson(
    "https://pokeapi.co/api/v2/pokemon?limit=2000&offset=0",
  );
  const entries = list.results ?? [];
  const formIds = [];

  for (const entry of entries) {
    const idMatch = entry.url?.match(/pokemon\/(\d+)\/?$/);
    const id = idMatch ? Number(idMatch[1]) : NaN;
    if (!Number.isFinite(id) || id < 10001) {
      continue;
    }
    formIds.push(id);
  }

  console.log(`Found ${formIds.length} alternate forms; fetching details...`);

  const results = new Array(formIds.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < formIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const id = formIds[index];
      const entry = await buildOne(id, baseByName);
      if (!SKIP_SLUGS.has(entry.slug)) {
        results[index] = entry;
      }
      if (index % 50 === 0) {
        console.log(`${index}/${formIds.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const data = results
    .filter(Boolean)
    .sort((a, b) => a.dexNumber - b.dexNumber || a.spriteId - b.spriteId);

  const outputPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "data",
    "pokemon-forms.json",
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");

  console.log(`Wrote ${data.length} forms to ${outputPath}`);
}

function readBaseFile() {
  return BunFile();
}
import { readFileSync } from "node:fs";
function BunFile() {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "pokemon.json"),
    "utf8",
  );
}

main().catch((error) => {
  console.error("Generation failed:", error);
  process.exit(1);
});