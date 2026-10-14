/*
 * The palette of colours a member can pick for their display name.
 *
 * A closed set of Tailwind classes rather than a free hex string, for three
 * reasons: Tailwind only emits classes it can see written out statically, so a
 * colour assembled at runtime from user input would not survive a build; an
 * arbitrary hex has no guaranteed contrast against the slate-950 background, and
 * a member could make their own name unreadable; and a stored token means changing
 * a colour's shade later is a data migration rather than a repaint of every page.
 *
 * The app's surfaces are all very dark, so the names sit on the 400 tier: bright and
 * saturated enough that a swatch looks like the colour it is named for, while still
 * measuring 10.9:1 or better against the page background.
 *
 * Two hues drop to 300 to stay clear of a neighbouring swatch. See the note on
 * {@link NAME_COLOR_CLASSES} for the measurements.
 *
 * The hues run in spectrum order so neighbouring swatches are neighbours by hue,
 * which makes the row easier to scan than an arbitrary list.
 */

/** One selectable name colour. */
export interface NameColorOption {
  /** Stable id stored on the profile. Changing one would repaint saved profiles. */
  id: NameColorId;
  /** Human-readable name for the swatch's accessible label. */
  label: string;
  /** Tailwind text colour applied to the name. */
  className: string;
  /**
   * Tailwind background colour for the swatch button in the settings picker, so a
   * member sees the actual fill they are choosing rather than having to infer it
   * from a border. Held separately from `className` because a `text-*` class does
   * not paint a background.
   */
  swatchClassName: string;
}

/** Every colour a member can choose, in swatch order. */
export const NAME_COLOR_IDS = [
  "default",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "black",
] as const;

/** The id of a name colour, or `"default"` for the app's own text colour. */
export type NameColorId = (typeof NAME_COLOR_IDS)[number];

/** The colour ids as a Set, for membership checks. */
const NAME_COLOR_ID_SET: ReadonlySet<string> = new Set(NAME_COLOR_IDS);

/**
 * Text classes for each colour.
 *
 * Every hue sits on the 400 tier rather than a single lighter one. The earlier
 * palette used 300 throughout, which read correctly on this background but was the
 * mistake: at 300 Tailwind is heavily desaturated, so "Red" rendered as `#ffa3a3`,
 * a pale pink that did not look like red. 400 roughly doubles the chroma and every
 * swatch then looks like the colour it is named for, while still measuring between
 * 10.9:1 and 17.1:1 against the page background.
 *
 * Two hues are exceptions, both to keep neighbouring swatches distinguishable.
 * Measured in OKLab, the closest pair in the whole palette must clear roughly 0.10:
 *
 *   yellow-300 is 0.055 from amber-400, so yellow drops to 300 and separates by 0.195.
 *   rose-300 is 0.044 from red-300 and rose-400 is still only 0.091 from red-400, so
 *   rose drops to 300, which clears 0.103.
 *
 * With those two in place the closest pair in the entire palette is cyan against sky
 * at 0.103, and nothing falls below 10.9:1.
 */
const NAME_COLOR_CLASSES: Record<NameColorId, string> = {
  default: "",
  red: "text-red-400",
  orange: "text-orange-400",
  amber: "text-amber-400",
  yellow: "text-yellow-300",
  lime: "text-lime-400",
  green: "text-green-400",
  emerald: "text-emerald-400",
  teal: "text-teal-400",
  cyan: "text-cyan-400",
  sky: "text-sky-400",
  blue: "text-blue-400",
  indigo: "text-indigo-400",
  violet: "text-violet-400",
  purple: "text-purple-400",
  fuchsia: "text-fuchsia-400",
  pink: "text-pink-400",
  rose: "text-rose-300",
  /*
   * The one entry that is not a 400 tier, and not by accident. Every surface in this
   * app is slate-950 or darker, so a pure black name is very close to the background
   * and is hard to read. It is offered because it was asked for, and a member may
   * want it for a specific page; `black` is stored and rendered literally rather than
   * quietly remapped to a near-black, because a "black" that renders as grey would
   * be more confusing than one that is simply dark.
   */
  black: "text-black",
};

