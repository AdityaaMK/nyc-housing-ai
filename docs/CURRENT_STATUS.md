# NYC Housing AI Copilot: Project Status & Progress Log

**Last Updated:** September 13, 2026  
**System Status:** 🟢 Active / Running in Daemon Mode under PM2 (`housing-daemon`)

---

## 🚀 Executive Summary

The **NYC Housing AI Copilot** is a fully autonomous real estate monitoring, intelligence, and outreach engine engineered to give apartment seekers an unfair competitive advantage in the hyper-competitive NYC rental market.

Today, the project advanced from a basic scraper to a **fully integrated, end-to-end autonomous agent** capable of:
1. Multi-source ingestion across **StreetEasy** and **RentHop** with address deduplication.
2. AI-powered evaluation using **Gemini Flash Lite** (calculating true gross rent, fee estimates, door-to-door commute to Datadog 620 8th Ave, pros, and red flags).
3. Live building health verification against **official NYC Open Data** (HPD Violations dataset `wvxf-dwi5` and 311 Complaints dataset `erm2-nwe9`).
4. Real-time **Telegram mobile alerts** with 1-tap interactive inline action buttons.
5. **Direct broker email dispatch** via authenticated Gmail SMTP (`adityaa.magesh@gmail.com`) to bypass anti-bot web barriers.
6. **Inbound tour reply detection** via IMAP with automatic 1-click **Google Calendar** link generation and automated broker tour confirmation.

---

## 🛠️ Key Progress Completed Today

### 1. Direct Broker Email Dispatch (`src/mailer.js`, `src/auto_inquire.js`)
- **Problem**: StreetEasy actively blocks headless browser form submissions with PerimeterX human-verification challenges ("Press & Hold") and obscures broker emails behind account logins.
- **Solution**:
  - Implemented automated agent contact extraction for public emails (e.g. Compass, Corcoran, Elliman).
  - Integrated `nodemailer` with Gmail SMTP and App Password authentication.
  - Automatically sends personalized tenant intro packets (800+ credit score, 40x income, clean paperwork) directly from `adityaa.magesh@gmail.com` with BCC to self for audit trails.
  - Falls back to 1-tap mobile copy draft if direct email is unavailable.

### 2. NYC Open Data Building Health & HPD Violations (`src/building_health.js`)
- **Integration**: Direct REST/Socrata queries against NYC Open Data API (no rate limit tokens required for standard polling).
- **Datasets Monitored**:
  - **HPD Housing Maintenance Violations** (`wvxf-dwi5`): Queries active, open **Class C** (immediately hazardous: lead paint, mold, vermin, severe structural hazards). Excludes administrative notices like annual bedbug filings.
  - **NYC 311 Service Requests** (`erm2-nwe9`): Inspects the last 12 months for repeated **heat/hot water outages** and tenant-reported bedbug infestations.
- **Scoring Adjustment**:
  - **Grade A (Clean)**: +5 point bonus added to suitability score.
  - **Grade B (Moderate)**: -5 point penalty.
  - **Grade C (Hazardous)**: -20 point penalty and ⚠️ warning flag.
- **Telegram & DB Integration**: Building health grade, summary, and violation counts are saved in the `listings` table and rendered in Telegram mobile alerts.

### 3. Inbound Tour Detector & Google Calendar Booker (`src/inbound_listener.js`)
- **IMAP Listener**: Connects securely to `imap.gmail.com:993` to monitor unseen broker replies in real time.
- **Smart Filtering & Sanitization**: Filters out marketing emails, newsletters, and social notifications. Strips HTML tags and limits tokens to prevent LLM quota exhaustion.
- **Gemini Tour Extraction**: Uses `gemini-flash-lite-latest` to parse broker responses into structured JSON (proposed showing date/time, apartment address, broker name, access notes).
- **1-Click Google Calendar Link**: Automatically generates pre-filled `calendar.google.com` links with title, 45-minute tour block, location, and buzzer instructions.
- **1-Tap Tour Confirmation**: Tapping `[✅ Confirm Tour with Broker]` on Telegram automatically dispatches an acceptance confirmation to the broker and notifies the user.

### 4. Commute & Transit Route Calculator (`src/evaluator.js`)
- Evaluates morning door-to-door transit time specifically to **Datadog Office** (620 8th Ave, NYT Building, Manhattan).
- Computes walking time to nearest subway lines (A/C/E/1/2/3/7/N/Q/R/W) and total transit duration.
- Listings with commutes exceeding 40 minutes receive automatic red flags.

### 5. Multi-Source Ingestion & Cross-Platform Matching (`src/scraper.js`, `src/renthop.js`, `src/normalizer.js`)
- Ingests feeds from both **StreetEasy** and **RentHop**.
- Standardizes addresses using alphanumeric building normalization to match cross-posted units across portals, merging duplicate listings into a single enriched record.

