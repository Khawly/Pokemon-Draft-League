/*
 * Makes the champion crown available to every name the app renders.
 *
 * The crown belongs to a member, not a team, and it lasts the season they won and the whole
 * of the next one. Only the page that loads the season knows who that is, so the set is
 * published through a context rather than threaded down as a prop: names appear in dozens
 * of components that have no business knowing what a season is.
 *
 * A component that renders a name only has to say who the person is. Everything else about
 * the crown -- whether there is one, which season, whether it has expired -- is decided
 * once, here.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * The crowned member ids for the season on screen.
 *
 * The default is empty, so a name rendered outside a provider -- a dialog, a test, a page
 * that has not loaded a season yet -- simply has no crown instead of throwing.
 */
const CrownContext = createContext<ReadonlySet<string>>(new Set<string>());

/** Props for the {@link CrownProvider} component. */
export interface CrownProviderProps {
  /** Member ids who should show the crown in this season's view. */
  crownedUserIds: string[];
  children: ReactNode;
}

/**
 * Publishes which members wear the champion crown.
 *
 * @param props - {@link CrownProviderProps}
 * @returns The children, with the crowned set available to any name inside them.
 */
export function CrownProvider({ crownedUserIds, children }: CrownProviderProps) {
  /*
   * Compared by value rather than by reference: the loader rebuilds this array on every
   * fetch, and a new Set each time would re-render every name beneath the provider.
   */
  const key = crownedUserIds.join("|");

  const value = useMemo(
    () => new Set(crownedUserIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined value
    [key],
  );

  return <CrownContext.Provider value={value}>{children}</CrownContext.Provider>;
}

/**
 * Whether a member wears the champion crown in the season on screen.
 *
 * @param userId - The member's id, or nullish when the caller does not know it.
 * @returns True when the member is crowned.
 */
export function useCrowned(userId: string | null | undefined): boolean {
  const crowned = useContext(CrownContext);
  return userId ? crowned.has(userId) : false;
}