/*
 * Tests for the Pokemon sprite avatar picker.
 *
 * These cover the two ways a search is expected to work - typed names and exact
 * dex numbers - plus the path check that keeps clearing a sprite avatar from
 * reaching into the upload bucket.
 */
import { describe, expect, it } from "vitest";

import {
  isPokemonSpriteAvatarUrl,
  MAX_POKEMON_AVATAR_RESULTS,
  searchPokemonAvatars,
} from "@/lib/pokemon-avatars";

describe("searchPokemonAvatars", () => {
  it("matches a partial species name", () => {
    const [first] = searchPokemonAvatars("pika");
    expect(first?.name).toBe("Pikachu");
    expect(first?.url).toBe("/sprites/25.png");
  });

  it("ignores accents and punctuation in the member's query", () => {
    expect(searchPokemonAvatars("flabebe")[0]?.name).toBe("Flabébé");
    expect(searchPokemonAvatars("farfetchd")[0]?.name).toBe("Farfetch’d");
  });

  it("matches an alternate form by its display name", () => {
    expect(searchPokemonAvatars("mega venusaur")[0]?.url).toBe(
      "/sprites/10033.png",
    );
    expect(searchPokemonAvatars("alolan raichu")[0]?.name).toBe("Alolan Raichu");
  });

  it("matches an exact dex number", () => {
    const [first] = searchPokemonAvatars("25");
    expect(first?.name).toBe("Pikachu");
    expect(first?.dexNumber).toBe(25);
  });

  it("offers a browsable dex-ordered start when the query is empty", () => {
    const first = searchPokemonAvatars("");
    expect(first[0]?.dexNumber).toBe(1);
    expect(first[0]?.name).toBe("Bulbasaur");
  });

  it("caps the number of results it returns", () => {
    expect(searchPokemonAvatars("", 5)).toHaveLength(5);
    expect(searchPokemonAvatars("", MAX_POKEMON_AVATAR_RESULTS)).toHaveLength(
      MAX_POKEMON_AVATAR_RESULTS,
    );
  });

  it("returns nothing when no sprite matches", () => {
    expect(searchPokemonAvatars("missingno-not-here")).toEqual([]);
  });
});

describe("isPokemonSpriteAvatarUrl", () => {
  it("recognises a bundled sprite path", () => {
    expect(isPokemonSpriteAvatarUrl("/sprites/25.png")).toBe(true);
    expect(isPokemonSpriteAvatarUrl("/sprites/10033.png")).toBe(true);
  });

  it("leaves uploaded and empty avatars alone", () => {
    expect(
      isPokemonSpriteAvatarUrl(
        "https://example.supabase.co/storage/v1/object/public/avatars/u/a.webp",
      ),
    ).toBe(false);
    expect(isPokemonSpriteAvatarUrl(null)).toBe(false);
    expect(isPokemonSpriteAvatarUrl(undefined)).toBe(false);
    expect(isPokemonSpriteAvatarUrl("/sprites/not-a-number.png")).toBe(false);
  });
});
