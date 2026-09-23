# Project Context: Pokémon Draft League Platform

## 1. Product Goals

This platform is a league management and draft application for Pokémon-themed fantasy leagues. It supports league creation, season management, draft pool setup, team management, competitive match scheduling, and trade workflows.

This project must be built with clarity, predictable state transitions, and strong data integrity. Because the app uses Supabase, we should use Supabase Auth for authentication and Supabase Postgres + RLS for data protection. Where Supabase does not enforce a rule automatically, that rule must be enforced either in the application layer or as a database constraint, trigger, or stored procedure.

## 2. Architecture & Technology Rules

- Frontend: Next.js App Router, TypeScript, Tailwind CSS.
- Hosting: Vercel Hobby tier.
- Backend: Supabase PostgreSQL.
- Authentication: Supabase Auth.
- Real-time behavior: use Supabase subscriptions or polling only when necessary; keep UI state consistent with server truth.
- Optimization: React Compiler enabled via `experimental: { reactCompiler: true }`.
- Free-tier constraint: minimize serverless compute. Interactive views, draft logic, and auth flows should use client-side rendering and direct Supabase access where appropriate, but all business-critical writes must be validated and protected on the server/database side.
- Media optimization: use native HTML `<img>` tags for Pokémon sprites and avatars rather than Next.js `<Image>` to avoid image quota issues.
- Security: RLS enabled on every table. No table should be readable or writable without explicit policy design.
- Data source: use PokeAPI for all Pokémon metadata and images.
- Principle: never trust the browser as the source of truth for rules that affect league integrity, draft legality, budgets, permissions, or match outcomes.

## 3. Authentication & Authorization Principles

### 3.1 Auth flow

- Sign-up is email + password.
- Email verification is required before a user can access a league.
- Login is email + password only.
- Password reset uses a magic link sent by email.
- All auth state should be stored with Supabase Auth, not in a custom user table as the authority.

### 3.2 Authorization model

The app must use a role-based access model:

- Owner: full league control.
- Admin: elevated permissions, but not full ownership authority.
- Member: standard user access.

Authorization rules must be enforced in both places:

1. Application layer: UI hides actions and routes the user away from unauthorized actions.
2. Database layer: RLS policies and constraints enforce the final authority.

### 3.3 Required behavior if Supabase does not handle it

If Supabase Auth and RLS do not automatically enforce a requirement, the application must enforce it using one or more of the following:

- app-side validation before mutation
- database CHECK constraints
- database triggers
- Postgres functions called from the app
- row-level security policies

Examples include:

- owner-only actions
- draft turn enforcement
- team salary bounds
- duplicate replay link rejection
- no edit of prior seasons
- draft order integrity
- unique roster membership

### 3.4 Session and account data

The app user profile table should store only metadata related to the user, such as:

- display name
- custom avatar URL or object reference
- Pokemon Showdown username
- last active league context

The canonical auth record remains Supabase Auth. Do not treat client-side app state as the user’s identity source.

## 4. Core Data Model & Database Principles

### 4.1 Database principles

- Normalize data model to avoid duplication of source-of-truth values.
- Use foreign keys and constraints rather than app-only assumptions.
- Prefer a single canonical record for each fact, not multiple derived copies.
- Make auditability a first-class requirement.
- Every mutation must be transaction-safe.
- Timestamps must be stored in UTC; display can be converted for the user timezone.

### 4.2 Core entities

The following entities are required. Their exact schema can evolve, but these are the minimum logical domains:

- profiles
  - id
  - display_name
  - avatar_url
  - pokemon_showdown_username
  - created_at
  - updated_at

- leagues
  - id
  - name
  - owner_id
  - created_at
  - is_active

- league_members
  - id
  - league_id
  - user_id
  - role
  - joined_at
  - is_active
  - UNIQUE (league_id, user_id)

- seasons
  - id
  - league_id
  - season_number
  - status
  - draft_started_at
  - draft_completed_at
  - created_at
  - UNIQUE (league_id, season_number)

