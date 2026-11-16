/*
 * Colour classes for Pokemon type badges.
 *
 * The draft, trades, pool, teams and free-agent views all render the same 18
 * types, and each of them used to carry its own copy of this palette. Keeping it
 * here means a colour change lands everywhere at once instead of drifting page by
 * page.
 */

/** Tailwind background/text classes keyed by lowercase PokeAPI type name. */
export const TYPE_STYLES: Record<string, string> = {
  normal: "bg-slate-600 text-slate-100",
  fire: "bg-red-600 text-slate-50",
  water: "bg-blue-600 text-slate-50",
  electric: "bg-yellow-500 text-slate-900",
  grass: "bg-green-600 text-slate-50",
  ice: "bg-cyan-500 text-slate-900",
  fighting: "bg-orange-700 text-slate-50",
  poison: "bg-purple-600 text-slate-50",
  ground: "bg-amber-700 text-slate-50",
  flying: "bg-sky-500 text-slate-50",
  psychic: "bg-pink-600 text-slate-50",
  bug: "bg-lime-600 text-slate-50",
  rock: "bg-stone-600 text-slate-50",
  ghost: "bg-indigo-700 text-slate-50",
  dragon: "bg-violet-700 text-slate-50",
  dark: "bg-neutral-800 text-slate-100",
  steel: "bg-slate-500 text-slate-50",
  fairy: "bg-pink-400 text-slate-900",
};

/** Classes used for a type the palette does not know, e.g. a new generation. */
const UNKNOWN_TYPE_STYLE = "bg-slate-700 text-slate-200";

/**
 * Resolves the badge classes for a type name.
 *
 * @param type - PokeAPI type name in any casing.
 * @param fallback - Classes to use when the type is not in the palette.
 * @returns The matching Tailwind class string.
 */
export function typeStyle(
  type: string,
  fallback: string = UNKNOWN_TYPE_STYLE,
): string {
  return TYPE_STYLES[type.toLowerCase()] ?? fallback;
}
