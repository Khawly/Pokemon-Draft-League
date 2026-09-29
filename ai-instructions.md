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
  - timezone
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
  - status is one of: `unscheduled`, `scheduled`, `in_progress`, `completed`, `forfeit`, `cancelled`

- match_scheduling_proposals
  - id
  - match_id
  - proposed_by
  - proposed_at
  - notes
  - status
  - created_at
  - responded_at
  - responded_by
  - status is one of: `pending`, `accepted`, `declined`, `withdrawn`; at most one `pending` row per match

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
  - read state is flipped only by `mark_notifications_read`, scoped to `auth.uid()`; the table has no client UPDATE policy
  - rows are deleted only by the member's own dashboard **Clear all** control, which is confirmed first and scoped to the selected league; the DELETE policy allows a member to remove only rows addressed to them, and only while they are still an active member of the league

- rules_documents
  - id
  - league_id
  - season_id
  - created_by
  - content
  - file_url
  - updated_at

- user_availability
  - user_id
  - day_of_week
  - is_unavailable
  - start_time
  - end_time
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
- A user has at most one `user_availability` row per `day_of_week`, and can only ever read or write their own.
- A user’s availability is stored as a wall clock in that user’s own time zone; it must never be stored as an instant, because the window recurs every week.
- A match with no agreed time is `unscheduled`, never `scheduled`. This is enforced on insert, so no code path can create a match that claims an agreement nobody made.
- A match becomes `scheduled` only when the other participant accepts a pending proposal. Only the participant who did not propose may accept or decline it, and at most one proposal may be pending per match.
- A match's status is a function of its results and its agreed time, never of who a member is named. Renaming someone must not touch a single match, result, or the league's week pointer.
- The league's week is `league_settings.current_week`, maintained only by the weekly-deadline system. Any page that displays a "current week" must read that when the deadline is enabled and must not re-derive it from match statuses, or a match that is not genuinely closed drags the whole league backwards on screen.

### 4.4 Display time zone

- Every timestamp is stored in UTC. What a member reads is not.
- `profiles.timezone` is the single source of truth for the zone league dates and times render in. A page must never fall back to the browser's zone for a value the member can see, because two members on the same matchup have to see the same instant described in their own local time.
- The chosen zone is mirrored into a local cache so the first paint is already correct; the cache is a performance detail and the profile remains the authority.
- Any `datetime-local` input on a league page is read and written in the member's chosen zone, not the device's. A naïve local-time conversion shifts the saved instant for anyone whose zone differs from their device.
- Availability windows belong to the zone they were typed in, so showing one to another member requires converting it; see §10.2.
- A zone shown anywhere in the UI carries its GMT acronym, e.g. `Europe/London (GMT+1)`. Acronyms are computed from the zone's own offset, not read from `Intl`, whose `short` name mixes region abbreviations (`EDT`) with GMT offsets and whose `shortGMT` option is not universally supported.
- The acronym reflects the offset in effect now, so a daylight-saving zone reads `GMT+1` in summer and `GMT` in winter.

### 4.5 Display names

- `profiles.display_name` is the authority for how a member is labelled everywhere. There is no second source and no cached copy.
- `teams.team_name` is a snapshot copied out of `profiles.display_name` when the draft starts. It is not editable anywhere and is never refreshed, so it must never be used to label a person. A member who renames themselves keeps the old name in every `team_name`.
- Anywhere the UI names a player — matchup cards, standings, brackets, match history, next-match and upcoming lists — it reads the owner's `display_name` and falls back to `team_name` only when a profile has no name set.
- The dashboard header is no exception: it reads `profiles.display_name`, not `auth.user_metadata`, which is why it used to disagree with every other page.
- Avatars already come from `profiles.avatar_url` while names came from `teams.team_name`, which is how a rename left a member's new photo next to their old name.


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

Time zone:

- A select listing IANA time zones, seeded with the browser's own zone so a
  profile that has never been configured is not shown UTC times it has to go
  change before the page means anything.
- The selection is stored on `profiles.timezone` and applies to every date and
  time on every league page (see §4.4). It is a display preference only and must
  never change what is stored.
- A saved profile whose zone is outside the runtime's zone list stays selectable
  rather than silently snapping to something else.
- Saving refreshes the local zone cache so the change is visible on the next page
  without a reload.

Availability:

- A section with one row per day of the week, Sunday first.
- Each row has a checkbox marking the day unavailable, plus a start and end time
  input. The time inputs are disabled while the day is marked unavailable, and
  the row then reads as unavailable rather than showing a window that is ignored.
- Times are the user's own wall clock, interpreted in the time zone selected
  above, and the section states that zone so the entry is unambiguous.
- A range whose end is not after its start is read as wrapping past midnight.
  Nothing may silently reorder the two ends.
- The whole week is saved in a single upsert keyed on (user, weekday), so a day
  the user opened and left alone is still consistent with the rest.
- Availability is advisory, not a rule: it is shown to the opponent when they
  schedule (see §10.2) and never blocks or rejects a scheduling action.