- league_settings
  - id
  - league_id
  - season_id
  - draft_format
  - total_rounds
  - enable_pokemon_costs
  - total_token_salary
  - allow_per_team_salary
  - pick_time_limit_minutes
  - auto_pick_on_timeout
  - skip_player_on_timeout
  - quiet_hours_enabled
  - quiet_hours_start_est
  - quiet_hours_end_est
  - draft_order_json
  - updated_at

- teams
  - id
  - league_id
  - season_id
  - owner_user_id
  - team_name
  - draft_position
  - total_salary_override
  - created_at

- team_roster
  - id
  - team_id
  - pokemon_id
  - species_name
  - tier_value
  - acquired_at
  - source
  - UNIQUE (team_id, pokemon_id)

- draft_pools
  - id
  - league_id
  - season_id
  - name
  - created_by
  - created_at
  - updated_at

- draft_pool_pokemon
  - id
  - draft_pool_id
  - pokemon_id
  - species_name
  - tier_value
  - is_in_pool
  - created_at
  - updated_at
  - UNIQUE (draft_pool_id, pokemon_id)

- draft_priority_lists
  - id
  - league_id
  - season_id
  - user_id
  - round_number
  - slot_index
  - pokemon_id
  - UNIQUE (league_id, season_id, user_id, round_number, slot_index)

- matches
  - id
  - league_id
  - season_id
  - week_number
  - is_playoff
  - player_1_team_id
  - player_2_team_id
  - scheduled_at
  - status
  - winner_team_id
  - created_at
  - updated_at

- match_results
  - id
  - match_id
  - reporter_user_id
  - winner_team_id
  - replay_url
  - game_number
  - pokemon_left_alive
  - submitted_at
  - is_manual
  - UNIQUE (match_id, game_number)

- transactions
  - id
  - league_id
  - season_id
  - user_id
  - team_id
  - pokemon_id
  - action
  - quantity
  - cost_delta
  - note
  - created_at

- trades
  - id
  - league_id
  - season_id
  - proposer_user_id
  - recipient_user_id
  - status
  - created_at
  - updated_at

- trade_items
  - id
  - trade_id
  - side
  - user_id
  - team_id
  - pokemon_id
  - created_at

- notifications
  - id
  - league_id
  - season_id
  - recipient_user_id
  - actor_user_id
  - type
  - message
  - is_read
  - related_entity_type
  - related_entity_id
  - created_at

- rules_documents
  - id
  - league_id
  - season_id
  - created_by
  - content
  - file_url
  - updated_at

### 4.3 Important invariants

These are non-negotiable rules and must be enforced either by DB constraints or app logic:

- Each Pokémon can exist in only one team roster record at a time within the same active league season.
- A user can only be a member of a league once.
- Exactly one Owner exists per league.
- Each league may have multiple seasons, but previous seasons are read-only unless explicitly allowed by another rule.
- Draft pool Pokémon may be in “In Pool” or “Off Pool” state, but if they are on a team, they must not also be counted as available in the active pool for draft eligibility.
- A team’s token budget cannot go below 0 when costs are enabled.
- A draft pick cannot select a Pokémon that would make a team’s salary negative.
- A replay link can only be submitted once per match/game.
- Two approved submissions for the same match/game must be rejected.
- A user cannot edit match results unless they are Owner or Admin.
- Trade approval must be deterministic and based on recorded votes.

## 5. Seasonal Model & Rule Handling

- Every page and every data set is tied to the currently selected season.
- Previous seasons are read-only and locked from modification.
- The app must explicitly filter all queries by `current_season_id` or the selected season.
- The selected season is the source of truth for draft, teams, standings, trades, and schedule data.
- No cross-season edits are allowed; if a prior season is displayed, it is for historical view only.

## 6. League Structure & Pool Management

### 6.1 League creation

- League creation requires a user to create a league and become the Owner.
- A new default season is created with season number = 1.

### 6.2 Unique Pokémon rule

Each Pokémon in the active draft pool may only be assigned to one team in the active season. A Pokémon cannot be both in the active draft pool and in multiple team rosters.

