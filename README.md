# NYC Housing AI Agent & Real-Time Monitoring Copilot

An intelligent, autonomous system built to solve the high-friction, hyper-competitive NYC rental housing search. It monitors listings in real time across StreetEasy, Compass, RentHop, and broker feeds, uses AI to filter out bad deals / red flags, and automates fast outreach to ensure you are first in line for tours.

---

## 🎯 Key Problems Solved

1. **Sub-Minute Detection**: Beat the crowd to newly posted units (especially during peak summer months) using instant email ingestion webhooks and stealth scrapers.
2. **AI Listing Analysis**:
   - Detects hidden broker fees and calculates lease-average rent after concessions.
   - Flags undesirable layouts (e.g. railroad bedrooms, windowless interior rooms, walk-ups > 4th floor).
   - Computes realistic door-to-door transit times to key subway stations / office hubs.
3. **Automated Tenant Outreach**:
   - Prepares a ready-to-go "Tenant Resume" (40x income, 750+ credit score, guarantor status, pet profile, move-in window).
   - Generates and dispatches professional intro inquiries within seconds of a listing dropping.
4. **Inbound Reply & Tour Coordinator**:
   - Parses broker replies, extracts available viewing slots, and schedules tours directly on your calendar.

---

## 📂 Project Structure

```
nyc-housing-ai/
├── README.md               # Project overview and quick start
├── docs/
│   ├── architecture.md     # In-depth system design & data flows
│   └── roadmap.md          # Phased development milestones
├── src/                    # Application source code
│   ├── ingestion/          # Scrapers, email webhooks, RSS monitors
│   ├── ai/                 # LLM evaluation, scoring, parsing prompts
│   ├── outreach/           # Automated message generator & dispatchers
│   └── bot/                # Telegram / SMS mobile notification bot
```

## Local setup and verification

Use Node.js 24 or later. Install the backend and dashboard dependencies with `npm ci` and `npm ci --prefix web`. If SQLite's native binding is missing, run `npm rebuild sqlite3` with install scripts enabled.

Configure `.env` with `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GMAIL_USER`, and `GMAIL_APP_PASSWORD` for the connected workflow. Never commit this file. `DATABASE_URL` selects PostgreSQL; without it the app uses local SQLite (`listings.db`, or `SQLITE_PATH`). An unreachable configured PostgreSQL database now fails visibly rather than switching silently to a separate local database.

- `npm test`: isolated SQLite integration tests, including ingestion, scoring, notification retry, inbound tour handling, HTTP endpoints, and simulated email dispatch. The suite uses temporary databases and simulated external services; it needs permission to listen on a local HTTP port.
- `npm run build --prefix web`: build the dashboard.
- `npm run lint --prefix web`: check dashboard source.
- `npm run dashboard`: start the API and development dashboard.

The development dashboard uses `http://localhost:3001` by default. The API serves the built dashboard at its root, with same-origin API requests; set `VITE_API_URL` at build time for another API origin. The daemon (`npm start` or `npm run daemon`) performs live external operations and requires the configured services.

Unknown building health is displayed as unverified. Failed AI evaluations enter the durable retry queue, failed notifications remain eligible for retry, and tours without a precise date/time do not receive an invented calendar time. Historical tours need a `proposed_datetime` value before a calendar link can be offered. Conservative apartment deduplication requires a house number and unit; listings with incomplete addresses may appear separately.

## Saved search locations

Search settings now live in the shared database and can be edited in the dashboard. `src/search_preferences.json` seeds location defaults once. The defaults include Lower East Side, Financial District, East Village, Hell's Kitchen, and Williamsburg. Listings in Queens, Brooklyn (including Williamsburg), Jersey City, and Hoboken qualify only with an estimated public-transit commute of at most 20 minutes from the apartment to any Manhattan arrival station, including walking, typical waits, and transfers. This remains separate from the editable office destination and commute limit.

The evaluator stores a separate Manhattan-arrival time, station, and route. Unknown/missing estimates or routes fail the regional preference check, including older listings until they are re-evaluated. The cutoff is enforced after score bonuses, again before notifications, and in the dashboard's saved-search filter. Location and commute extraction still use AI estimates, not independently verified geocoding or live transit routing.

Scrapers collect regional candidates; the evaluator verifies their borough/city, and alerts enforce saved locations, room requirements, budgets, and commute rules. The dashboard defaults to saved search areas and remembers its display filter independently. Historical listings are retained under All collected listings. StreetEasy and Compass cover all five regions; RentHop covers Manhattan, Brooklyn, Queens, and Jersey City. Unknown locations cannot trigger an alert. NYC building-health checks use the actual borough; New Jersey health stays unverified.

