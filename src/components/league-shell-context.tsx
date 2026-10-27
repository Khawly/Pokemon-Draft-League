/*
 * Shared league shell data for the Pokemon Draft League.
 *
 * The top bar and the league sub-navigation both need the same small facts:
 * who is signed in, which leagues they belong to, which league is selected,
 * that league's seasons and selected season, whether they own it, and the two
 * nav alert counts. Reading those independently in each component meant every
 * page load repeated the profile and membership queries, and the dashboard also
 * re-read the alert feeds that the sub-navigation had already loaded.
 *
 * This provider owns that data once for the shell. Pages still load their own
 * league-specific payloads; they need rows and shapes the shell does not.
 */
"use client";

import {
  createContext,
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

/** A season option for the sub-navigation's season selector. */
export type SeasonOption = {
  id: string;
  season_number: number;
  name: string | null;
};

/** Both alert feeds the sub-navigation reads. */
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
 * to both navigation bars.
 *
 * @param props.children - The top bar and league sub-navigation.
 * @returns The context provider.
 */
export function LeagueShellProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedLeagueId = searchParams.get("leagueId");
  const requestedSeasonId = searchParams.get("seasonId");

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
   */
  useEffect(() => {
    let cancelled = false;

    async function loadShell() {
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
    }

    void loadShell();

    return () => {
      cancelled = true;
    };
  }, [requestedLeagueId]);

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
  }, [selectedLeague, requestedSeasonId]);

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

      const params = new URLSearchParams(searchParams.toString());
      params.set("leagueId", selectedLeague);
      params.set("seasonId", nextSeasonId);

      window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
      window.location.reload();
    },
    [selectedLeague, selectedSeasonId, searchParams, pathname],
  );

  const value = useMemo<LeagueShellContextValue>(
    () => ({
      isReady,
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
      isReady,
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