### 6.3 Draft pool creation

League Owners can set up the draft pool in either of these ways:

1. Manually add Pokémon from the Pokémon catalog.
2. Import a CSV file.

CSV format must be explicit:

- `pokemon_name` (required)
- `tier` (optional, integer, default 0)
- `status` (optional, `in_pool` or `off_pool`)
- `notes` (optional)

The app must validate that imported rows are parseable and match known Pokémon entries.

### 6.4 Draft pool page requirements

- Top bar: Save, Export CSV, Import CSV.
- Saved Draft Pools dropdown and name input.
- Warning banner if unsaved changes exist.
- Summary panel with counts for:
  - In Pool
  - Tiered
  - Not Tiered
- Tabs: Tiers and Table.

Table columns:

- Checkbox
- Image
- Pokémon
- Type
- BST
- Gen
- Status
- Tier

Rules:

- Status is `In Pool` or `Off Pool`.
- `In Pool` is green; `Off Pool` is neutral or gray.
- Tier default is 0 when in pool and `-` when off pool.
- Double-clicking a status or tier cell updates that value inline or through a focused edit workflow.
- Sorting is allowed by Pokémon, Type, BST, Gen, Status, and Tier.
- Search and filtering must work by name, type, generation, and status.

Tier list behavior:

- Each tier section is displayed with the highest tier first.
- Untiered Pokémon appear at the bottom.
- Only Pokémon with `In Pool = true` appear in the tier list.
- Clicking a Pokémon allows the owner to update its tier or remove it from the pool.

### 6.5 Pool and roster integrity rules

The system must ensure:

- a Pokémon appearing in a team roster is not simultaneously considered available for draft pool pickup unless explicitly reintroduced via free agent flow
- a Pokémon can appear in multiple saved draft pools, but only one active pool is in use for a given season
- unsaved changes must be discarded or saved before leaving the page

## 7. Settings Dashboard & Navigation

### 7.1 Shared navigation

Every page in the app includes a persistent top navigation bar with:

- Home button
- League dropdown menu
- Create New League option
- Gear icon button that opens a dropdown menu
- Dropdown options must include:
  - Settings for: User
  - Settings for: Draft (Owner only)
  - Settings for: League (Owner only)
  - Settings for: Members (Owner only)
- The navigation bar remains pinned at the top of the screen while the page scrolls
- League header showing name and current season
- Season selector with previous/current season navigation

This navigation must remain visible on all authenticated pages, including league views, settings, draft settings, and league creation pages.

The owner-only settings entries are hidden from non-owners and only appear for the current league owner.

### 7.2 Create New League page

After clicking "Create New League" in the League dropdown box, bring the user to this page.
Here they need to input a League Name and Number of Players, both can be changed later in the League Settings.
Create League button at the bottom to create the new league, giving the user Owner role and bringing them to the draft settings page.

### 7.2 Draft settings page (Owner only)

The owner can configure the draft through the Draft Settings page.

Required fields:

- Draft format: Snake or Set; Snake is default.
- Total rounds: integer value.
- Budget system:
  - checkbox: Enable Costs for Pokémon
  - if enabled: Total Token Salary field is shown
  - checkbox: Teams can have different Total Salary
  - if enabled: per-team salary override fields appear on the team screen and must be >= 0
- Timer controls:
  - Pick time limit in minutes
  - Auto-pick when time expires
  - Skip player when time runs out
  - Auto-pick and skip are mutually exclusive
- Quiet hours:
  - if enabled, start/end times are required
  - times are locked to EST timezone
- Draft order configuration:
  - manual arrangement or randomize
- Save Changes button, disabled until changes exist
- Unsaved changes confirmation when navigating away

### 7.3 Member settings page (Owner only)

- Display every league member.
- Allow removing members.
- Allow promoting to Admin.
- Owner role is visibly displayed.
- Admin role is visibly displayed.
- Owner must confirm before leaving the league.
- If the Owner leaves:
  - if another member is available, prompt for reassignment
  - otherwise a random Admin becomes owner
  - if no Admins exist, a random Member becomes owner

