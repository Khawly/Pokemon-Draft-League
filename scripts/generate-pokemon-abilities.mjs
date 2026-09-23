/*
 * Generates src/data/pokemon-abilities.json from Serebii.net's AbilityDex.
 *
 * Collects every distinct ability name used in src/data/pokemon-details.json,
 * resolves each against the AbilityDex index (matching by a punctuation-free
 * lowercase key so PokeAPI slugs like "compound-eyes" resolve to Serebii's
 * "compoundeyes.shtml"), and stores each page's "In-Depth Effect:" text so the
 * app's ability tooltips explain the full mechanics rather than the short
 * in-game blurb. Serebii does not yet publish an In-Depth Effect for every
 * ability, so those pages keep their "Game's Text:" description as the
 * fallback so every description still originates from Serebii. Abilities the
 * index cannot resolve at all keep their PokeAPI short effect.
 *
 * Run: node scripts/generate-pokemon-abilities.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONCURRENCY = 6;
const MAX_RETRIES = 4;

const ABILITYDEX_INDEX_URL = "https://www.serebii.net/abilitydex/";

/** PokeAPI slugs whose Serebii page names don't normalize from the slug alone. */
const SEREBII_ALIASES = {
  "as-one-glastrier": "asone-unnervechillingneigh",
  "as-one-spectrier": "asone-unnervegrimneigh",
};

/** Named HTML entities common in Serebii's effect text. */
const HTML_ENTITIES = {
  amp: "&",
  apos: "'",
  ccedil: "ç",
  deg: "°",
  eacute: "é",
  egrave: "è",
  ge: "≥",
  gt: ">",
  le: "≤",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  oacute: "ó",
  quot: '"',
  times: "×",
  uacute: "ú",
};

/**
 * Normalizes an ability name for cross-site comparison by dropping everything
 * that is not a lower-case letter or digit.
 *
 * @param value - The name to normalize ("Compound Eyes", "compound-eyes").
 * @returns The punctuation-free lowercase key.
 */
function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Decodes the named and numeric HTML entities in a string.
 *
 * @param value - Raw text scraped from a Serebii page.
 * @returns The text with entities resolved to plain characters.
 */
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCharCode(parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/&([a-z]+);/g, (match, name) => HTML_ENTITIES[name] ?? match);
}

async function fetchText(url, attempt = 0) {
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
    const buffer = await response.arrayBuffer();
    return new TextDecoder("iso-8859-1").decode(buffer);
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      const delay = Math.min(4000, 300 * Math.pow(2, attempt));
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchText(url, attempt + 1);
    }
    throw error;
  }
}

/**
 * Extracts the first "fooinfo" detail paragraph following a named section row
 * on an AbilityDex page, or null when the section does not exist.
 *
 * @param html - The raw AbilityDex page HTML.
 * @param label - The section label to locate, e.g. "In-Depth Effect".
 * @returns The cleaned section text, or null.
 */
function extractSection(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `${escaped}:</td>\\s*</tr>\\s*<tr>\\s*<td class="fooinfo"[^>]*>([\\s\\S]*?)</td>`,
      "i",
    ),
  );
  if (!match) {
    return null;
  }
  return decodeEntities(match[1])
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
  const details = JSON.parse(
    readFileSync(join(baseDir, "pokemon-details.json"), "utf8"),
  );
  const pokeapiFallback = JSON.parse(
    readFileSync(join(baseDir, "pokemon-abilities.json"), "utf8"),
  );
  const fallbackBySlug = new Map(
    pokeapiFallback.map((entry) => [entry.slug, entry.description]),
  );

  const slugs = [...new Set(
    details.flatMap((entry) => (entry.abilities ?? []).map((a) => a.name)),
  )].sort();

  // Resolve every AbilityDex page URL ahead of time so the fetches below can
  // run against a known-good map.
  const indexHtml = await fetchText(ABILITYDEX_INDEX_URL);
  const urlByKey = new Map();
  for (const match of indexHtml.matchAll(
    /<option value="(\/abilitydex\/[^"]+\.shtml)">([^<]+)<\/option>/g,
  )) {
    urlByKey.set(normalizeKey(match[2]), `https://www.serebii.net${match[1]}`);
  }

  // Candidate Serebii keys for each PokeAPI slug, resolved from the slug plus
  // any manual alias for pages whose names don't match the slug form.
  const urlForSlug = new Map();
  for (const slug of slugs) {
    const candidates = SEREBII_ALIASES[slug]
      ? [normalizeKey(SEREBII_ALIASES[slug])]
      : [normalizeKey(slug)];
    const url = candidates.map((key) => urlByKey.get(key)).find(Boolean);
    urlForSlug.set(slug, url);
  }

  const unresolved = slugs.filter((slug) => !urlForSlug.get(slug));
  if (unresolved.length > 0) {
    console.warn(`Unresolved on Serebii (falling back to PokeAPI): ${unresolved.join(", ")}`);
  }

  console.log(`Fetching ability pages for ${slugs.length - unresolved.length} abilities...`);

  const results = new Array(slugs.length);
  let nextIndex = 0;
  let inDepthCount = 0;
  let gameTextCount = 0;

  async function worker() {
    while (nextIndex < slugs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const slug = slugs[index];
      const url = urlForSlug.get(slug);
      const fallback = fallbackBySlug.get(slug) ?? null;
      if (!url) {
        results[index] = { slug, description: fallback };
        continue;
      }
      try {
        const html = await fetchText(url);
        const depth = extractSection(html, "In-Depth Effect");
        if (depth) {
          inDepthCount += 1;
          results[index] = { slug, description: depth };
          continue;
        }
        const gameText = extractSection(html, "Game's Text");
        if (gameText) {
          gameTextCount += 1;
          results[index] = { slug, description: gameText };
          continue;
        }
        results[index] = { slug, description: fallback };
      } catch {
        results[index] = { slug, description: fallback };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const output = results.sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(
    join(baseDir, "pokemon-abilities.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(
    `Wrote pokemon-abilities.json (${results.length} abilities; ${inDepthCount} in-depth, ${gameTextCount} game text).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});