/*
 * A Pokemon sprite inside a Pokeball, the same way the roster strips draw one.
 *
 * The ball is CSS rather than an image: a red-over-white circle with a dark band and a
 * centre button, with the sprite layered on top. Pulled out here because the Hall of Fame
 * shows the same thing much larger than a roster strip does, and the two should not drift
 * into slightly different balls.
 */
"use client";

import { getSpriteUrl } from "@/lib/pokeapi";

/** Props for the {@link PokeballSprite} component. */
export interface PokeballSpriteProps {
  /** The sprite id to render; zero or less draws the placeholder. */
  spriteId: number;
  /** The Pokemon's name, used as the alt text. */
  name: string;
  /**
   * Height of the sprite in pixels. The ball scales around it, keeping the same proportion
   * the roster strips use at their size.
   */
  size?: number;
}

/**
 * Draws a Pokemon inside a Pokeball.
 *
 * @param props - {@link PokeballSpriteProps}
 * @returns The ball with the sprite on top.
 */
export function PokeballSprite({
  spriteId,
  name,
  size = 64,
}: PokeballSpriteProps) {
  // The roster strips draw a 64px sprite in an 88px ball; the rest follows from that.
  const ball = Math.round(size * (88 / 64));

  return (
    <span
      className="relative flex items-center justify-center overflow-hidden rounded-full border-2 border-slate-900 bg-[linear-gradient(to_bottom,#dc2626_0_45%,#0f172a_45%_55%,#f8fafc_55%)] shadow-md shadow-slate-950/50"
      style={{ width: ball, height: ball }}
    >
      {/* Pokeball centre button, drawn beneath the sprite. */}
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 bg-white"
        style={{ width: ball / 5, height: ball / 5 }}
      />
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