/*
 * Background classes for the picker swatches, mirroring NAME_COLOR_CLASSES.
 *
 * Written out in full rather than derived by swapping the `text-` prefix for `bg-`:
 * Tailwind only emits classes it can find written out literally, so a class built at
 * runtime from a stored id would compile to nothing and every swatch would render
 * empty. The two tables are kept adjacent so they stay in step.
 *
 * `"default"` gets a near-white fill because it means "inherit the surrounding text
 * colour", which on these surfaces is a pale grey. Empty would have been a hole.
 *
 * Tailwind's `slate` is deliberately absent: the 300 shade is so close to the app's
 * own text colour that a member could not tell it apart from `default`, and a swatch
 * that looks identical to another while meaning something different is worse than
 * not offering it.
 */
const NAME_COLOR_SWATCH_CLASSES: Record<NameColorId, string> = {
  default: "bg-slate-100",
  red: "bg-red-400",
  orange: "bg-orange-400",
  amber: "bg-amber-400",
  yellow: "bg-yellow-300",
  lime: "bg-lime-400",
  green: "bg-green-400",
  emerald: "bg-emerald-400",
  teal: "bg-teal-400",
  cyan: "bg-cyan-400",
  sky: "bg-sky-400",
  blue: "bg-blue-400",
  indigo: "bg-indigo-400",
  violet: "bg-violet-400",
  purple: "bg-purple-400",
  fuchsia: "bg-fuchsia-400",
  pink: "bg-pink-400",
  rose: "bg-rose-300",
  black: "bg-black",
};

/** Readable labels for each colour, used as the swatch buttons' titles. */
const NAME_COLOR_LABELS: Record<NameColorId, string> = {
  default: "Default",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  yellow: "Yellow",
  lime: "Lime",
  green: "Green",
  emerald: "Emerald",
  teal: "Teal",
  cyan: "Cyan",
  sky: "Sky",
  blue: "Blue",
  indigo: "Indigo",
  violet: "Violet",
  purple: "Purple",
  fuchsia: "Fuchsia",
  pink: "Pink",
  rose: "Rose",
  black: "Black",
};

/**
 * Every colour as a swatch, in the order the picker renders them.
 *
 * Carries both the text class a name renders in and the background class the swatch
 * is filled with, so the picker and every name that uses the colour read from one
 * source and cannot drift apart.
 */
export const NAME_COLOR_OPTIONS: readonly NameColorOption[] = NAME_COLOR_IDS.map(
  (id) => ({
    id,
    label: NAME_COLOR_LABELS[id],
    className: NAME_COLOR_CLASSES[id],
    swatchClassName: NAME_COLOR_SWATCH_CLASSES[id],
  }),
);

/**
 * Coerces stored or submitted input into a colour id this app understands.
 *
 * Anything unrecognised becomes `"default"` rather than throwing, because the value
 * arrives from a database column that predates the palette and may be edited by
 * hand. A member with an unknown colour stored sees their normal text colour
 * instead of losing the page.
 *
 * @param value - The raw stored or submitted colour.
 * @returns A valid {@link NameColorId}.
 */
export function normalizeNameColor(value: string | null | undefined): NameColorId {
  if (typeof value !== "string") {
    return "default";
  }

  const trimmed = value.trim().toLowerCase();

  return NAME_COLOR_ID_SET.has(trimmed) ? (trimmed as NameColorId) : "default";
}

/**
 * The Tailwind class a stored colour resolves to.
 *
 * Returns an empty string for `"default"`, and for a colour this palette does not
 * know, so the name simply inherits the colour of whatever it sits in.
 *
 * @param value - The raw stored or submitted colour.
 * @returns A text colour class, or an empty string to inherit.
 */
export function nameColorClass(value: string | null | undefined): string {
  return NAME_COLOR_CLASSES[normalizeNameColor(value)];
}

