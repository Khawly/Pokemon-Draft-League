/*
 * Makes the champion crown and the E4 badge available to every name the app renders.
 *
 * The crown belongs to a member, not a team, and it is held until somebody else wins it.
 * The E4 badge belongs to the second through fifth finishers from that same playoff
 * season. Only the shell knows which members those are, so the sets are published through
 * a context rather than threaded down as a prop: names appear in dozens of components that
 * have no business knowing what a season is.
 *
 * Two keys are published, not one. Plenty of call sites have the member's id and can match
 * exactly, but many only have a display name -- the roster rows, the draft board, the rules
 * page. Those match on the name instead, which is what lets the honors reach every surface
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
  memberHonor,
  NO_CROWN,
  type CrownKeys,
  type MemberHonor,
} from "@/lib/champion-crown";
import { loadEliteFinishers } from "@/lib/supabase/honors";
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
  /** Member ids who finished second through fifth in the previous season. */
  eliteUserIds?: string[];
  /** Their display names, for surfaces that only know the name. */
  eliteNames?: string[];
  children: ReactNode;
}

/**
 * Publishes which members wear the champion crown and the E4 badge.
 *
 * @param props - {@link CrownProviderProps}
 * @returns The children, with the honoured set available to any name inside them.
 */
export function CrownProvider({
  crownedUserIds,
  crownedNames = [],
  eliteUserIds = [],
  eliteNames = [],
  children,
}: CrownProviderProps) {
  /*
   * Compared by value: the callers rebuild these arrays on every fetch, and a new Set each
   * time would re-render every name beneath the provider.
   */
  const idsKey = crownedUserIds.join("|");
  const namesKey = crownedNames.join("|");
  const eliteIdsKey = eliteUserIds.join("|");
  const eliteNamesKey = eliteNames.join("|");

  /*
   * Merged with whatever is already published rather than replacing it. A page that loads
   * its own crowned ids nests inside the app-wide scope, and replacing would drop the names
   * the outer one contributed -- which is exactly what surfaces without an id rely on.
   */
  const outer = useContext(CrownContext);

  const value = useMemo(
    () => {
      const local = crownKeys(
        crownedUserIds,
        crownedNames,
        eliteUserIds,
        eliteNames,
      );

      return {
        userIds: new Set([...outer.userIds, ...local.userIds]),
        names: new Set([...outer.names, ...local.names]),
        eliteUserIds: new Set([...outer.eliteUserIds, ...local.eliteUserIds]),
        eliteNames: new Set([...outer.eliteNames, ...local.eliteNames]),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined values
    [idsKey, namesKey, eliteIdsKey, eliteNamesKey, outer],
  );

  return <CrownContext.Provider value={value}>{children}</CrownContext.Provider>;
}

/**
 * Loads the reigning champion and the previous season's elite finishers for the
 * league on screen and publishes them.
 *
 * Mounted once in the root layout, so every page under it gets the honors without
 * knowing anything about seasons or brackets. It re-reads when the member switches
 * league, which is what stops the previous league's champion and E4 badges appearing
 * on the new one's pages.
 *
 * A failed read is not fatal: the badges are decoration, and the page they sit on is not.
 *
 * @param props.children - The rendered page.
 * @returns The children, with the honors published.
 */
export function CrownScope({ children }: { children: ReactNode }) {
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    leagueId: string;
    crownedUserIds: string[];
    crownedNames: string[];
    eliteUserIds: string[];
    eliteNames: string[];
  } | null>(null);

  useEffect(() => {
    const read = () => {
      /*
       * A league opened from a shared link leads the stored choice, so the honors
       * match the page being viewed. Falling back to the remembered league keeps
       * pages without a `leagueId` query (the dashboard's own route) covered.
       */
      const fromUrl = new URLSearchParams(window.location.search).get(
        "leagueId",
      );
      setLeagueId(fromUrl || getSelectedLeague());
    };

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
      const [championResult, eliteResult] = await Promise.allSettled([
        supabase.rpc("crowned_member_names", { p_league_id: leagueId }),
        loadEliteFinishers(leagueId),
      ]);

      if (cancelled) {
        return;
      }

      const championRows =
        championResult.status === "fulfilled" && !championResult.value.error
          ? ((championResult.value.data ?? []) as {
              user_id: string;
              display_name: string | null;
            }[])
          : [];

      const elite =
        eliteResult.status === "fulfilled" ? eliteResult.value : [];

      setLoaded({
        leagueId,
        crownedUserIds: championRows.map((row) => row.user_id),
        crownedNames: championRows
          .map((row) => row.display_name ?? "")
          .filter((name) => name.length > 0),
        eliteUserIds: elite.map((member) => member.userId),
        eliteNames: elite
          .map((member) => member.displayName ?? "")
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
      : {
          crownedUserIds: [] as string[],
          crownedNames: [] as string[],
          eliteUserIds: [] as string[],
          eliteNames: [] as string[],
        };

  return (
    <CrownProvider
      crownedUserIds={crown.crownedUserIds}
      crownedNames={crown.crownedNames}
      eliteUserIds={crown.eliteUserIds}
      eliteNames={crown.eliteNames}
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

/**
 * Resolves the honor, if any, that should sit beside a member's name.
 *
 * @param userId - The member's id, or nullish when the caller does not know it.
 * @param name - The display name being rendered.
 * @returns "champion", "elite", or null.
 */
export function useMemberHonor(
  userId: string | null | undefined,
  name: string | null | undefined,
): MemberHonor {
  return memberHonor(useContext(CrownContext), userId, name);
}