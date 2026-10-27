-- Hot-path indexes for league-scale concurrency
--
-- The system design review found that the tables with the most cross-league
-- traffic were relying on primary keys or on unique indexes whose leading
-- columns did not match the filters the pages actually use. The current dataset
-- is small, so sequential scans are still cheap, but these paths grow with the
-- number of leagues and seasons:
--
--   - league_settings is read by season id on almost every page
--   - matches are filtered by league + season, ordered by week, and looked up by
--     each side's team id for the alert feed
--   - notifications are filtered by recipient, unread state, and time
--   - transactions are summed by team id for salary and read by season for the
--     draft's team balances
--   - free agent availability checks a Pokemon across every roster in a season
--   - draft pools are listed by league + season
--
-- These are additive indexes only. No table, column, or function behaviour
-- changes, and IF NOT EXISTS keeps the migration safe if an index was added
-- manually in another environment.

-- League settings are looked up by season on every page load. The existing
-- unique index leads with league_id, so a season-only filter cannot seek it.
-- Supports: league_settings lookup in dashboard/draft/pool/teams/trades/
-- schedule/pokemon loaders.
CREATE INDEX IF NOT EXISTS league_settings_season_idx
  ON public.league_settings (season_id);

-- Matches are listed for one league season and ordered by week. This also
-- serves the league + season prefix of queries that do not order by week.
-- Supports: dashboard schedule, schedule page, team match history.
CREATE INDEX IF NOT EXISTS matches_league_season_week_idx
  ON public.matches (league_id, season_id, week_number);

-- The match-time alert query matches either side of a matchup. Two indexes let
-- Postgres combine the OR branches instead of scanning every match in a season.
-- Supports: loadMatchTimeAlerts in dashboard.ts.
CREATE INDEX IF NOT EXISTS matches_season_team1_idx
  ON public.matches (season_id, player_1_team_id);
CREATE INDEX IF NOT EXISTS matches_season_team2_idx
  ON public.matches (season_id, player_2_team_id);

-- The notification list is newest-first for one recipient in one league.
-- Supports: dashboard notification history.
CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
  ON public.notifications (league_id, recipient_user_id, created_at DESC);

-- The two alert feeds (match time and trades) filter unread notifications for a
-- recipient before narrowing by type/related entity.
-- Supports: loadMatchTimeAlerts / loadTradeAlerts.
CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
  ON public.notifications (league_id, recipient_user_id, is_read);

-- A team's salary and history are read by team id, newest first.
-- Supports: team ledger and any per-team spend lookup.
CREATE INDEX IF NOT EXISTS transactions_team_created_idx
  ON public.transactions (team_id, created_at DESC);

-- The draft reads the whole season ledger to compute every team's balance.
-- team_id and cost_delta make this index covering for that aggregation.
-- Supports: draft salary totals.
CREATE INDEX IF NOT EXISTS transactions_season_team_idx
  ON public.transactions (season_id, team_id, cost_delta);

-- Availability checks ask whether a Pokemon is on any roster in the season.
-- The unique roster index leads with team_id, so it cannot seek by Pokemon.
-- Supports: pickup_roster_pokemon's roster-availability check.
CREATE INDEX IF NOT EXISTS team_roster_pokemon_idx
  ON public.team_roster (pokemon_id, team_id);

-- Saved draft pools are listed for one league + season, oldest first. The
-- existing partial unique index only covers the one-active-per-season case.
-- Supports: pool selectors and the draft page's active-pool lookup.
CREATE INDEX IF NOT EXISTS draft_pools_league_season_idx
  ON public.draft_pools (league_id, season_id, created_at);

-- Refresh planner statistics after the new indexes so the first queries after
-- deployment can choose them. These tables are small today; this is cheap.
ANALYZE public.league_settings;
ANALYZE public.matches;
ANALYZE public.notifications;
ANALYZE public.transactions;
ANALYZE public.team_roster;
ANALYZE public.draft_pools;

-- Indexes do not change the PostgREST schema, but reloading is harmless and
-- keeps this migration consistent with the rest of the migration history.
NOTIFY pgrst, 'reload schema';