### 6. Background Daemon & Process Management (`ecosystem.config.js`)
- Configured PM2 process supervisor (`housing-daemon`) running 24/7 with automatic restart on failure and graceful signal handling (`SIGINT`/`SIGTERM`).
- Automated 3-minute polling cycles covering scraping, evaluation, notifications, and inbox checks.

---

## 📊 System Architecture & Data Flow

```text
[ StreetEasy / RentHop ]
           │
           ▼
   [ Stealth Scraper ] ───▶ [ Address Normalizer & Deduplication ]
                                            │
                                            ▼
                               [ Listings DB (Postgres / SQLite) ]
                                            │
           ┌────────────────────────────────┴──────────────────────────────┐
           ▼                                                               ▼
[ AI Evaluator (Gemini) ]                                   [ NYC Open Data (Socrata) ]
  • True gross rent calculation                               • HPD Class C violations
  • Commute to 620 8th Ave                                    • 311 Heat & bedbug outages
  • Red flags & pros                                          • Health Grade (A/B/C)
           │                                                               │
           └────────────────────────────────┬──────────────────────────────┘
                                            ▼
                                [ Suitability Score (0-100) ]
                                            │ (Score >= 75)
                                            ▼
                             [ Telegram Interactive Bot ]
                               • View Listing button
                               • Send Intro Packet button
                               • Pass button
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
          [ Direct Broker Email ]                     [ Inbound Reply Listener ]
          • Authenticated Gmail SMTP                  • Gmail IMAP Poller
          • BCC to user                               • Gemini Tour Parser
                                                      • Google Calendar 1-Click
                                                      • 1-Tap Broker Confirmation
```

---

## 📁 Repository Structure

```
nyc-housing-ai/
├── ecosystem.config.js       # PM2 process manager configuration
├── package.json              # Project dependencies and operational scripts
├── .env                      # Environment secrets (ignored in git)
├── docs/
│   ├── CURRENT_STATUS.md     # Current system state and progress log (this file)
│   ├── architecture.md       # Architectural deep-dive
│   ├── roadmap.md            # Feature roadmap and milestones
│   └── technical_design.md   # Technical implementation details
└── src/
    ├── index.js              # Daemon coordinator running the 4-step cycle
    ├── scraper.js            # StreetEasy stealth scraper
    ├── renthop.js            # RentHop feed scraper
    ├── normalizer.js         # Address parser and cross-source deduplicator
    ├── evaluator.js          # Gemini listing analyzer & score calculator
    ├── building_health.js    # Socrata NYC Open Data HPD & 311 client
    ├── notifier.js           # Telegram push alert formatter
    ├── bot.js                # Telegram interactive callback query handler
    ├── mailer.js             # Nodemailer Gmail SMTP direct dispatch engine
    ├── auto_inquire.js       # Portal form / direct email broker dispatcher
    ├── inbound_listener.js   # Gmail IMAP tour parser & Google Calendar generator
    ├── db.js                 # PostgreSQL & SQLite dual database abstraction
    └── test_features.js      # CLI test suite for health and tour booking
```

---

## ⚙️ Configuration & Environment Variables

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token from `@BotFather` | `771...` |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID for real-time mobile notifications | `875...` |
| `GEMINI_API_KEY` | Google AI Studio API key | `AIza...` |
| `GMAIL_USER` | Gmail address used for sending and receiving broker emails | `adityaa.magesh@gmail.com` |
| `GMAIL_APP_PASSWORD` | 16-character Google App Password | `dxpf...` |
| `TARGET_COMMUTE_ADDRESS` | Office destination for commute calculation | `Datadog Office (620 8th Ave, NYT Building, NYC)` |
| `TENANT_NAME` | Renter's full name for inquiry packets | `Adityaa Magesh Kumar` |
| `TENANT_CREDIT` | Credit score highlight | `800+` |
| `TENANT_INCOME` | Income qualification statement | `Verified 40x+ rent` |
| `TENANT_PHONE` | Direct phone number for broker contact | `732-309-5089` |
| `CYCLE_INTERVAL_SECONDS` | Polling frequency in seconds | `180` (3 minutes) |
| `DAEMON_MODE` | Continuous background polling flag | `true` |

---

## 🧪 Testing the New Features

### 1. Test NYC Open Data Building Health Check:
```bash
node src/test_features.js health
```

### 2. Test Inbound Tour Alert & Google Calendar Booker:
```bash
node src/test_features.js tour
```
*Dispatches a test tour alert directly to your Telegram with interactive `[Add to Google Calendar]` and `[Confirm Tour with Broker]` buttons.*

---

## 🎯 Next Steps / Future Roadmap
1. **Compass Scraper Feed**: Add direct ingestion of Compass-exclusive listings.
2. **Web Dashboard Enhancement**: Add building health badges and tour schedule calendar view to the Next.js frontend (`web/`).
3. **SMS Fallback (Twilio)**: Option to receive urgent showings via SMS when away from Telegram.
