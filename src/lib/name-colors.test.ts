/*
 * Tests for the display-name colour palette.
 *
 * The normalizer is the only thing standing between a hand-edited database row and
 * the class that gets applied to somebody's name, so the cases that matter are the
 * ones where the stored value is not exactly one of ours: an unknown colour, an
 * empty string, or nothing at all. Each has to resolve to the default rather than
 * leaking a class that does not exist or rendering a name with no colour classes.
 */
import { describe, expect, it } from "vitest";
import {
  mergeNameColorClasses,
  nameColorAvatarClass,
  nameColorClass,
  normalizeNameColor,
  NAME_COLOR_IDS,
  NAME_COLOR_OPTIONS,
} from "@/lib/name-colors";

describe("normalizeNameColor", () => {
  it("keeps every colour the picker offers", () => {
    for (const id of NAME_COLOR_IDS) {
      expect(normalizeNameColor(id)).toBe(id);
    }
  });

  it("falls back to the default colour for an unknown value", () => {
    // A value this palette does not know must not reach the class lookup, or a
    // member with a stale row would get an unstyled name instead of the default.
    expect(normalizeNameColor("chartreuse")).toBe("default");
    expect(normalizeNameColor("amber-500")).toBe("default");
  });

  it("treats nothing chosen as the default colour", () => {
    expect(normalizeNameColor(null)).toBe("default");
    expect(normalizeNameColor(undefined)).toBe("default");
    expect(normalizeNameColor("")).toBe("default");
  });

  it("normalizes case and surrounding whitespace", () => {
    // Values can arrive hand-edited or from a select that was serialized oddly;
    // "Emerald" is plainly the same choice as "emerald".
    expect(normalizeNameColor("  Emerald  ")).toBe("emerald");
    expect(normalizeNameColor("SKY")).toBe("sky");
  });

  it("falls back rather than throwing on a non-string value", () => {
    // The column is TEXT, but nothing stops a value arriving from a typed query as
    // something else entirely, and a throw here would blank a page.
    expect(normalizeNameColor(42 as unknown as string)).toBe("default");
    expect(normalizeNameColor({} as unknown as string)).toBe("default");
  });
});

describe("nameColorClass", () => {
  it("returns the class for a chosen colour", () => {
    expect(nameColorClass("emerald")).toBe("text-emerald-400");
  });

  it("returns nothing to add for the default colour", () => {
    // An empty class is what lets the name inherit the colour of its surroundings,
    // which is how a member with no choice ends up looking exactly as before.
    expect(nameColorClass("default")).toBe("");
    expect(nameColorClass(null)).toBe("");
    expect(nameColorClass("chartreuse")).toBe("");
  });

  it("never returns a class for an unknown colour", () => {
    expect(nameColorClass("chartreuse")).not.toContain("text-");
  });
});