### 7.4 League settings page (Owner only)

- League name text field.
- Number of Players: integer.
- Transaction system:
  - checkbox: Enable Transaction Costs
  - if enabled, Transaction Cost field is shown
- Owner has to Approve Trades: checkbox.
- Owners/Admins vote on Approving Trades: only enabled if the previous checkbox is checked.
- Approval logic must be deterministic: if admin approval is enabled, approval requires a majority of Owner + Admin voting members.

### 7.5 User settings page

- Display name
- Pokémon Showdown username
- Custom avatar upload
- Default avatar behavior: first letter of username + random color, selectable by user
- Save Changes button only enabled when there are unsaved edits
- Leave League button with confirmation

## 8. Draftboard Page

- Invite link for the league.
- Copy link button with confirmation feedback.
- Draft checklist for Owner only.
- Checklist items:
  - Fill all team slots
  - Assign draft position to each team
  - Draft pool complete
- Start Draft button is enabled only when all checklist items are complete.
- Preview Draft button is enabled until draft begins.
- Tier List button goes to the pool page with the tier view visible.
- Player list displays member names and draft positions.

## 9. Team Page

### 9.1 Team selection

- Default selected team is the current user’s team.
- Compare button adds an additional team selector.
- Clear Comparison removes comparison team state and secondary tables.
- Drop Pokémon option allows the user to remove a selected Pokémon from their roster.
- Drop flow must:
  - show confirmation with Pokémon name
  - refund tier cost into the team’s token salary
  - remove Pokémon from roster
  - add to free agents table
  - add a transaction record

### 9.2 Team stats table

The team stats table should show:

- Pokémon image and name
- Tier
- Type 1
- Type 2
- Abilities
- Total HP/Atk/Def/SpA/SpD/Spe
- Sorting by stat and tier column
- Filter/search by Pokémon and type

### 9.3 Defensive typing table

- Show matchup multipliers for each Pokémon against all relevant types.
- Color coding:
  - 1 = Neutral
  - 2 = Super effective (green)
  - 4 = Extremely effective (bright green)
  - 0 = Immune (black)
  - 0.5 = Not very effective (red)
  - 0.25 = Mostly ineffective (dark red)

### 9.4 Match history

- Show match history for currently selected player.
- Columns:
  - Matchup
  - Winner
  - Date/Time
  - Replay
  - Delete (Owner/Admin only)
- Sorted by earliest date/time first.

## 10. Schedule Page

### 10.1 Schedule creation

Owner only.

Fields:

- regular season weeks
- match format: Single Game or Best of 3
- playoff teams
- playoff match format
- playoff format: Single Elimination or Double Elimination
- first-round byes (read-only, calculated)

Generate button is enabled only when regular season weeks is valid.

### 10.2 Schedule tab

- Current week and matchup selector.
- Matchup view uses Player 1 vs Player 2 with avatars and names.
- Buttons: Schedule, Add Replay, Forfeit.
- Upcoming Matches table shows user’s scheduled match first, then others by earliest time.
- Notification semantics:
  - scheduling a match notifies the opponent
  - opponent can update date/time and notes and save
  - updates notify the other participant
- Next week starts when all matches of the current week are successfully submitted.

### 10.3 Replay submission

- Users may submit a replay URL.
- Duplicate replay URL is rejected with the message: `Link already submitted`.
- Only one result submission per game is allowed.
- Owners and Admins can edit game results and replay links.
- Best-of-3 results switch the “vs” section to a game record, like `2-1`.
- Replay links should display as clickable video thumbnails or a clear link to the replay.

### 10.4 Standings and history

- Playoffs tab: bracket view after the draft is complete.
- Standings tab: rank, player, W/L, KO Diff.
- History tab: all games sorted by posted time, newest first.

## 11. Pokémon Page

