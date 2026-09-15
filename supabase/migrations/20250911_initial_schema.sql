-- Core app schema for Pokémon Draft League
--
-- Initial migration: creates the core application tables (profiles, leagues,
-- seasons, teams, draft pools, matches, trades, notifications, rules
-- documents), enables row-level security on every table, applies the base RLS
-- policies, and installs the helper RPCs/triggers that bootstrap profiles and
-- leagues.

-- User profile row, one per auth.users entry; stores display information and
-- the user's Pokémon Showdown username.
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  pokemon_showdown_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Top-level league container; owned by a single user and capped by the number
-- of players configured for the league.
CREATE TABLE IF NOT EXISTS public.leagues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  number_of_players INTEGER NOT NULL DEFAULT 10 CHECK (number_of_players > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Membership and role (owner/admin/member) of a user within a league; one row
-- per (league, user), tracks whether the membership is active, and records an
-- optional per-member token salary.
CREATE TABLE IF NOT EXISTS public.league_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')) DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  total_token_salary INTEGER CHECK (total_token_salary IS NULL OR total_token_salary >= 0),
  UNIQUE (league_id, user_id)
);

-- A numbered season within a league; tracks the draft lifecycle status
-- (pending/active/complete/archived) and its start/completion timestamps.
CREATE TABLE IF NOT EXISTS public.seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft_pending','draft_active','draft_complete','archived')) DEFAULT 'draft_pending',
  draft_started_at TIMESTAMPTZ,
  draft_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (league_id, season_number)
);

-- Per-season drafting and trading configuration for a league: draft format and
-- rounds, token salaries, pick time limits, quiet hours, trade approval flow,
-- and the serialized draft order.
CREATE TABLE IF NOT EXISTS public.league_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  draft_format TEXT NOT NULL CHECK (draft_format IN ('snake','set')) DEFAULT 'snake',
  total_rounds INTEGER NOT NULL DEFAULT 1 CHECK (total_rounds > 0),
  enable_pokemon_costs BOOLEAN NOT NULL DEFAULT FALSE,
  total_token_salary INTEGER CHECK (total_token_salary IS NULL OR total_token_salary >= 0),
  allow_per_team_salary BOOLEAN NOT NULL DEFAULT FALSE,
  pick_time_limit_minutes INTEGER NOT NULL DEFAULT 5 CHECK (pick_time_limit_minutes > 0),
  auto_pick_on_timeout BOOLEAN NOT NULL DEFAULT FALSE,
  skip_player_on_timeout BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_hours_start_est TEXT,
  quiet_hours_end_est TEXT,
  enable_transaction_costs BOOLEAN NOT NULL DEFAULT FALSE,
  transaction_cost INTEGER CHECK (transaction_cost IS NULL OR transaction_cost >= 0),
  admins_approve_trades BOOLEAN NOT NULL DEFAULT FALSE,
  owners_admins_vote_on_trades BOOLEAN NOT NULL DEFAULT FALSE,
  draft_order_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (league_id, season_id)
);

-- A team slot for a league season; links an owner user to a team name, a
-- draft position, and an optional salary override per team.
CREATE TABLE IF NOT EXISTS public.teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  draft_position INTEGER,
  total_salary_override INTEGER CHECK (total_salary_override IS NULL OR total_salary_override >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pokémon currently on a team, with tier, when it was acquired, and how it was
-- acquired (draft, pickup, or trade).
CREATE TABLE IF NOT EXISTS public.team_roster (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  pokemon_id TEXT NOT NULL,
  species_name TEXT NOT NULL,
  tier_value INTEGER NOT NULL DEFAULT 0,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL CHECK (source IN ('draft','pickup','trade')),
  UNIQUE (team_id, pokemon_id)
);

-- Named group of Pokémon that a league season drafts from; a league may have
-- multiple pools.
CREATE TABLE IF NOT EXISTS public.draft_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pokémon belonging to a draft pool, with its tier and whether it is still
-- available in the pool for drafting.
CREATE TABLE IF NOT EXISTS public.draft_pool_pokemon (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_pool_id UUID NOT NULL REFERENCES public.draft_pools(id) ON DELETE CASCADE,
  pokemon_id TEXT NOT NULL,
  species_name TEXT NOT NULL,
  tier_value INTEGER NOT NULL DEFAULT 0,
  is_in_pool BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (draft_pool_id, pokemon_id)
);

-- Per-user, per-round ordered priority slots for auto-drafting; each entry
-- pins a Pokémon at a given slot index within a round.
CREATE TABLE IF NOT EXISTS public.draft_priority_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number >= 1),
  slot_index INTEGER NOT NULL CHECK (slot_index >= 0),
  pokemon_id TEXT NOT NULL,
  UNIQUE (league_id, season_id, user_id, round_number, slot_index)
);

