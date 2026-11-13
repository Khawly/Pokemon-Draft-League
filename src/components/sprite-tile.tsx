/*
 * A Pokemon sprite in a neutral rounded tile, used by the Hall of Fame.
 *
 * Champion rosters render larger than the roster strips, so the sprite needs a
 * consistent frame at that size. The tile also supports a fluid mode: the hall
 * uses it to keep a full roster on one row by giving every tile an equal share
 * of the width and shrinking them together. The tile is intentionally plain
 * slate rather than a Pokeball, matching the rest of the app's sprites after the
 * Pokeball backdrops were removed.
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
  /**
   * Whether the tile should fill its parent's width and scale with it.
   *
   * Used where a roster has to stay on one row: the caller gives each tile an
   * equal share of the row, so the whole row shrinks together instead of
   * wrapping. `size` remains the reference size for the artwork.
   */
  fluid?: boolean;
}

/**
 * Draws a Pokemon sprite inside a neutral rounded tile.
 *
 * @param props - {@link SpriteTileProps}
 * @returns The tile with the sprite centred inside it.
 */
export function SpriteTile({
  spriteId,
  name,
  size = 64,
  fluid = false,
}: SpriteTileProps) {
  const tile = Math.round(size * (88 / 64));

  /*
   * The artwork sits inside a tile 1.375x its size. A fluid tile has to keep
   * that same inset instead of letting the sprite touch the border, so the
   * image fills 64/88 of the frame.
   */
  const spriteStyle = fluid
    ? { width: "72.727%", height: "72.727%" }
    : { width: size, height: size };

  return (
    <span
      className={[
        "relative flex items-center justify-center overflow-hidden rounded-full bg-slate-900/60 shadow-md shadow-slate-950/50",
        fluid
          ? "aspect-square w-full border border-slate-900"
          : "border-2 border-slate-900",
      ].join(" ")}
      style={fluid ? undefined : { width: tile, height: tile }}
    >
      {spriteId > 0 ? (
        <img
          src={getSpriteUrl(spriteId)}
          alt={name}
          title={name}
          width={size}
          height={size}
          loading="lazy"
          className="relative object-contain [image-rendering:pixelated]"
          style={spriteStyle}
        />
      ) : (
        <span
          className="relative flex items-center justify-center rounded-full bg-slate-700 text-slate-400"
          style={{
            ...spriteStyle,
            fontSize: fluid ? 14 : Math.max(12, size / 4),
          }}
        >
          ?
        </span>
      )}
    </span>
  );
}
