/*
 * A single Pokemon sprite with a placeholder for unknown ids.
 *
 * The draft, trades, pool, teams and free-agent views all show rosters as small
 * sprites. Four of those pages carried an identical copy of this component; it
 * lives here so the placeholder and sizing rules stay the same everywhere.
 */
"use client";

import { getSpriteUrl } from "@/lib/pokeapi";

/** Props for the {@link PokemonSprite} component. */
export interface PokemonSpriteProps {
  /** Sprite id used to build the sprite URL; zero or less draws the placeholder. */
  spriteId: number;
  /** Alt text for the image. */
  name: string;
  /** Square pixel dimensions. Defaults to 32. */
  size?: number;
}

/**
 * Renders a species sprite, or a neutral placeholder when the id is unknown.
 *
 * @param props - {@link PokemonSpriteProps}
 * @returns The image or placeholder element.
 */
export function PokemonSprite({
  spriteId,
  name,
  size = 32,
}: PokemonSpriteProps) {
  if (spriteId <= 0) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs text-slate-500"
      >
        ?
      </div>
    );
  }

  return (
    <img
      src={getSpriteUrl(spriteId)}
      alt={name}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size }}
      className="shrink-0 object-contain"
    />
  );
}
