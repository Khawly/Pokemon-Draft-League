/*
 * A Pokemon sprite in a neutral rounded tile, used by the Hall of Fame.
 *
 * Champion rosters render larger than the roster strips, so the sprite needs a
 * consistent frame at that size. The tile is intentionally plain slate rather
 * than a Pokeball, matching the rest of the app's sprites after the Pokeball
 * backdrops were removed.
 */
"use client";

import { getSpriteUrl } from "@/lib/pokeapi";

/** Props for the {@link SpriteTile} component. */
export interface SpriteTileProps {
  /** The sprite id to render; zero or less draws the placeholder. */
  spriteId: number;
  /** The Pokemon's name, used as the alt text. */
  name: string;
  /** Height of the sprite in pixels. The tile scales around it. */
  size?: number;
}

/**
 * Draws a Pokemon sprite inside a neutral rounded tile.
 *
 * @param props - {@link SpriteTileProps}
 * @returns The tile with the sprite centred inside it.
 */
export function SpriteTile({ spriteId, name, size = 64 }: SpriteTileProps) {
  const tile = Math.round(size * (88 / 64));

  return (
    <span
      className="relative flex items-center justify-center overflow-hidden rounded-full border-2 border-slate-900 bg-slate-900/60 shadow-md shadow-slate-950/50"
      style={{ width: tile, height: tile }}
    >
      {spriteId > 0 ? (
        <img
          src={getSpriteUrl(spriteId)}
          alt={name}
          width={size}
          height={size}
          loading="lazy"
          className="relative object-contain [image-rendering:pixelated]"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="relative flex items-center justify-center rounded-full bg-slate-700 text-slate-400"
          style={{ width: size, height: size, fontSize: Math.max(12, size / 4) }}
        >
          ?
        </span>
      )}
    </span>
  );
}