-- Scheduled head-to-head match between two teams in a season week; tracks
-- status, scheduling, and the winning team.
CREATE TABLE IF NOT EXISTS public.matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  week_number INTEGER NOT NULL CHECK (week_number >= 1),
  is_playoff BOOLEAN NOT NULL DEFAULT FALSE,
  player_1_team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  player_2_team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('scheduled','in_progress','completed','forfeit','cancelled')) DEFAULT 'scheduled',
  winner_team_id UUID REFERENCES public.teams(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reported per-game results for a match, including the reporting user, winner,
-- optional replay URL, and how many Pokémon survived; at most one row per game.
CREATE TABLE IF NOT EXISTS public.match_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  reporter_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  winner_team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  replay_url TEXT,
  game_number INTEGER NOT NULL CHECK (game_number >= 1),
  pokemon_left_alive INTEGER,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_manual BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (match_id, game_number)
);

-- Ledger of roster moves (added, dropped, trade_in, trade_out) with quantity
-- and cost delta, forming an audit trail per team and season.
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  pokemon_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added','dropped','trade_in','trade_out')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  cost_delta INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A trade proposal between a proposer and recipient user, tracking its state
-- through the approval workflow (response, approval, completion, cancellation).
CREATE TABLE IF NOT EXISTS public.trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  proposer_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('awaiting_response','accepted','pending_approval','approved','rejected','completed','cancelled')) DEFAULT 'awaiting_response',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One Pokémon offered by the proposer or recipient side of a trade.
CREATE TABLE IF NOT EXISTS public.trade_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('proposer','recipient')),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  pokemon_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- In-app notifications for a recipient user, optionally tied to a related
-- entity and actor; read state is tracked on the notification.
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES public.profiles(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  related_entity_type TEXT,
  related_entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- League rules content and/or file URL for a specific season, editable by the
-- league's staff.
CREATE TABLE IF NOT EXISTS public.rules_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT,
  file_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_pool_pokemon ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_priority_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rules_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can view leagues they belong to" ON public.leagues;
DROP POLICY IF EXISTS "Owners can create leagues" ON public.leagues;
DROP POLICY IF EXISTS "Owners can update their leagues" ON public.leagues;
DROP POLICY IF EXISTS "Users can view their league memberships" ON public.league_members;
DROP POLICY IF EXISTS "Users can insert their own league membership" ON public.league_members;
DROP POLICY IF EXISTS "Owners can update league memberships" ON public.league_members;
DROP POLICY IF EXISTS "Users can view their season records" ON public.seasons;
DROP POLICY IF EXISTS "Owners can create seasons for their leagues" ON public.seasons;
DROP POLICY IF EXISTS "Owners can update seasons for their leagues" ON public.seasons;
DROP POLICY IF EXISTS "Users can view league settings for leagues they belong to" ON public.league_settings;
DROP POLICY IF EXISTS "Owners can manage league settings" ON public.league_settings;
DROP POLICY IF EXISTS "Owners can update league settings" ON public.league_settings;

CREATE POLICY "Users can view their own profile"
ON public.profiles
FOR SELECT
USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile"
ON public.profiles
FOR INSERT
WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
ON public.profiles
FOR UPDATE
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can view leagues they belong to"
ON public.leagues
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = leagues.id AND lm.user_id = auth.uid() AND lm.is_active = TRUE
  )
);

CREATE POLICY "Owners can create leagues"
ON public.leagues
FOR INSERT
WITH CHECK (owner_id = auth.uid());

