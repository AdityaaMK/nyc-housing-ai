# NYC Housing AI Agent & Real-Time Monitoring Copilot

An intelligent, autonomous system built to solve the high-friction, hyper-competitive NYC rental housing search. It monitors listings in real time across StreetEasy, Compass, RentHop, and broker feeds, uses AI to filter out bad deals / red flags, and automates fast outreach to ensure you are first in line for tours.

---

## 🎯 Key Problems Solved

1. **Sub-Minute Detection**: Beat the crowd to newly posted units (especially during peak summer months) using instant email ingestion webhooks and stealth scrapers.
2. **AI Listing Analysis**:
   - Detects hidden broker fees & net-effective rent traps.
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

The dashboard uses `http://localhost:3001` by default; set `VITE_API_URL` at build time for another API origin. The daemon (`npm start` or `npm run daemon`) performs live external operations and requires the configured services.

Unknown building health is displayed as unverified. Failed AI evaluations remain pending, failed notifications remain eligible for retry, and tours without a precise date/time do not receive an invented calendar time. Historical tours need a `proposed_datetime` value before a calendar link can be offered. Conservative apartment deduplication requires a house number and unit; listings with incomplete addresses may appear separately.

## Saved search locations

`src/search_preferences.json` is the durable source of truth for location preferences, loaded each cycle/request and included in Docker images with `src/`. Preferred neighborhoods: Lower East Side, Financial District, East Village, Hell's Kitchen, and Williamsburg. Also included borough/city-wide: Queens, Brooklyn, Jersey City, and Hoboken.

Scrapers collect regional candidates; the evaluator verifies their borough/city, and alerts enforce the saved locations regardless of score bonuses. The dashboard defaults to saved search areas and remembers its display filter independently. Historical listings are retained under All collected listings. Budgets and the commute destination are unchanged. StreetEasy and Compass cover all five regions; RentHop covers Manhattan, Brooklyn, Queens, and Jersey City. Unknown locations cannot trigger an alert. NYC building-health checks use the actual borough; New Jersey health stays unverified.

Restart the daemon and API once after installing this code. Subsequent edits to the preference JSON are read without a restart. Previously processed listings are not automatically re-notified.

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
