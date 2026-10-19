/*
 * Makes the champion crown available to every name the app renders.
 *
 * The crown belongs to a member, not a team, and it is held until somebody else wins it.
 * Only the shell knows who that is, so the set is published through a context rather than
 * threaded down as a prop: names appear in dozens of components that have no business
 * knowing what a season is.
 *
 * Two keys are published, not one. Plenty of call sites have the member's id and can match
 * exactly, but many only have a display name -- the roster rows, the draft board, the rules
 * page. Those match on the name instead, which is what lets the crown reach every surface
 * without threading an id through a dozen data models. An id is preferred whenever one is
 * available, so the exact answer wins wherever it can be given.
 */
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  crownKeys,
  isCrownedMember,
  NO_CROWN,
  type CrownKeys,
} from "@/lib/champion-crown";
import { getSelectedLeague, SELECTED_LEAGUE_CHANGED_EVENT } from "@/lib/league-selection";
import { supabase } from "@/lib/supabase/client";

/**
 * The default is empty, so a name rendered outside a provider -- a dialog, a test, a page
 * that has not loaded a season yet -- simply has no crown instead of throwing.
 */
const CrownContext = createContext<CrownKeys>(NO_CROWN);

/** Props for the {@link CrownProvider} component. */
export interface CrownProviderProps {
  /** Member ids who should show the crown. */
  crownedUserIds: string[];
  /** Their display names, for surfaces that only know the name. */
  crownedNames?: string[];
  children: ReactNode;
}

/**
 * Publishes which members wear the champion crown.
 *
 * @param props - {@link CrownProviderProps}
 * @returns The children, with the crowned set available to any name inside them.
 */
export function CrownProvider({
  crownedUserIds,
  crownedNames = [],
  children,
}: CrownProviderProps) {
  /*
   * Compared by value: the callers rebuild these arrays on every fetch, and a new Set each
   * time would re-render every name beneath the provider.
   */
  const idsKey = crownedUserIds.join("|");
  const namesKey = crownedNames.join("|");

  /*
   * Merged with whatever is already published rather than replacing it. A page that loads
   * its own crowned ids nests inside the app-wide scope, and replacing would drop the names
   * the outer one contributed -- which is exactly what surfaces without an id rely on.
   */
  const outer = useContext(CrownContext);

  const value = useMemo(
    () => ({
      userIds: new Set([...outer.userIds, ...crownedUserIds]),
      names: new Set([
        ...outer.names,
        ...crownKeys(crownedUserIds, crownedNames).names,
      ]),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined values
    [idsKey, namesKey, outer],
  );

  return <CrownContext.Provider value={value}>{children}</CrownContext.Provider>;
}

/**
 * Loads the reigning champion for the league on screen and publishes it.
 *
 * Mounted once in the root layout, so every page under it gets the crown without knowing
 * anything about seasons or brackets. It re-reads when the member switches league, which
 * is what stops the previous league's champion appearing on the new one's pages.
 *
 * A failed read is not fatal: the crown is a decoration, and the page it sits on is not.
 *
 * @param props.children - The rendered page.
 * @returns The children, with the crown published.
 */
export function CrownScope({ children }: { children: ReactNode }) {
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    leagueId: string;
    crownedUserIds: string[];
    crownedNames: string[];
  } | null>(null);

  useEffect(() => {
    const read = () => setLeagueId(getSelectedLeague());

    read();
    window.addEventListener(SELECTED_LEAGUE_CHANGED_EVENT, read);
    // Another tab switching league fires `storage`; this tab fires the event above.
    window.addEventListener("storage", read);

    return () => {
      window.removeEventListener(SELECTED_LEAGUE_CHANGED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  useEffect(() => {
    if (!leagueId) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const { data, error } = await supabase.rpc("crowned_member_names", {
        p_league_id: leagueId,
      });

      if (cancelled) {
        return;
      }

      if (error) {
        setLoaded({ leagueId, crownedUserIds: [], crownedNames: [] });
        return;
      }

      const rows = (data ?? []) as {
        user_id: string;
        display_name: string | null;
      }[];

      setLoaded({
        leagueId,
        crownedUserIds: rows.map((row) => row.user_id),
        crownedNames: rows
          .map((row) => row.display_name ?? "")
          .filter((name) => name.length > 0),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  /*
   * Derived rather than stored, and only trusted while it belongs to the league on screen.
   * A result for the league just switched away from is ignored, so the previous champion's
   * crown does not follow the member onto the new league's pages while the read is in
   * flight. It also keeps the empty case out of the effect.
   */
  const crown =
    loaded && loaded.leagueId === leagueId
      ? loaded
      : { crownedUserIds: [] as string[], crownedNames: [] as string[] };

  return (
    <CrownProvider
      crownedUserIds={crown.crownedUserIds}
      crownedNames={crown.crownedNames}
    >
      {children}
    </CrownProvider>
  );
}

/**
 * Whether a member wears the champion crown.
 *
 * An id is preferred when the caller has one, because it is exact. Falling back to the name
 * is what reaches the surfaces that only render text. A member who has no display name set
 * will not match by name, which is the right failure: better no crown than the wrong one.
 *
 * @param userId - The member's id, or nullish when the caller does not know it.
 * @param name - The display name being rendered.
 * @returns True when the member is crowned.
 */
export function useCrowned(
  userId: string | null | undefined,
  name: string | null | undefined,
): boolean {
  return isCrownedMember(useContext(CrownContext), userId, name);
}