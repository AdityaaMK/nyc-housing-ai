# Apartment selection and tour workspace

All ten features in the October 16 implementation plan are available in the API and dashboard. Recurring collection, scoring, inbox processing, and Telegram delivery remain in their existing workers. Opening the dashboard does not start those workers.

## Setup and migration

Use Node.js 24 or later. Install dependencies with `npm ci` and `npm ci --prefix web`, then build with `npm run build --prefix web`.

Set a random `HOUSING_OWNER_TOKEN` of at least 24 characters in the server environment. Enter it using **Unlock owner access** in the dashboard. Never put it in a `VITE_` variable. The browser stores it only in memory and sends it in an `Authorization: Bearer …` header; reloading requires unlocking again. Use HTTPS for a remotely accessible dashboard. Unconfigured owner endpoints return 503, and missing or incorrect credentials return 401.

Listings, source observations, search preferences, statistics, and sanitized worker health remain readable without owner access. Private selections, costs, conversation summaries, tour details, reviews, and decisions require owner access, as do all edits, rechecks, broker confirmations, and paid route requests. Legacy tour reads and status/commute actions follow the same rules.

Feature data is stored in `feature_records`, keyed by collection and record ID, with optimistic revisions. Concurrent edits return 409 instead of silently replacing a newer record. SQLite creates this additive table during initialization. Existing listing scores, application states, tour records, and notification flags remain intact.

For PostgreSQL or Supabase, install the existing scoring and commute schemas before `migrations/003_product_features.sql`. A direct PostgreSQL upgrade can use:

```sh
node scripts/backup-scoring.js
npm run db:migrate:features -- /private/path/to/verified-backup
```

The migration runner checks the backup, writes a private before-migration snapshot, applies the SQL transactionally, and checks that existing data is unchanged. The SQL also installs the Supabase RPCs for atomic record updates and evaluation requeueing. If using the Supabase SQL editor instead, take a verified backup first and execute the migration there. Keep service credentials server-side; the table uses RLS and its RPCs are available only to the service role. Restart the API and whichever workers are already enabled after upgrading. No production migration or worker activation is performed by the test commands below.

## Feature behavior

| Feature | Where it appears | Behavior |
| --- | --- | --- |
| Freshness and availability | Listing cards and details | Source-specific observations and evidence; old records begin unverified. A failed or empty search does not establish that an apartment is unavailable. |
| Rent and concession history | Listing details and Telegram queue | Immutable observations separate advertised, gross, and effective rent. Current saved-search or watchlist drops use durable event IDs and are rechecked immediately before dispatch. |
| Worker and source health | Health view | Heartbeats, last successful work, queue counts, and sanitized failures for scraper, scorer, inbox, and Telegram; source scans distinguish empty, blocked, partial, and parser failures. |
| Editable search | Settings | Versioned budgets, room requirements, locations, Manhattan-arrival limit, office destination, and optional office limit, with a saved-listing preview. |
| Watchlist and comparison | Save actions and comparison view | Persistent selections independent of pipeline status; compare up to four apartments, including current costs, evidence, and user reviews. Telegram also supports Save/Unsave. |
| Housing cost calculator | Listing details and comparison | Editable rent assumptions and sourced expenses; separate monthly outlay, nonrefundable lease expense, and upfront cash. Unknown expenses remain unknown. |
| Broker conversations | Listing details and unassigned replies | Durable outbound outcomes and inbound summaries. Thread IDs and reply headers identify the listing; ambiguous messages can be assigned manually. |
| Tour scheduling | Tours workspace | Explicit dates, duration, buffers, overlap detection, statuses, calendar downloads, and revision-aware reminders. Scheduling edits are local; broker confirmation is a separate explicit action. |
| Tour-day routes | Tours workspace | Two to six appointments, a starting address, walking/transit legs, departure times, buffers, and unresolved or incompatible stops. Lookups occur only after Plan is clicked. |
| Post-tour reviews and decisions | Listing details and decision view | Checklist, notes, ratings, observed strengths/issues, and reasons linked to completed tours. User observations are separate from the AI score. |

### Freshness, scoring, and alerts

Rechecks accept only supported HTTPS listing URLs, reject redirects, and use a 12-second timeout and a 1.5 MB response limit. Manual requests have a 60-second cooldown. Background collection checks at most three tracked apartments per cycle, at most three source URLs per apartment, with a six-hour cooldown. Source observations older than three days are unverified. One recently active cross-post can keep an apartment active while showing contradictory evidence from another source.

Price changes mark the prior assessment outdated and request re-evaluation through the existing claim/retry queue. Preference changes similarly enqueue at most three old scores per scorer loop. Outdated scores cannot generate normal new-match alerts. Price alerts use current observed terms, retain their source URL, and cancel if the relevant source is unavailable, the snapshot was superseded, or the apartment was passed. Changing advertised gross pricing to incomplete net pricing is not a verified gross-rent drop. First observations establish a baseline without creating historical alerts.

Settings are loaded from the database at request/cycle boundaries; the JSON file only seeds initial locations. Updating settings does not reset application state or prior notification receipts. The office commute and Manhattan-arrival rule remain separate. AI commute estimates remain labeled as estimates. An on-demand Google result includes its retrieval time and is retained only in the current page session.

