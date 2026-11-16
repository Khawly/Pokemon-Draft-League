/*
 * Shared league shell data for the Pokemon Draft League.
 *
 * The top navigation bar needs a small set of facts on every page: who is
 * signed in, which leagues they belong to, which league is selected, that
 * league's seasons and selected season, whether they own it, and the two nav
 * alert counts. Reading those independently on each surface meant every page
 * load repeated the profile and membership queries, and the dashboard also
 * re-read the alert feeds the navigation had already loaded.
 *
 * This provider owns that data once for the shell. Pages still load their own
 * league-specific payloads; they need rows and shapes the shell does not. But
 * they no longer repeat the identity and membership lookups: the provider wraps
 * the page content as well as the navigation bar, and {@link useShellLeague}
 * tells a page which league to load.
 */
"use client";

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { getSelectedLeague } from "@/lib/league-selection";
import { NAV_ALERTS_CHANGED_EVENT } from "@/lib/nav-alerts";
import { getSelectedSeason, setSelectedSeason } from "@/lib/season-selection";
import { supabase } from "@/lib/supabase/client";
import {
  loadMatchTimeAlerts,
  loadTradeAlerts,
  type MatchTimeAlerts,
} from "@/lib/supabase/dashboard";
import { markNotificationsRead } from "@/lib/supabase/schedule";
import { confirmDiscardUnsavedChanges } from "@/lib/unsaved-changes";

/** One of the two alert feeds backing a nav badge. */
export type NavAlertKind = "match" | "trade";

/** A membership row reduced to what the shell needs. */
export type LeagueOption = {
  /** League id. */
  id: string;
  /** League name for the selector. */
  label: string;
  /** The member's role, e.g. "owner" / "admin" / "member". */
  role: string;
  /** The league creator, used for the owner-only settings entries. */
  ownerId: string | null;
};

/** The signed-in member's display identity for the top bar. */
export type ShellProfile = {
  displayName: string | null;
  avatarUrl: string | null;
  avatarInitials: string | null;
  nameColor: string | null;
};

/** A season option for the top navigation's season selector. */
export type SeasonOption = {
  id: string;
  season_number: number;
  name: string | null;
};

/** Both alert feeds the top navigation reads. */
export type NavAlerts = {
  match: MatchTimeAlerts;
  trade: MatchTimeAlerts;
};

/** Value published by {@link LeagueShellProvider}. */
export type LeagueShellContextValue = {
  /** False until the shell has loaded its identity and league list. */
  isReady: boolean;
  /** The signed-in user, or null when signed out. */
  userId: string | null;
  /** Profile fields for the avatar/name in the top bar. */
  profile: ShellProfile;
  /** Active leagues the member can switch between. */
  leagueOptions: LeagueOption[];
  /** Selected league id, or the "create-league" sentinel. */
  selectedLeague: string;
  /** Seasons for the selected league, newest first. */
  seasons: SeasonOption[];
  /** The season currently on screen. */
  selectedSeasonId: string | null;
  /** Whether the signed-in user owns the selected league. */
  isOwner: boolean;
  /** Unread alert counts for the Schedule and Trades tabs. */
  alerts: NavAlerts;
  /** Re-reads both alert feeds. */
  refreshAlerts: () => Promise<void>;
  /** Clears one badge and marks those notifications read. */
  markAlertsRead: (kind: NavAlertKind) => void;
  /** Stores and applies a season choice, reloading the page with it. */
  selectSeason: (seasonId: string) => Promise<void>;
};

const EMPTY_PROFILE: ShellProfile = {
  displayName: null,
  avatarUrl: null,
  avatarInitials: null,
  nameColor: null,
};

const EMPTY_ALERTS: MatchTimeAlerts = { ids: [], count: 0 };
const NO_NAV_ALERTS: NavAlerts = {
  match: EMPTY_ALERTS,
  trade: EMPTY_ALERTS,
};

const LeagueShellContext = createContext<LeagueShellContextValue | null>(null);

/**
 * The URL facts the shell derives from search params.
 *
 * `search` is kept whole as well as parsed because the season selector rewrites
 * the query string and must preserve every other parameter on the page.
 */
interface ShellParams {
  /** The page's full query string, without the leading "?". */
  search: string;
  /** The `leagueId` parameter, or null when absent. */
  leagueId: string | null;
  /** The `seasonId` parameter, or null when absent. */
  seasonId: string | null;
}

