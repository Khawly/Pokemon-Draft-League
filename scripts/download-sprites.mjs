/*
 * Downloads every national-dex and alternate-form sprite into public/sprites/.
 *
 * Fetches the standard front sprites from the PokeAPI GitHub mirror so the app
 * can serve them locally with no external dependency. Sprite ids are the
 * species' dex numbers (from src/data/pokemon.json) plus the alternate-form ids
 * (from src/data/pokemon-forms.json). Already-downloaded sprites are skipped so
 * the script can be re-run safely.
 *
 * Run: node scripts/download-sprites.mjs
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SPRITE_BASE_URL =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";

const spriteIds = new Set(
  JSON.parse(
    readFileSync(join(process.cwd(), "src", "data", "pokemon.json"), "utf8"),
  ).map((entry) => Number(entry.dexNumber)),
);
// Alternate forms whose sprite provenance is their base species' dex number,
// used as a fallback when the PokeAPI repo ships no flat sprite for the id.
const FORM_BASE_DEX = new Map();
for (const entry of JSON.parse(
  readFileSync(join(process.cwd(), "src", "data", "pokemon-forms.json"), "utf8"),
)) {
  spriteIds.add(Number(entry.spriteId));
  FORM_BASE_DEX.set(Number(entry.spriteId), Number(entry.dexNumber));
}

const OUT_DIR = join(process.cwd(), "public", "sprites");
mkdirSync(OUT_DIR, { recursive: true });

const CONCURRENCY = 16;
const MAX_RETRIES = 4;

async function downloadOne(dexNumber) {
  const fileName = `${dexNumber}.png`;
  const filePath = join(OUT_DIR, fileName);

  if (existsSync(filePath) && statSync(filePath).size > 0) {
    return { dexNumber, status: "skipped" };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${SPRITE_BASE_URL}/${fileName}`, {
        headers: { "User-Agent": "pokemon-draft-league-sprite-download" },
      });

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        return { dexNumber, status: "missing" };
      }

      writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
      return { dexNumber, status: "downloaded" };
    } catch {
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(4000, 300 * Math.pow(2, attempt));
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return { dexNumber, status: "failed" };
    }
  }

  return { dexNumber, status: "failed" };
}

async function main() {
  const ids = [...spriteIds].sort((a, b) => a - b);
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < ids.length) {
      const index = nextIndex;
      nextIndex += 1;
      const id = ids[index];
      results.push(await downloadOne(id));
      if (index % 100 === 0 || index === ids.length - 1) {
        console.log(`${index + 1}/${ids.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const downloaded = results.filter((r) => r.status === "downloaded").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const missing = results.filter((r) => r.status === "missing");
  const failed = results.filter((r) => r.status === "failed");

  // Forms without a flat sprite fall back to their base species' sprite so the
  // app never serves a broken image for a resolvable entry.
  const copied = [];
  for (const result of missing) {
    const baseDex = FORM_BASE_DEX.get(result.dexNumber);
    if (baseDex) {
      const basePath = join(OUT_DIR, `${baseDex}.png`);
      if (existsSync(basePath) && statSync(basePath).size > 0) {
        writeFileSync(join(OUT_DIR, `${result.dexNumber}.png`),
          readFileSync(basePath));
        copied.push(result.dexNumber);
      }
    }
  }
  const stillMissing = missing.filter((r) => !copied.includes(r.dexNumber));

  console.log(
    `Downloaded ${downloaded}, skipped ${skipped}, copied ${copied.length} form fallbacks.`,
  );
  if (stillMissing.length) {
    console.log(`Missing: ${stillMissing.map((r) => r.dexNumber).join(", ")}`);
  }
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.dexNumber).join(", ")}`);
    process.exitCode = 1;
  }
}

main();