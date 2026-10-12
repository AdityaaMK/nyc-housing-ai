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