/**
 * Reads the URL search params and hands them to the shell provider.
 *
 * This is a separate component so the provider itself never calls
 * `useSearchParams`. The provider wraps the page content, and a component that
 * reads search params suspends until Next.js resolves them - if the provider
 * did it directly, every page under it would render as a skeleton in the
 * prerendered HTML. The boundary here is internal, so only this invisible
 * component is affected.
 *
 * @param props.onChange - Receives the parsed params on mount and whenever the
 *   query string changes, e.g. a league switch or a back navigation.
 * @returns Nothing; it only feeds the provider.
 */
function ShellSearchParams({
  onChange,
}: {
  onChange: (next: ShellParams) => void;
}) {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const leagueId = searchParams.get("leagueId");
  const seasonId = searchParams.get("seasonId");

  useEffect(() => {
    onChange({ search, leagueId, seasonId });
  }, [onChange, search, leagueId, seasonId]);

  return null;
}

/**
 * Fetches the signed-in member's public profile fields.
 *
 * @param userId - The profile row to read.
 * @returns The display fields, defaulting to empty values on a failed read.
 */
async function fetchProfile(userId: string): Promise<ShellProfile> {
  const { data } = await supabase
    .from("profiles")
    .select("display_name, avatar_url, avatar_initials, name_color")
    .eq("id", userId)
    .maybeSingle();

  const row = data as {
    display_name?: string | null;
    avatar_url?: string | null;
    avatar_initials?: string | null;
    name_color?: string | null;
  } | null;

  return {
    displayName: row?.display_name ?? null,
    avatarUrl: row?.avatar_url ?? null,
    avatarInitials: row?.avatar_initials ?? null,
    nameColor: row?.name_color ?? null,
  };
}

/**
 * Provides the shell identity, league list, season list, and alert counts once
 * to the navigation bar and to the page content beneath it.
 *
 * @param props.children - The navigation bar and the current page.
 * @returns The context provider.
 */