- The unsaved-changes guard covers this section like every other field, and
  reverting or leaving without saving restores the last-saved week.

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
- Buttons depend on the match's scheduling state; see “Time agreement” below.
- Upcoming Matches table shows user’s scheduled match first, then others by earliest time.
- Notification semantics:
  - scheduling a match notifies the opponent
  - opponent can update date/time and notes and save
  - updates notify the other participant
- Next week starts when all matches of the current week are successfully submitted.

Time agreement:

- A matchup is `Unscheduled` until both players agree on a time. It is never
  `Scheduled` merely because the schedule was generated: a fresh matchup has no
  time, so it has nothing to agree to.
- The flow is: one player proposes a time, the other accepts or declines.
  - A pending proposal is stored as its own row, not as an edit to the match, so
    the history of what was offered and how it ended survives.
  - At most one proposal may be pending per match. Proposing again withdraws the
    previous one, so neither player can deadlock a matchup by both waiting.
  - The proposer cannot answer their own proposal; they may withdraw it instead.
  - Accepting sets the status to `Scheduled` and stamps the agreed time.
  - Declining clears the time and returns the matchup to `Unscheduled`.
- Proposing a new time for an already agreed match drops it back to
  `Unscheduled` until the opponent accepts, so a time can never be changed by one
  player alone.
- While a proposal is pending the match shows the proposed time, clearly marked as
  proposed, with who proposed it and who still owes an answer.
- The matchup card must state which of the three states it is in: no time agreed,
  a time awaiting the other player, or an agreed time. Showing a bare time with no
  state is what made the old `scheduled` label misleading.
- Availability is advisory and never gates this flow; see §7.5.

Match time alerts:

- A proposal, acceptance, refusal, or withdrawal raises a notification for the
  other participant, and surfaces as a count badge on the **Schedule** nav
  button on the dashboard. It is a badge, not a panel: the schedule page itself
  carries no notification list.
- The badge counts unread match-time events the member's **opponent** raised
  about the member's own matchup in the league's current week. Events the member
  caused themselves — answering a proposal, withdrawing their own — are not
  alerts, so acting on something must never make the badge go up.
- An event is only an alert if it concerns a matchup the member is actually in,
  and only while it is in the current week, so a stale event from a finished
  matchup cannot sit on the nav indefinitely.
- Opening the Schedule page clears the badge. The count is dropped from local
  state immediately and the notifications are marked read behind it, so the
  badge disappears on the click rather than after a round trip.
- The count is derived from `notifications.is_read` scoped to the recipient, and
  read state is only ever flipped by `mark_notifications_read`. `notifications`
  must not gain a client UPDATE policy.
- The dashboard's notification panel carries a **Clear all** control. It deletes
  rather than marks read, because the panel lists read rows too and marking them
  read would leave the list looking untouched. It is the only delete offered on
  `notifications`, so it confirms first with a danger tone, and the dialog names
  the scope: every notification for the selected league, not just the handful on
  screen.
- Clearing also empties the Schedule badge, because the alerts it counts are
  notifications and are removed by the same delete. Leaving the number in place
  would have it outliving the rows it was counting.
- The control is hidden rather than disabled when the list is empty, so it does
  not sit competing with the heading on a panel that already says there is
  nothing to clear.
- Withdrawing a proposal must notify the opponent, or the badge is blind to the
  one event where the question is taken away without an answer.

Weekly deadline:

- The page header states the league’s next weekly deadline, or says plainly that
  weekly deadlines are not enabled for the league.
- The deadline is read from the same source the league settings page writes, so
  the date shown here can never disagree with the one the owner configured.
- It is rendered in the reader’s own time zone, with a paused marker when the
  owner has paused the deadline.
- The header also names the zone in use, so a member who picked something
  different from their device can see why a time looks the way it does.

Time zone handling:

- Every match time on the page renders in the reader’s zone, including the
  matchup card, the upcoming matches list, the match history cards, and the
  posted game times in the History tab.
- The date/time input is labelled with the zone it is expressed in, and its value
  is converted to and from that zone rather than the browser’s.

Opponent availability:

- Opening the Schedule form for a matchup the user participates in shows the
  opponent’s availability for the week, one row per day, with a day that has no
  window reading as unavailable.
- The opponent’s windows are stored in their own zone, so they must be converted
  into the reader’s zone before display, and the panel states both the source
  zone and the zone they were converted to.
- A window that lands past midnight once converted is split at the day boundary
  rather than being rendered as a range that wraps, so every row reads as a plain
  start and end.
- A window whose local time does not exist on the sampled week (a daylight
  saving gap) is shown as stored rather than dropped.
- The form indicates whether the time currently entered falls inside the
  opponent’s availability, and says plainly when it does not. This is advice
  only: scheduling is never blocked by it.