Restart the API and any enabled workers after installing the schema and code. Subsequent dashboard settings changes take effect on the next request or worker cycle. Scores from earlier preference revisions are labeled outdated and enter the existing scoring queue in bounded batches. Existing delivery receipts are preserved.

## Apartment selection and tour workspace

The dashboard now includes all ten features in the [implementation roadmap](docs/roadmap.md): source freshness and availability, rent history and change alerts, worker health, editable search settings, watchlists and comparison, housing costs, conversation history, tour scheduling and reminders, tour-day routing, and post-tour reviews with decision history.

Set `HOUSING_OWNER_TOKEN` to a random secret of at least 24 characters, then unlock owner access in the dashboard. Listings, search settings, source evidence, and sanitized health remain readable; private conversations, schedules, notes, comparisons, and all mutations require owner access. The token stays in page memory. Existing status changes, broker confirmation, and paid Google lookups also require this token.

SQLite installs the additive feature schema during startup. PostgreSQL/Supabase upgrades need migration `003_product_features.sql` after the existing scoring and commute migrations. See [feature setup, migration, behavior, and verification](docs/product-features.md). Installing this code does not start workers or send messages.

## Durable scoring worker

Scoring runs independently from scraping, alerts, and outreach:

- `npm run evaluate -- --limit 10`: finite run, at most 10 distinct listings and 10 Gemini calls.
- `npm run evaluate -- --limit 10 --no-retries`: finite trial; selects only listings with zero previous attempts.
- `npm run evaluate:worker`: continuous scoring, explicitly started by the operator. No worker is automatically installed or enabled.

Both entrypoints, and the existing daemon evaluator, share the database queue. Passed and already scored listings are excluded. Each listing has up to three attempts with one-minute and five-minute retry delays. Five-minute claims prevent concurrent/stale writes; expired claims are recovered as interrupted attempts. Requests are spaced by at least five seconds across workers. The continuous worker polls every 30 seconds. A shared, persistent rate-limit pause lasts at least five minutes, honors longer provider instructions, and does not consume listing attempts. Missing credentials fail before claiming; provider authentication/model errors release the claim and stop the run.

Set `GEMINI_API_KEY`; optionally override the unchanged `gemini-flash-lite-latest` default with `GEMINI_MODEL`. Navigation is limited to 30 seconds, Gemini to 60 seconds, and an attempt to two minutes. SIGINT/SIGTERM cancel outstanding work and release the current claim. No immediate AI retries occur. Public errors are fixed summaries, never provider messages. `evaluation_control` stores shared request timing and has RLS enabled in PostgreSQL.

The additive migration runs during database initialization and can be applied separately with `node scripts/migrate-scoring.js <private-backup-directory>`. Before a production upgrade, run `node scripts/backup-scoring.js` to save listings, tours, public-schema catalog metadata, table DDL, and a checksum in a private directory under `~/.local/state/nyc-housing-ai/backups/`. The migration command requires that backup, executes transactionally, and verifies every pre-existing non-queue listing field is unchanged. Historical evaluated listings are marked completed; their completion timestamp records the backfill time because their original evaluation time is unknown. Their scores, location flags, application status, and notification flags are retained.

`GET /api/stats` includes `evaluation: { pending, processing, completed, retry_wait, failed }`. Listing responses include status, attempt count, retry eligibility, completion time, and sanitized errors, and exclude claim tokens and lease expiry. The dashboard shows these states and refreshes every 15 seconds while visible, keeping its last successful snapshot on refresh failures. Commute values are labeled AI estimates.

Additional checks:

- `node --test test/evaluation.test.js test/evaluation-api.test.js`: isolated SQLite queue and API checks.
- `QUEUE_TEST_DATABASE_URL=postgres://user@127.0.0.1:55439/postgres node scripts/test-queue-postgres.js`: the same queue tests in a disposable local PostgreSQL instance. The test creates and removes a unique schema and refuses remote URLs.
- `node scripts/test-dashboard.js`: browser checks with fixture API responses and a temporary local Vite server; requires permission to launch Chromium and listen locally.

Live rollout intentionally leaves continuous scoring disabled. The existing scraper continues independently. No notification, outreach, or SQLite import is performed by the scoring commands.

The independent scraper is available with `npm run scrape:worker` (a cycle followed by a 180-second wait). It imports neither the evaluator nor messaging code.