export function LeagueShellProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  /*
   * Search params arrive through the bridge below rather than from a hook here,
   * so this provider never suspends and the pages it wraps keep rendering in the
   * prerendered HTML.
   */
  const [params, setParams] = useState<ShellParams | null>(null);
  const hasParams = params !== null;
  const requestedLeagueId = params?.leagueId ?? null;
  const requestedSeasonId = params?.seasonId ?? null;

  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<ShellProfile>(EMPTY_PROFILE);
  const [leagueOptions, setLeagueOptions] = useState<LeagueOption[]>([]);
  const [seasons, setSeasons] = useState<SeasonOption[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<NavAlerts>(NO_NAV_ALERTS);
  const [isReady, setIsReady] = useState(false);
  /** Guards against an old alert request landing after a league switch. */
  const alertsRequestRef = useRef(0);

  /*
   * Identity, profile, and memberships are reloaded when the requested league
   * changes. The league id itself is not needed for these queries, but the
   * navigation that changes it is also the point at which a membership may have
   * changed (joining a league, switching to one just joined).
   *
   * Waits for the URL bridge: resolving the league before the parameters are
   * known would pick the stored league and then switch, making every deep link
   * load twice.
   */
  useEffect(() => {
    if (!hasParams) {
      return;
    }

    let cancelled = false;

    async function loadShell() {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (cancelled) {
          return;
        }

        setUserId(user?.id ?? null);

        if (!user) {
          setProfile(EMPTY_PROFILE);
          setLeagueOptions([]);
          setIsReady(true);
          return;
        }

        const [nextProfile, memberResult] = await Promise.all([
          fetchProfile(user.id),
          supabase
            .from("league_members")
            .select("league_id, role, leagues(name, owner_id)")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("joined_at", { ascending: false }),
        ]);

        if (cancelled) {
          return;
        }

        setProfile(nextProfile);

        if (memberResult.error) {
          setLeagueOptions([]);
          setIsReady(true);
          return;
        }

        setLeagueOptions(
          (memberResult.data ?? []).map((entry) => {
            const league = (entry as {
              leagues?: { name?: string | null; owner_id?: string | null } | null;
            }).leagues;

            return {
              id: entry.league_id as string,
              label: league?.name || "Untitled League",
              role: (entry.role as string | undefined) ?? "member",
              ownerId: league?.owner_id ?? null,
            };
          }),
        );
        setIsReady(true);
      } catch {
        /*
         * A thrown auth or membership read must not leave the shell unresolved:
         * every page waits on `isReady`, so an unhandled rejection here would
         * spin them forever. Treat it as a signed-out shell and let the pages
         * send the visitor back to the landing page.
         */
        if (!cancelled) {
          setLeagueOptions([]);
          setIsReady(true);
        }
      }
    }

    void loadShell();

    return () => {
      cancelled = true;
    };
  }, [requestedLeagueId, hasParams]);

  // A profile saved on the settings page refreshes the avatar without
  // re-reading every membership.
  useEffect(() => {
    if (!userId) {
      return;
    }

    let cancelled = false;

    function handleProfileUpdated() {
      void fetchProfile(userId as string).then((next) => {
        if (!cancelled) {
          setProfile(next);
        }
      });
    }

    window.addEventListener("profile-updated", handleProfileUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("profile-updated", handleProfileUpdated);
    };
  }, [userId]);

  /*
   * Resolving the league mirrors the top navigation: a URL parameter wins, then
   * the stored choice, then the most recently joined active league.
   */
  const selectedLeague = useMemo(() => {
    if (pathname?.startsWith("/create-league")) {
      return "create-league";
    }

    if (requestedLeagueId) {
      return requestedLeagueId;
    }

    const stored = getSelectedLeague();

    if (stored && leagueOptions.some((entry) => entry.id === stored)) {
      return stored;
    }

    if (leagueOptions.length === 0) {
      return "create-league";
    }

    return leagueOptions[0].id;
  }, [leagueOptions, pathname, requestedLeagueId]);

  const membership = leagueOptions.find((entry) => entry.id === selectedLeague);
  const isOwner = Boolean(userId && membership?.ownerId === userId);

  // Seasons for the selected league, newest first. An explicit season in the URL
  // wins so the dropdown matches a settings page opened on a particular season;
  // otherwise the stored choice is kept, falling back to the newest season.
  useEffect(() => {
    if (!hasParams) {
      return;
    }

    if (!selectedLeague || selectedLeague === "create-league") {
      return;
    }

    let cancelled = false;

    async function loadSeasons() {
      const { data, error } = await supabase
        .from("seasons")
        .select("id, season_number, name")
        .eq("league_id", selectedLeague)
        .order("season_number", { ascending: false });

      if (cancelled) {
        return;
      }

      if (error) {
        setSeasons([]);
        setSelectedSeasonId(null);
        return;
      }

      const list = (data ?? []) as SeasonOption[];
      const stored = getSelectedSeason(selectedLeague);
      const requestedValid =
        requestedSeasonId != null &&
        list.some((season) => season.id === requestedSeasonId);

      /*
       * A settings page can be opened directly on a past season through a
       * seasonId parameter. Adopting it as the stored choice keeps the shell and
       * every page navigated to from here on the same season.
       */
      if (requestedValid && requestedSeasonId && requestedSeasonId !== stored) {
        setSelectedSeason(selectedLeague, requestedSeasonId);
      }

      const preferred = requestedValid ? requestedSeasonId : stored;

      setSeasons(list);
      setSelectedSeasonId(
        list.find((season) => season.id === preferred)?.id ?? list[0]?.id ?? null,
      );
    }

    void loadSeasons();

    return () => {
      cancelled = true;
    };
  }, [selectedLeague, requestedSeasonId, hasParams]);

  /**
   * Re-reads both alert feeds. Used on mount, league change, and whenever another
   * surface announces that the member's notifications may have moved.
   */
  const refreshAlerts = useCallback(async () => {
    if (!userId || !selectedLeague || selectedLeague === "create-league") {
      return;
    }

    const requestId = ++alertsRequestRef.current;

    const [match, trade] = await Promise.all([
      loadMatchTimeAlerts(selectedLeague, userId).catch(() => EMPTY_ALERTS),
      loadTradeAlerts(selectedLeague, userId).catch(() => EMPTY_ALERTS),
    ]);

    if (requestId === alertsRequestRef.current) {
      setAlerts({ match, trade });
    }
  }, [selectedLeague, userId]);

  useEffect(() => {
    void refreshAlerts();
  }, [refreshAlerts]);

  // "Clear all notifications" on the dashboard deletes the rows behind these
  // badges. It announces the change and the shell re-reads them.
  useEffect(() => {
    function handleAlertsChanged() {
      void refreshAlerts();
    }

    window.addEventListener(NAV_ALERTS_CHANGED_EVENT, handleAlertsChanged);
    return () =>
      window.removeEventListener(NAV_ALERTS_CHANGED_EVENT, handleAlertsChanged);
  }, [refreshAlerts]);

  const markAlertsRead = useCallback(
    (kind: NavAlertKind) => {
      const ids = alerts[kind].ids;

      if (ids.length === 0) {
        return;
      }

      setAlerts((current) => ({ ...current, [kind]: EMPTY_ALERTS }));
      void markNotificationsRead(ids).catch(() => undefined);
    },
    [alerts],
  );

  /**
   * Stores the chosen season and reloads with it in the URL so every page's
   * loader reads it. Settings pages honour `seasonId`; other pages read storage.
   *
   * @param nextSeasonId - The season to apply.
   */
  const selectSeason = useCallback(
    async (nextSeasonId: string) => {
      if (
        !selectedLeague ||
        selectedLeague === "create-league" ||
        !nextSeasonId ||
        nextSeasonId === selectedSeasonId
      ) {
        return;
      }

      const allowed = await confirmDiscardUnsavedChanges();

      if (!allowed) {
        return;
      }

      setSelectedSeason(selectedLeague, nextSeasonId);
      setSelectedSeasonId(nextSeasonId);

      const nextParams = new URLSearchParams(params?.search ?? "");
      nextParams.set("leagueId", selectedLeague);
      nextParams.set("seasonId", nextSeasonId);

      window.history.replaceState(
        null,
        "",
        `${pathname}?${nextParams.toString()}`,
      );
      window.location.reload();
    },
    [selectedLeague, selectedSeasonId, params, pathname],
  );

  /*
   * Consumers wait for the URL bridge as well as the data: until the params are
   * known, `selectedLeague` is only a guess from storage, and a page started on
   * that guess would immediately reload against the real one.
   */
  const readyForConsumers = isReady && hasParams;

  const value = useMemo<LeagueShellContextValue>(
    () => ({
      isReady: readyForConsumers,
      userId,
      profile,
      leagueOptions,
      selectedLeague,
      seasons,
      selectedSeasonId,
      isOwner,
      alerts,
      refreshAlerts,
      markAlertsRead,
      selectSeason,
    }),
    [
      readyForConsumers,
      userId,
      profile,
      leagueOptions,
      selectedLeague,
      seasons,
      selectedSeasonId,
      isOwner,
      alerts,
      refreshAlerts,
      markAlertsRead,
      selectSeason,
    ],
  );

  return (
    <LeagueShellContext.Provider value={value}>
      {/*
        The bridge is the only thing that touches search params. Its boundary is
        internal so suspending while Next resolves the query string never hides
        the page content below.
      */}
      <Suspense fallback={null}>
        <ShellSearchParams onChange={setParams} />
      </Suspense>
      {children}
    </LeagueShellContext.Provider>
  );
}