-- SECURITY DEFINER RPC that atomically creates a league: inserts the league,
-- makes the caller the owner member, creates season #1, and seeds default
-- league settings with a randomized draft order. Validates inputs, rejects
-- unauthenticated callers, and returns the new ids. Bypasses RLS as the
-- definer (owner) but enforces its own auth checks.
CREATE OR REPLACE FUNCTION public.create_league_for_user(
  p_name TEXT,
  p_number_of_players INTEGER
)
RETURNS TABLE (
  league_id UUID,
  season_id UUID,
  league_name TEXT,
  number_of_players INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_league_id UUID;
  v_season_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to create a league.';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'League name is required.';
  END IF;

  IF p_number_of_players IS NULL OR p_number_of_players <= 0 THEN
    RAISE EXCEPTION 'Number of players must be a positive whole number.';
  END IF;

  INSERT INTO public.leagues (name, owner_id, number_of_players, is_active)
  VALUES (btrim(p_name), v_user_id, p_number_of_players, TRUE)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, is_active)
  VALUES (v_league_id, v_user_id, 'owner', TRUE);

  INSERT INTO public.seasons (league_id, season_number, status)
  VALUES (v_league_id, 1, 'draft_pending')
  RETURNING id INTO v_season_id;

  INSERT INTO public.league_settings (
    league_id,
    season_id,
    draft_format,
    total_rounds,
    enable_pokemon_costs,
    total_token_salary,
    allow_per_team_salary,
    pick_time_limit_minutes,
    auto_pick_on_timeout,
    skip_player_on_timeout,
    quiet_hours_enabled,
    quiet_hours_start_est,
    quiet_hours_end_est,
    enable_transaction_costs,
    transaction_cost,
    admins_approve_trades,
    owners_admins_vote_on_trades,
    draft_order_json
  )
  VALUES (
    v_league_id,
    v_season_id,
    'snake',
    1,
    FALSE,
    NULL,
    FALSE,
    5,
    FALSE,
    FALSE,
    FALSE,
    NULL,
    NULL,
    FALSE,
    NULL,
    FALSE,
    FALSE,
    jsonb_build_object(
      'mode', 'randomized',
      'participants', p_number_of_players
    )
  );

  RETURN QUERY
  SELECT v_league_id, v_season_id, btrim(p_name), p_number_of_players;
END;
$$;

CREATE POLICY "Owners can update their leagues"
ON public.leagues
FOR UPDATE
USING (
  owner_id = auth.uid()
)
WITH CHECK (
  owner_id = auth.uid()
);

CREATE POLICY "Users can view their league memberships"
ON public.league_members
FOR SELECT
USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own league membership"
ON public.league_members
FOR INSERT
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Owners can update league memberships"
ON public.league_members
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = league_members.league_id AND l.owner_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = league_members.league_id AND l.owner_id = auth.uid()
  )
);

CREATE POLICY "Users can view their season records"
ON public.seasons
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = seasons.league_id AND lm.user_id = auth.uid() AND lm.is_active = TRUE
  )
);

CREATE POLICY "Owners can create seasons for their leagues"
ON public.seasons
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = seasons.league_id AND l.owner_id = auth.uid()
  )
);

CREATE POLICY "Owners can update seasons for their leagues"
ON public.seasons
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = seasons.league_id AND l.owner_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = seasons.league_id AND l.owner_id = auth.uid()
  )
);

CREATE POLICY "Users can view league settings for leagues they belong to"
ON public.league_settings
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = league_settings.league_id AND lm.user_id = auth.uid() AND lm.is_active = TRUE
  )
);

CREATE POLICY "Owners can manage league settings"
ON public.league_settings
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = league_settings.league_id AND l.owner_id = auth.uid()
  )
);

CREATE POLICY "Owners can update league settings"
ON public.league_settings
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = league_settings.league_id AND l.owner_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = league_settings.league_id AND l.owner_id = auth.uid()
  )
);

-- SECURITY DEFINER trigger function that provisions a profile row whenever a
-- new auth user is created, deriving display_name from user metadata (falling
-- back to the email local part). No-op on conflict so replayed signups are
-- safe.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Generic BEFORE UPDATE trigger function that stamps NEW.updated_at = NOW()
-- only when the firing table actually has an updated_at column.
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = TG_TABLE_NAME
      AND column_name = 'updated_at'
  ) THEN
    NEW.updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leagues_updated_at ON public.leagues;
CREATE TRIGGER leagues_updated_at
BEFORE UPDATE ON public.leagues
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS seasons_updated_at ON public.seasons;
CREATE TRIGGER seasons_updated_at
BEFORE UPDATE ON public.seasons
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS league_settings_updated_at ON public.league_settings;
CREATE TRIGGER league_settings_updated_at
BEFORE UPDATE ON public.league_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS draft_pools_updated_at ON public.draft_pools;
CREATE TRIGGER draft_pools_updated_at
BEFORE UPDATE ON public.draft_pools
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS draft_pool_pokemon_updated_at ON public.draft_pool_pokemon;
CREATE TRIGGER draft_pool_pokemon_updated_at
BEFORE UPDATE ON public.draft_pool_pokemon
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS matches_updated_at ON public.matches;
CREATE TRIGGER matches_updated_at
BEFORE UPDATE ON public.matches
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trades_updated_at ON public.trades;
CREATE TRIGGER trades_updated_at
BEFORE UPDATE ON public.trades
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS rules_documents_updated_at ON public.rules_documents;
CREATE TRIGGER rules_documents_updated_at
BEFORE UPDATE ON public.rules_documents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
