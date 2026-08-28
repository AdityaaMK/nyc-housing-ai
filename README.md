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