/**
 * Reads the shell data. Must be used inside {@link LeagueShellProvider}.
 *
 * @returns The current shell context value.
 */
export function useLeagueShell(): LeagueShellContextValue {
  const value = useContext(LeagueShellContext);

  if (!value) {
    throw new Error("useLeagueShell must be used inside LeagueShellProvider.");
  }

  return value;
}

/** The league facts a page needs before it can load its own payload. */
export interface ShellLeague {
  /** The league to load, or null when the shell resolved none. */
  leagueId: string | null;
  /** The signed-in member's id, or null while resolution is pending or signed out. */
  userId: string | null;
  /** True until the shell has resolved the URL, the member, and the league. */
  isResolving: boolean;
  /** True once the shell knows the visitor is not signed in. */
  signedOut: boolean;
}

/**
 * Reads the league a page should load from the shell.
 *
 * Pages used to answer this themselves with an auth check and a membership
 * query - work the navigation bar had already done. The "create-league" sentinel
 * is mapped to null so a page only has to handle "no league to show" once.
 *
 * @returns The league id, the member id, and the states a page must wait on.
 */
export function useShellLeague(): ShellLeague {
  const { isReady, userId, selectedLeague } = useLeagueShell();
  const hasLeague = Boolean(selectedLeague) && selectedLeague !== "create-league";

  return {
    leagueId: hasLeague ? selectedLeague : null,
    userId,
    isResolving: !isReady,
    signedOut: isReady && !userId,
  };
}