- Show every Pokémon not currently on a team.
- Include tier list tab for the same pool.
- Search box labeled `Find Pokemon`.
- Each row includes a pickup control: `+` to add or `-` to cancel the pending add.
- If the player clicks `+`, show confirmation with the Pokémon cost and projected balance after the purchase, including transaction costs if enabled.
- On confirmation, the Pokémon is added to the player’s roster and token salary updates accordingly.
- Transaction history on the right shows prior actions in stack order.

## 12. Trades Page

### 12.1 Proposal flow

- User selects a target team/player.
- User chooses Pokémon to send to the other party and Pokémon to receive.
- The UI updates both sides’ projected balances.
- On submit, a trade proposal is created in “Awaiting Response”.

### 12.2 Recipient flow

- Recipient sees an incoming proposal notification and the trade details card.
- Recipient may Accept or Decline.
- If accepted, the trade moves to “Pending Approval”.
- Owner and Admins receive a pending approval notification if enabled.

### 12.3 Approval logic

This is the final legal definition:

- If `Admins can Approve Trades = false`, only the Owner can approve or reject a pending trade.
- If `Admins can Approve Trades = true`, then the Owner plus all Admins are considered approvers.
- Approval is valid when the number of approvals is greater than half of the total number of Owner + Admin voting members.
- The Owner may use an explicit `Approve (Override)` action to bypass approval quorum.
- If a trade is rejected or fails approval, the involved users receive a `Trade Rejected` notification and a card with a `Clear` action.

### 12.4 Completion rules

- Upon successful completion, every user sees the completed trade in trade history with a timestamp.
- Only involved players see it in `My Trades`.

## 13. Rules Page

- Show league rules created by the Owner.
- The Owner may upload a text file or type rules directly into a text area.
- Rules must be saved with version history or at minimum a last-updated timestamp.

## 14. Draft Page

### 14.1 Draft layout

- Top half: each player’s name and draft picks in pick order.
- Bottom half: split into left and right panels.
- Left panel: Pokémon table or tier list view, matching the Pokémon page experience.
- Right panel: priority list for the current user.

### 14.2 Priority list behavior

- Priority list is split by round.
- Users can reorder Pokémon within a round or move them to different rounds.
- The leftmost Pokémon in a round has highest priority.
- Users may add Pokémon to multiple rounds but not duplicate within the same round.
- Users may remove Pokémon from the priority list.

### 14.3 Pick flow

- `Pickup` actions add a Pokémon to the current user’s priority list or directly draft it depending on the state and flow.
- Once a pick is complete, the timer resets and the turn passes to the next user.
- Snake drafts reverse order on even-numbered rounds.
- Timer starts per player’s pick.
- Audio/visual notifications are triggered when the timer begins and again at one minute remaining.
- Current player’s card is highlighted visually.
- If costs are enabled, users cannot pick a Pokémon that would put their total salary below 0.
- If a user has 0 tokens, they are skipped automatically.
- Once draft is complete, the timer stops and the draft is locked.

### 14.4 System note

When the draft is active, the app must treat the draft as the source of truth for picks and roster additions. State updates are applied through a consistent draft transaction so that all clients see the same result.

## 15. Styling

- Give the app a Pokémon-inspired visual style.
- Use game-like fonts, bright primary colors, and clear card-based layouts.
- Type visuals should be clear and readable on both desktop and tablet-sized layouts.
- Dark backgrounds.

## 16. Engineering Standards

The app should follow these engineering principles:

- Use optimistic UI only for convenience; never as the source of truth for state-changing actions.
- Validate at the edge, but enforce in the database.
- Every mutations must check auth and authorization before performing work.
- Use transactions for anything that depends on multiple tables being kept in sync.
- Track timestamps for all mutations and relate changes to the user who caused them.
- Write idempotent workflows for actions such as trade approvals, replay submissions, and lottery/draft ordering.
- Avoid duplicate logic between client and server. The database and middleware should be treated as the final authority.

## 17. Final Project Decision

This product must be treated as a domain-heavy application where an incorrect rule is worse than a missing feature. Therefore, all critical decisions should be enforced in the database and auth layer whenever possible, and every requirement in this document should be interpreted as a system invariant rather than a loose UX suggestion.