/*
 * Tinted background for a member's initials avatar.
 *
 * A flat `bg-slate-800` circle with coloured letters read as washed out next to a
 * name rendered in full colour, so a member who has chosen a colour gets a circle
 * tinted in the same hue with the letters at full strength. The 20% alpha keeps it a
 * backdrop rather than a block of colour.
 *
 * Written out literally for the same reason the swatch table is: Tailwind only emits
 * classes it can find written out, so these cannot be assembled at runtime.
 * `"default"` is empty because it means "no colour chosen", which falls back to the
 * plain slate circle an avatar has always used.
 */
const NAME_COLOR_AVATAR_CLASSES: Record<NameColorId, string> = {
  default: "",
  red: "bg-red-500/20",
  orange: "bg-orange-500/20",
  amber: "bg-amber-500/20",
  yellow: "bg-yellow-500/20",
  lime: "bg-lime-500/20",
  green: "bg-green-500/20",
  emerald: "bg-emerald-500/20",
  teal: "bg-teal-500/20",
  cyan: "bg-cyan-500/20",
  sky: "bg-sky-500/20",
  blue: "bg-blue-500/20",
  indigo: "bg-indigo-500/20",
  violet: "bg-violet-500/20",
  purple: "bg-purple-500/20",
  fuchsia: "bg-fuchsia-500/20",
  pink: "bg-pink-500/20",
  rose: "bg-rose-500/20",
  black: "bg-black/20",
};

/**
 * The background class for a member's initials avatar in their chosen colour.
 *
 * @param value - The raw stored or submitted colour.
 * @returns A background class, or an empty string for the default slate circle.
 */
export function nameColorAvatarClass(
  value: string | null | undefined,
): string {
  return NAME_COLOR_AVATAR_CLASSES[normalizeNameColor(value)];
}

/*
 * A Tailwind text-colour utility sitting in a caller's `className`.
 *
 * These are what silently defeat the chosen colour. Every utility in this group has
 * the same specificity as `nameColorClass`, so the winner is whichever appears LATER
 * in the compiled stylesheet, not whichever appears later in the class attribute --
 * and Tailwind emits them in palette order, which is unrelated to the order the app
 * happens to use. In this project's CSS `text-slate-100` lands at byte 45961 and
 * `text-amber-300` at 44537, so a name rendered with `text-slate-100` alongside an
 * amber choice stays slate no matter what the member picked.
 *
 * Deliberately narrow: it matches palette colours (`text-slate-100`), the named
 * colours (`text-white`), their opacity modifiers, and arbitrary colour values. It
 * must NOT match typography utilities, so sizes (`text-sm`, `text-lg`, `text-2xl`),
 * alignment (`text-center`) and transforms (`text-balance`) are excluded. The shade
 * has to be two or three digits, which is what separates `text-slate-100` from
 * `text-xs`, and the arbitrary branch has to name a colour function so that
 * `text-[14px]` survives.
 */
const COMPETING_TEXT_COLOR =
  /^text-(?:[a-z]+-\d{2,3}(?:\/\d+)?|(?:white|black|transparent|current|inherit)(?:\/\d+)?|\[(?:#|rgb|hsl)[^\]]*\])$/;

/**
 * Merges a caller's existing classes with the member's chosen name colour.
 *
 * Drops any competing text colour from `className` when a colour is actually chosen,
 * for the stylesheet-ordering reason documented on {@link COMPETING_TEXT_COLOR}. When
 * the member has no colour the caller's classes are returned untouched, so a page
 * that never adopts this feature renders exactly as it did before.
 *
 * @param className - The classes the name would otherwise have carried.
 * @param color - The member's stored colour, raw.
 * @returns The class string to apply, with the chosen colour winning.
 */
export function mergeNameColorClasses(
  className: string | undefined,
  color: string | null | undefined,
): string | undefined {
  const colorClass = nameColorClass(color);

  if (!colorClass) {
    return className;
  }

  const kept = (className ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !COMPETING_TEXT_COLOR.test(token));

  return [...kept, colorClass].join(" ") || undefined;
}