describe("NAME_COLOR_OPTIONS", () => {
  it("offers every palette colour with a label", () => {
    expect(NAME_COLOR_OPTIONS.map((option) => option.id)).toEqual([
      ...NAME_COLOR_IDS,
    ]);

    for (const option of NAME_COLOR_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it("gives the default swatch a background but no text class", () => {
    // The settings picker paints each swatch with the same class it applies to a
    // name. The default has no text class by definition, so the swatch needs a
    // background of its own or it renders as an empty circle.
    const fallback = NAME_COLOR_OPTIONS.find((option) => option.id === "default");
    expect(fallback?.className).toBe("");
    expect(fallback?.swatchClassName).toBe("bg-slate-100");
  });

it("gives every other colour a text class the swatch can borrow", () => {
    /*
     * Every entry must produce a real colour class. `black` is the one named colour
     * in the palette and has no shade, so it is allowed through explicitly rather
     * than by widening the pattern enough to accept a malformed class. Tiers 300 and
     * 400 are both legitimate: the palette sits at 400 apart from yellow and rose,
     * which drop to 300 to stay clear of amber and red.
     */
    for (const option of NAME_COLOR_OPTIONS) {
      if (option.id === "default") {
        continue;
      }

      const isNamed = option.className === "text-black";
      const isTiered = /^text-[a-z]+-300$|^text-[a-z]+-400$/.test(option.className);

      expect(isNamed || isTiered).toBe(true);
    }
  });

  it("puts the palette on the 400 tier so each swatch looks like its name", () => {
    /*
     * The regression, pinned in the only place a unit test can: the palette holds
     * Tailwind class names, not their values, so the chroma cannot be measured here.
     * Measured against the shipped theme, red-300 renders as #ffa3a3, a pale pink
     * that does not read as red. At 400 it is #ff6467, which does.
     */
    const tier = (id: string) => nameColorClass(id).replace("text-", "");

    for (const option of NAME_COLOR_OPTIONS) {
      if (option.id === "default" || option.id === "black") {
        continue;
      }

      // The two documented exceptions, asserted rather than assumed.
      const expected = ["yellow", "rose"].includes(option.id) ? "300" : "400";

      expect(tier(option.id)).toBe(`${option.id}-${expected}`);
    }
  });

  it("shows each swatch in exactly the colour it applies to the name", () => {
    // The swatch is a preview, so a member must not pick a fill and then find the
    // name lands on a different shade.
    for (const option of NAME_COLOR_OPTIONS) {
      if (option.id === "default") {
        continue;
      }

      if (option.id === "black") {
        expect(option.swatchClassName).toBe("bg-black");
        continue;
      }

      expect(option.swatchClassName).toBe(
        option.className.replace(/^text-/, "bg-"),
      );
    }
  });

  it("fills each swatch with the same colour it applies to the name", () => {
    /*
     * The whole point of the swatch: a member picks the button and that is the
     * colour their name becomes. The two classes are separate Tailwind utilities,
     * so they can only be checked against each other here -- a `text-*` class does
     * not paint a background, which is exactly what went wrong when the swatch was
     * rendered from the text class alone.
     */
    for (const option of NAME_COLOR_OPTIONS) {
      if (option.id === "default") {
        continue;
      }

      // Same hue and shade as the text class, only the utility differs.
      expect(option.swatchClassName).toBe(
        option.className.replace(/^text-/, "bg-"),
      );
    }
  });

it("gives every swatch a background so none renders empty", () => {
    for (const option of NAME_COLOR_OPTIONS) {
      const isNamed = option.swatchClassName === "bg-black";
      const isTiered = /^bg-[a-z]+-\d+$/.test(option.swatchClassName);

      expect(isNamed || isTiered).toBe(true);
    }
  });

  it("covers the full spectrum a member would expect to pick", () => {
    /*
     * A guard against the palette quietly shrinking: the colour choice is the one
     * thing on the profile a member is meant to enjoy, and losing a hue because a
     * table was edited without care would be an invisible regression.
     */
    for (const hue of [
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
    ]) {
      expect(NAME_COLOR_IDS).toContain(hue);
    }

    expect(NAME_COLOR_OPTIONS).toHaveLength(NAME_COLOR_IDS.length);
  });

  it("has no duplicate colours between the default and the palette", () => {
    // `default` is the only entry without a text class, so it must also be the only
    // one sharing a hue with nothing. Two entries rendering identically would make
    // the picker look broken.
    const nonDefault = NAME_COLOR_OPTIONS.filter((o) => o.id !== "default");
    const classes = nonDefault.map((option) => option.className);

    expect(new Set(classes).size).toBe(classes.length);
  });
});
describe("mergeNameColorClasses", () => {
  /*
   * The regression these cover: a name rendered with `text-slate-100` next to an
   * amber choice stayed slate, because both utilities have the same specificity and
   * `text-slate-100` is emitted later in the compiled stylesheet. Dropping the
   * competitor is the only fix that does not depend on stylesheet order.
   */
  it("drops a competing text colour so the chosen one is the only one left", () => {
    const merged = mergeNameColorClasses("font-medium text-slate-100", "amber");
    expect(merged).toBe(`font-medium ${nameColorClass("amber")}`);
    expect(merged).not.toMatch(/\btext-slate-100\b/);
  });

  it("drops text-white, which is the default override on most pages", () => {
    expect(mergeNameColorClasses("font-semibold text-white", "emerald")).toBe(
      `font-semibold ${nameColorClass("emerald")}`,
    );
  });

  it("keeps the caller's non-colour classes", () => {
    // Weight, alignment and sizing are what the surrounding layout depends on, and
    // none of them compete with the colour.
    expect(
      mergeNameColorClasses(
        "truncate text-xs font-medium text-slate-400",
        "sky",
      ),
    ).toBe(`truncate text-xs font-medium ${nameColorClass("sky")}`);
  });

  it("never strips a typography or alignment utility", () => {
    // Sizes are letters or start with digits, alignment has no shade. Stripping
    // either would silently restyle names across every page.
    const merged = mergeNameColorClasses(
      "text-sm text-lg text-2xl text-center text-balance text-right",
      "rose",
    );

    for (const kept of [
      "text-sm",
      "text-lg",
      "text-2xl",
      "text-center",
      "text-balance",
      "text-right",
    ]) {
      expect(merged).toContain(kept);
    }

expect(merged).toContain(nameColorClass("rose"));
  });

  it("drops an arbitrary text colour but keeps an arbitrary text size", () => {
    const merged = mergeNameColorClasses("text-[14px] text-[#ff0000]", "teal");
    expect(merged).toBe(`text-[14px] ${nameColorClass("teal")}`);
  });

  it("drops a colour at a reduced opacity", () => {
    expect(mergeNameColorClasses("text-slate-100/80", "violet")).toBe(
      `${nameColorClass("violet")}`,
    );
  });

  it("leaves the caller's classes untouched when no colour is chosen", () => {
    // A member with no choice must render exactly as they did before, including the
    // text colour their page already relied on.
    expect(mergeNameColorClasses("font-medium text-slate-100", null)).toBe(
      "font-medium text-slate-100",
    );
    expect(mergeNameColorClasses("font-medium text-slate-100", "default")).toBe(
      "font-medium text-slate-100",
    );
    expect(mergeNameColorClasses("font-medium text-slate-100", "chartreuse")).toBe(
      "font-medium text-slate-100",
    );
  });

  it("handles an absent class list", () => {
    expect(mergeNameColorClasses(undefined, "amber")).toBe(nameColorClass("amber"));
    expect(mergeNameColorClasses("", "amber")).toBe(nameColorClass("amber"));
    expect(mergeNameColorClasses(undefined, null)).toBeUndefined();
  });

  it("survives extra whitespace without leaving blank tokens", () => {
    expect(mergeNameColorClasses("  font-medium   text-white  ", "lime")).toBe(
      `font-medium ${nameColorClass("lime")}`,
    );
  });

it("leaves no palette colour competing with the choice", () => {
    /*
     * The invariant that matters: once a colour is chosen, nothing else of the same
     * kind may survive on the span, because a survivor would outrank it by
     * stylesheet order. Checked over the whole palette so a new colour added later
     * cannot quietly reintroduce the bug.
     */
    for (const option of NAME_COLOR_OPTIONS) {
      if (option.id === "default") {
        continue;
      }

      const merged = mergeNameColorClasses(
        "font-medium text-white text-slate-100",
        option.id,
      );

      expect(merged).toContain(option.className);
      expect(merged).not.toMatch(/\btext-white\b/);
      expect(merged).not.toMatch(/\btext-slate-100\b/);
    }
  });
});

describe("nameColorAvatarClass", () => {
  it("tints the initials avatar in the chosen colour", () => {
    // The avatar is the only place a member's colour shows when they have uploaded
    // no picture, so it has to follow the same palette as their name.
    expect(nameColorAvatarClass("emerald")).toBe("bg-emerald-500/20");
    expect(nameColorAvatarClass("amber")).toBe("bg-amber-500/20");
  });

  it("leaves the default avatar untouched", () => {
    // An empty string falls back to the plain slate circle rather than tinting it.
    expect(nameColorAvatarClass("default")).toBe("");
    expect(nameColorAvatarClass(null)).toBe("");
    expect(nameColorAvatarClass("chartreuse")).toBe("");
  });

it("tints at a shared alpha for every colour", () => {
    // The alpha is hand-tuned for legibility against a very dark surface. If one
    // colour drifted opaque it would read as a block rather than a backdrop.
    for (const id of NAME_COLOR_IDS) {
      if (id === "default") {
        continue;
      }

      expect(nameColorAvatarClass(id)).toMatch(/^bg-[a-z]+(-500)?\/20$/);
    }
  });

  it("tints in the same hue as the name colour", () => {
    /*
     * Name and avatar must never disagree about what colour a member picked. The
     * hues are compared, not the shades: a name needs the lightest 300 tier to stay
     * legible as thin text, while a 20%-alpha background has to be a step stronger at
     * 500 or the tint would be invisible. `black` is shade-less in both.
     */
    for (const id of NAME_COLOR_IDS) {
      if (id === "default") {
        continue;
      }

      const nameHue = nameColorClass(id).replace(/^text-/, "").replace(/-\d+$/, "");
      /*
       * Strips the prefix, then any shade and alpha tail. Done in that order so a
       * named colour with no shade (`black/20`) reduces to `black` rather than
       * keeping its alpha and appearing to disagree with the name class.
       */
      const avatarHue = nameColorAvatarClass(id)
        .replace(/^bg-/, "")
        .replace(/-\d+\/\d+$/, "")
        .replace(/\/\d+$/, "")
        .replace(/-\d+$/, "");

      expect(avatarHue).toBe(nameHue);
    }
  });
});
