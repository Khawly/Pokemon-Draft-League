/*
 * Which badge a champion is awarded, by the season they won.
 *
 * A league's title run is mapped onto the gym badge sequence: the season one champion earns
 * Kanto's first badge, season two the second, and so on through the eight badges of a region
 * before moving on to the next. That gives a long-running league a visible ladder rather
 * than a list of identical trophies.
 *
 * The names below are the ones the games give the badges, so a champion can be shown holding
 * "Boulder Badge" rather than "Badge 1". Regions whose badge names are not established are
 * listed without names and fall back to a numbered label, which is honest about the gap
 * rather than inventing canon.
 */

/** Eight badges make a region, as they do in the games. */
export const BADGES_PER_REGION = 8;

type Region = {
  /** Region name, as it is shown beside the badge. */
  region: string;
  /** Badge names in order, or an empty list when the region has no established ones. */
  names: string[];
};

const REGIONS: Region[] = [
  {
    region: "Kanto",
    names: [
      "Boulder",
      "Cascade",
      "Thunder",
      "Rainbow",
      "Soul",
      "Marsh",
      "Volcano",
      "Earth",
    ],
  },
  {
    region: "Johto",
    names: [
      "Zephyr",
      "Hive",
      "Plain",
      "Fog",
      "Storm",
      "Mineral",
      "Glacier",
      "Rising",
    ],
  },
  {
    region: "Hoenn",
    names: [
      "Stone",
      "Knuckle",
      "Dynamo",
      "Heat",
      "Balance",
      "Feather",
      "Mind",
      "Rain",
    ],
  },
  {
    region: "Sinnoh",
    names: [
      "Coal",
      "Forest",
      "Cobble",
      "Fen",
      "Relic",
      "Mine",
      "Icicle",
      "Beacon",
    ],
  },
  {
    region: "Unova",
    names: [
      "Trio",
      "Basic",
      "Insect",
      "Bolt",
      "Quake",
      "Jet",
      "Freeze",
      "Legend",
    ],
  },
  {
    region: "Kalos",
    names: [
      "Bug",
      "Cliff",
      "Rumble",
      "Plant",
      "Voltage",
      "Fairy",
      "Psychic",
      "Iceberg",
    ],
  },
  // Alola awards island trials rather than gym badges, and Paldea's badges have no
  // established names. Both are listed so the sequence keeps moving through the regions,
  // and both fall back to a numbered label.
  { region: "Alola", names: [] },
  { region: "Galar", names: [] },
  { region: "Paldea", names: [] },
];

/** The badge one season's champion is awarded. */
export type SeasonBadge = {
  /** Which season won it. */
  season: number;
  /** The region the badge belongs to. */
  region: string;
  /** Its position within that region, one to eight. */
  number: number;
  /** Its name, e.g. "Boulder", or a numbered label where none is established. */
  name: string;
  /** The full label, e.g. "Boulder Badge". */
  label: string;
};

/**
 * The badge for a season's champion.
 *
 * Seasons are counted from one. A season beyond the listed regions still gets a badge -- a
 * league that outlives this list should not lose the ladder -- labelled by number.
 *
 * @param seasonNumber - The season the title was won in, counting from one.
 * @returns The badge that season is worth.
 */
export function badgeForSeason(seasonNumber: number): SeasonBadge {
  // Non-numeric or nonsensical input is treated as the first season rather than throwing on
  // a page that is otherwise fine.
  const season =
    Number.isFinite(seasonNumber) && seasonNumber > 0
      ? Math.floor(seasonNumber)
      : 1;

  const index = season - 1;
  const regionIndex = Math.floor(index / BADGES_PER_REGION);
  const number = (index % BADGES_PER_REGION) + 1;

  const known = REGIONS[regionIndex];
  const region = known?.region ?? `Region ${regionIndex + 1}`;
  const name = known?.names[number - 1] ?? `Badge ${number}`;

  return {
    season,
    region,
    number,
    name,
    label: name.endsWith("Badge") ? name : `${name} Badge`,
  };
}