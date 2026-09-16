/*
 * Verifies that every row of a draft-pool CSV resolves to a species or distinct
 * alternate form using the same matching rules as matchPokemonName.
 *
 * Distinct forms (regionals, Rotom appliances, Deoxys formes, etc.) resolve to
 * their own entry with the base species' dex number; "(No Mega)"-style names
 * collapse to the base species via the variant fallback.
 *
 * Usage: node scripts/verify-csv-import.mjs [path/to/pool.csv]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const csvPath = process.argv[2] ?? "pokemon_draft_pool_s3.csv";

const POKEMON_DATA = JSON.parse(
  readFileSync(join(process.cwd(), "src", "data", "pokemon.json"), "utf8"),
);

const FORMS_DATA = JSON.parse(
  readFileSync(join(process.cwd(), "src", "data", "pokemon-forms.json"), "utf8"),
);

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

function normalizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function variantKey(value) {
  const cleaned = value.replace(/\([^)]*\)/g, " ");
  const tokens = cleaned
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens
    .filter((token) => !VARIANT_STOP_WORDS.has(token) && !/^\d+$/.test(token))
    .join("");
}

function formatSpeciesName(slug) {
  return slug
    .split("-")
    .map((segment) =>
      segment ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment,
    )
    .join(" ");
}

function findSpeciesByKey(key) {
  return POKEMON_DATA.find((entry) => {
    const speciesKeys = [
      normalizeName(entry.slug),
      normalizeName(entry.name),
      normalizeName(formatSpeciesName(entry.slug)),
    ];
    return speciesKeys.includes(key);
  });
}

function findFormByKey(key) {
  return FORMS_DATA.find((entry) => {
    const formKeys = [normalizeName(entry.slug), normalizeName(entry.name)];
    return formKeys.includes(key);
  });
}

function resolve(name) {
  const directKey = normalizeName(name);
  const baseKey = variantKey(name);
  if (!directKey && !baseKey) {
    return null;
  }

  const speciesDirect = directKey ? findSpeciesByKey(directKey) : undefined;
  if (speciesDirect) {
    return { slug: speciesDirect.slug, dexNumber: speciesDirect.dexNumber, kind: "species" };
  }

  const formDirect = directKey ? findFormByKey(directKey) : undefined;
  if (formDirect) {
    return { slug: formDirect.slug, dexNumber: formDirect.dexNumber, kind: "form" };
  }

  const speciesBase = baseKey ? findSpeciesByKey(baseKey) : undefined;
  if (speciesBase) {
    return { slug: speciesBase.slug, dexNumber: speciesBase.dexNumber, kind: "collapsed" };
  }

  return null;
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

const lines = readFileSync(csvPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const skipped = [];
const resolved = [];

for (const line of lines) {
  const cells = parseCsvLine(line);
  const name = cells[0] ?? "";
  const match = resolve(name);
  if (match) {
    resolved.push({ name, ...match });
  } else {
    skipped.push(name);
  }
}

console.log(`Total rows:   ${lines.length}`);
console.log(`Resolved:     ${resolved.length}`);
console.log(`Skipped:      ${skipped.length}`);
if (skipped.length) {
  console.log("\nUnresolved names:");
  for (const name of skipped) {
    console.log(`  - ${name}`);
  }
}

const formMapped = resolved.filter(({ kind }) => kind === "form");
if (formMapped.length) {
  console.log(`\nDistinct alternate forms (${formMapped.length}):`);
  for (const { name, slug, dexNumber } of formMapped) {
    console.log(`  - ${name} -> ${slug} (#${dexNumber})`);
  }
}

const collapsed = resolved.filter(({ kind }) => kind === "collapsed");
if (collapsed.length) {
  console.log(`\nCollapsed to base species (${collapsed.length}):`);
  for (const { name, slug } of collapsed) {
    console.log(`  - ${name} -> ${slug}`);
  }
}