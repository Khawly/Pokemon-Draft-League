/*
 * Route metadata for the league sub-navigation.
 *
 * The tab labels and their slugs live here rather than inside a component so the
 * dashboard shell and the global sub-navigation agree on where each tab points,
 * and so adding a tab is one edit instead of two.
 */

/** A tab rendered in the league sub-navigation. */
export type LeagueTab = {
  /** Visible label. */
  label: string;
  /** Route slug, e.g. "draftboard". */
  slug: string;
};

/**
 * Tabs shown under the top navigation once a league is selected.
 *
 * Dashboard is first and is the only entry whose route is not derived from a
 * sibling page name.
 */
export const LEAGUE_TABS: LeagueTab[] = [
  { label: "Dashboard", slug: "dashboard" },
  { label: "Draft Board", slug: "draftboard" },
  { label: "Teams", slug: "teams" },
  { label: "Pokémon", slug: "pokemon" },
  { label: "Schedule", slug: "schedule" },
  { label: "Trades", slug: "trades" },
  { label: "Rules", slug: "rules" },
  { label: "Hall of Fame", slug: "hall-of-fame" },
];

/**
 * Builds the route for a tab slug using the selected league id.
 *
 * @param slug - The route slug.
 * @param leagueId - The selected league, or null when none is resolved.
 * @returns The route, with the league attached when there is one.
 */
export function routeFor(slug: string, leagueId?: string | null): string {
  return leagueId ? `/${slug}?leagueId=${leagueId}` : `/${slug}`;
}