The October 12, 2026 rollout applied the queue migration and completed a finite trial: 10 distinct listings, 10 Gemini requests, 10 saved scores, and no retries. All 2,344 scores present immediately before migration, along with application and notification fields, were verified unchanged. Saved-location enforcement passed for all trial results. Private description/result audits live beside the private backup. Continuous scoring remains disabled; the API and independent scraper are running. The saved runtime configuration now contains only the API and independent scraper. Startup recovery honors that saved configuration; it does not enable continuous scoring. The prior process and startup configurations are backed up privately.

Budget checks use net effective rent over the initial lease: `(gross rent × (lease months − free months) − additional rent credits) ÷ lease months`, rounded to cents. Legitimate free-month concessions do not lower the score. The model extracts lease terms; code validates them and computes the average. Incomplete concession terms leave the average unverified and use gross rent for the budget check until terms are known. The dashboard shows calculated net effective rent and gross monthly payments separately; historical prices without extracted terms remain labeled advertised. Existing scores are preserved. For example, $5,225 gross with two months free over 18 months is $4,644.44 effective and fits the $5,000 budget.

Commute routes remain unverified AI estimates, and listing pages can change prices between collection and evaluation. No additional scoring requests were made to investigate these findings.

Listing cards with a usable street address and known borough/city provide a “Check office commute in Google Maps” transit link. It uses the saved office destination, initially seeded from `TARGET_COMMUTE_ADDRESS` (default: 620 8th Avenue, New York), and requires no Maps API key. Confirm the origin and set a weekday arrival time in Maps. Opening the link does not automatically verify the saved AI estimate or change the listing's score. The optional **Get Google commute** button requests a Google Maps transit estimate arriving at 9:00 AM next weekday, only when clicked. It requires a private `GOOGLE_MAPS_API_KEY`, keeps results in page memory, and caps attempted requests at 300 per New York day and 9,000 per rolling 32 days. Saved scores and AI estimates stay unchanged. See [setup, migration, usage controls and tests](docs/google-commute.md).

## HTTPS cloud backends

For Supabase REST and Gmail API setup, local OAuth authorization, read-only diagnostics, migration, and rollback, see [the cloud HTTPS guide](docs/cloud-https.md). Existing backend defaults and continuous monitoring are unchanged.

## Persistent Telegram worker

`npm run telegram:start` launches the independent, supervised `housing-telegram` worker; `npm run telegram:status` checks its persistent heartbeat and delivery journal. It handles Telegram buttons and new listing alerts, summarizes the initial backlog once, and recovers from polling failures and process crashes. Use one deployment with persistent storage. See [Telegram setup, recovery, and host requirements](docs/telegram-worker.md) before enabling it alongside existing processes.

`npm run inbox:start` launches the independent `housing-inbox` worker for broker replies, tour proposals, and follow-up prompts. It saves progress and queues alerts while Telegram is stopped; the existing Telegram worker delivers them when available. `npm run inbox:status` reports inbox health and queued work. See [Inbox setup, shared state, and recovery](docs/inbox-worker.md). This replaces the old combined daemon's inbox/nudge scans for that mailbox.

## macOS automatic startup and wake recovery

Start the desired housing processes, save their configuration, then install the user LaunchAgent:

```sh
npm run daemon
npx pm2 save
npm run startup:install
```

If the services are already running, use `npx pm2 save` and `npm run startup:install`. The installer captures the current Node executable and uses absolute paths, so startup does not depend on shell initialization or NVM being loaded. Re-run it if that Node installation is moved or removed. `node scripts/macos/install.cjs --print` previews the generated plist without changing macOS settings.

After a reboot, services start when the user logs in. A calendar check runs every minute and after a missed interval during sleep; scraping remains paused while the Mac is asleep. The check reads the current PM2 saved list and restores only saved `housing-daemon`, `housing-scraper`, and `housing-api` services. It preserves their checkout, environment, and Node interpreter and leaves healthy processes running. Removed services are not recreated, and services deliberately stopped and then saved remain stopped. See [Apple's launchd scheduling documentation](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html) for wake behavior.

Use `npm run startup:remove` to disable automatic recovery; existing services keep running until stopped separately. To keep one service stopped, run `npx pm2 stop NAME` followed by `npx pm2 save`. Recovery logs live under `$PM2_HOME/logs/housing-autostart-{out,error}.log` (`~/.pm2/logs` by default). Keep `.env`, databases, and PM2 dump files out of version control.