- An opponent who has not set availability is reported as such, and is
  distinguishable from an opponent who marked every day unavailable.

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
- History tab also carries a **Match proposal history** panel, visible to the league owner only. It logs every match-time proposal made during the season, not just the one still awaiting an answer, so the owner can see the whole negotiation including offers that were declined or withdrawn. Grouped by week, newest week first; each entry shows the matchup, the time offered, who proposed it and when, who answered and when, and the proposal's notes. Every status is shown: `Accepted by`, `Declined by`, `Withdrawn by`, and `Awaiting a response` for one nobody has answered. Times render in the owner's own zone, not the proposer's.

## 11. Pokémon Page

- Show every Pokémon not currently on a team.
- Include tier list tab for the same pool.
- Search box labeled `Find Pokemon`.
- A **Sort by type** dropdown beside the search box, offering `All types` and the
  eighteen types. It sorts rather than filters: the row set never changes, the
  chosen type leads the table, and everything else follows, each group ordered by
  tier. Matching counts either half of a dual type, so a Water/Ice Pokémon surfaces
  under both. Unranked Pokémon (tier 0) sink to the bottom of their group, matching
  the tier list tab, because a missing tier is not better than a high one.
- The type order is fixed at best tier first and does not follow the table's sort
  direction. Reversing the Tier column reverses the whole table, and having the
  dropdown's grouping follow along would make the two controls contradict each
  other. Column headers still order within the chosen type.
- Each option is labelled with how many free agents carry that type, so a type the
  pool has none of is visibly empty before it is picked rather than looking like a
  control that did nothing. All eighteen are always listed, in the canonical order
  from `TYPE_LIST`, so the list does not shift as the pool changes.
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
- Never format a timestamp with a bare `toLocaleString`, `toLocaleDateString`, or `Date#getHours`. Use the shared helpers in `@/lib/datetime` with the reader's zone from `useUserTimeZone`, so every page agrees on what an instant looks like.
- Never reimplement zone conversion inline. `toZonedParts` and `zonedTimeToInstant` own the instant/wall-clock round trip, including daylight saving gaps.
- Availability is a recurring wall clock, not an instant. Convert it through the helpers in `@/lib/supabase/availability` rather than reading and shifting it by hand.
- Never label a person with `teams.team_name`; read the owner's `profiles.display_name`. See §4.5.
- Never use `window.confirm` or `window.alert`. Every confirmation goes through `useConfirm` from `@/components/confirm-dialog` so it matches the app's visual language, is keyboard-dismissible, and reads consistently.
- Confirmation copy is a short question for the title, a supporting sentence for the detail, and verb labels on the buttons. Do not pack a whole sentence into the title or end it with a period; the buttons already complete it. Anything irreversible uses `tone: "danger"`.

### 16.1 Tests

- `npm test` runs the suite once; `npm run test:watch` for a watcher; `npm run test:coverage` for a report over `src/lib`.
- The suite is Vitest, configured in `vitest.config.mts`, with tests colocated as `*.test.ts` next to the module they cover. The environment is Node; a test needing a DOM opts in per file with `@vitest-environment jsdom`.
- Target the pure logic: zone conversion, availability projection, the type chart, recurrence arithmetic, and display formatting. That is where the subtle bugs are and it is all reachable without a browser or a database.
- A module that constructs a Supabase client at import time needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` set, which the config supplies; those tests must only touch the pure helpers.
- The Supabase-backed data layers are thin query wrappers whose correctness comes from RLS and RPCs, not from unit tests. Do not chase their coverage; reach them through the RPCs instead.
- Data that is typed by hand and read by the app must be pinned in full, not sampled. The type chart is the example: it carried four wrong cells, and a wrong cell silently changes both the draft autopick's choices and what a member is shown.
- The type chart exists in two places, `public.type_chart` and the literal in `src/lib/typechart.ts`. A change to one must be made to the other in the same commit, with a migration for the table. Treat the chart as settled product data: its multipliers are pinned verbatim in `src/lib/typechart.test.ts` to catch accidental drift, so a change to a cell is a deliberate act with a test and a migration, not a cleanup.
- A failing test that turns out to be a wrong expectation is still worth keeping in corrected form: it is the only thing stopping the same misreading being written again.

### 16.2 Real-time updates

- Realtime is a staleness signal, never a data source. An event triggers the same scoped refetch the page already runs on mount, so there is one load path rather than two that have to agree.
- Only `matches`, `notifications`, and `match_scheduling_proposals` are published. Everything else changes once at the draft or never, and publishing it would cost a broadcast per write for no benefit.
- Go through `useRealtimeInvalidation`, never a raw `supabase.channel`. It coalesces a burst into one refetch, reads its callbacks through a ref so a new closure identity does not resubscribe, and exposes `flush` for deferred work.
- Always pass `isPaused` on a page with forms. A refetch replaces the data, re-derives the selected matchup, and can throw away what someone is typing; a change that arrives mid-edit is held and applied when the form closes.
- Subscribe to the narrowest table that covers the change. A notification that only moves a badge must not trigger a reload that pages the whole draft pool.


## 17. Final Project Decision

This product must be treated as a domain-heavy application where an incorrect rule is worse than a missing feature. Therefore, all critical decisions should be enforced in the database and auth layer whenever possible, and every requirement in this document should be interpreted as a system invariant rather than a loose UX suggestion.