### Costs, conversations, and decisions

Refundable deposits count toward move-in cash but not nonrefundable lease expense. First-month rent is part of the lease cost once, even when due upfront. Annual charges require an explicit prorated/whole-year assumption. Free months and rent credits apply once. Each expense records whether its amount is confirmed, assumed, or unknown; confirmed amounts require a source. A changed rent snapshot marks saved cost assumptions for review; user-entered assumptions are preserved.

Outgoing mail records distinguish sent, failed, and uncertain outcomes. An uncertain delivery is held for review rather than automatically replayed. A reply conclusively tied to apartment A suppresses A's follow-up without suppressing apartment B merely because the broker is the same. Ambiguous mail remains unassigned and conservatively suppresses follow-ups until resolved. Message summaries and metadata are private; the dashboard does not expose credentials or raw transport errors.

The decision actions **Request information** and **Apply** record intentions locally. They do not send email. **Pass** records the reason and updates pipeline status; **Shortlist** saves the apartment. Tour and conversation histories remain available. A post-tour review requires a linked completed tour, and unanswered checklist items remain unset.

### Schedules, routes, and delivery

Schedules use America/New_York. Unknown times require an explicit choice; nonexistent daylight-saving times are rejected and ambiguous times require a specific offset. Calendar exports include the current schedule revision. Changing or cancelling a tour invalidates older reminder events, and delivery checks the current revision and due time again before sending. A broker confirmation uses the current schedule shown in the confirmation preview and rejects an obsolete revision.

Tour routes use the existing private `GOOGLE_MAPS_API_KEY` with Routes API access and the same persistent quota as office-commute lookups: 300 attempted calls per New York day and 9,000 per rolling 32 days. A plan makes at most six paid attempts, each bounded to 15 seconds, and caches successful legs for 15 minutes. Requests use durable leases to avoid concurrent duplicate lookups and cache failures briefly. Configuration errors and rate limits pause calls through the shared allowance. The cloud network policy must allow `routes.googleapis.com` for live lookups. No key or reachable provider produces unresolved legs, never an invented zero-minute route. Appointment order is fixed by schedule; this is a feasibility planner, not an optimization guarantee.

Price changes and tour reminders enter the shared event store, then transfer idempotently to the Telegram worker's local delivery journal. Keep that journal on persistent storage. Inbox and Telegram must share the configured inbox state directory, and only one deployment may poll the bot. Confirmed sends survive receipt-reconciliation failures; ambiguous sends remain held for review. See [Telegram recovery](telegram-worker.md) and [inbox recovery](inbox-worker.md). This implementation leaves Telegram activation to the existing deployment decision.

Worker heartbeats become stale after 60 seconds; source scans become stale after 15 minutes. The health view retains the latest 30 sanitized operation records per worker. The API compares shared heartbeats with local worker journals and uses the newer evidence. A suspended cloud host cannot serve a health page until it resumes; a 24/7 host or external monitoring remains a separate deployment choice.

## API entry points

| Area | Endpoints |
| --- | --- |
| Owner access | `GET /api/owner/session` |
| Evidence | `GET /api/listings/:id/insights`, `POST /api/listings/:id/recheck` |
| Settings and health | `GET/PUT /api/preferences`, `POST /api/preferences/preview`, `GET /api/health` |
| Selection | `GET /api/watchlist`, `PUT /api/watchlist/:id`, `GET /api/compare?ids=a,b` |
| Costs and reviews | `GET/PUT /api/listings/:id/costs`, `GET/PUT /api/listings/:id/review` |
| Decisions | `POST /api/listings/:id/decision`, `GET /api/decisions` |
| Conversations | `GET /api/listings/:id/conversation`, `GET /api/conversations/unassigned`, `PUT /api/conversations/:messageId/assignment` |
| Tours | `GET /api/schedule`, `GET/PUT /api/tours/:id/schedule`, `GET /api/tours/:id/calendar.ics`, `POST /api/tours/:id/confirm` |
| Routes | `POST /api/itineraries/plan` |

Use the revision returned by editable resources on subsequent saves. Recheck and plan operations are explicit requests; ordinary refreshes never consume Google routing quota.

## Verification

```sh
npm test
npm run build --prefix web
npm run lint --prefix web
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node scripts/test-product-dashboard.js
node scripts/test-telegram-recovery.js
node scripts/test-inbox-recovery.js
```

The browser test uses fixture responses and exercises all ten features, owner-token handling, daylight-saving inputs, and a mobile viewport. API/service tests use temporary SQLite databases and mocked external services. Recovery tests use isolated PM2 state, kill/restart fixture workers, and verify durable progress and graceful shutdown. They do not send live messages or make paid API calls.

`PRODUCT_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:PORT/postgres node scripts/test-product-postgres.js` verifies the migration and repository behavior in a disposable local PostgreSQL instance. It refuses remote hosts and creates/removes its own temporary database. Coverage includes repeated migration, preservation of existing records, RLS/grants, concurrent revisions, event replay, pagination, and SQL/Supabase serialization parity. The Supabase transport is bridged to local SQL for this test; production PostgREST connectivity is a deployment check.
