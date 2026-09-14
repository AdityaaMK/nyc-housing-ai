# Development Roadmap

### Phase 1: Ingestion & Multi-Source Listing Monitor
- [x] Multi-source stealth scrapers (StreetEasy & RentHop)
- [x] Local SQLite and Supabase PostgreSQL dual database support
- [x] Address normalization and cross-platform deduplication engine
- [x] Configurable search feeds (2B2B $1,800-$5,000, 1B/Studio $1,800-$2,700, Manhattan)

### Phase 2: AI Evaluator & Scoring Engine
- [x] Gemini Flash Lite prompt pipeline for listing assessment
- [x] Net-effective vs true gross rent calculator
- [x] Transit & door-to-door commute calculator specifically to Datadog (620 8th Ave)
- [x] Automated pros & red flags extraction (railroad layouts, walk-ups, hidden broker fees)
- [x] NYC Open Data integration (HPD Violations `wvxf-dwi5` & 311 Complaints `erm2-nwe9`)
- [x] Building Health scoring (+5 Grade A, -5 Grade B, -20 Grade C)

### Phase 3: Mobile Bot & Real-Time Alerts
- [x] Telegram Bot with instant push alerts for high-scoring listings (score >= 75)
- [x] Interactive inline action buttons (View Listing, Send Intro Packet, Pass)
- [x] Instant Tenant Resume generator (Adityaa Magesh Kumar, 800+ credit, 40x income, clean paperwork)
- [x] HTML entity sanitization and rich metadata cards

### Phase 4: Outreach Automation & Inbound Tour Coordinator
- [x] Direct broker email dispatch via Gmail SMTP (`adityaa.magesh@gmail.com`)
- [x] Public broker contact discovery and automatic BCC audit trail
- [x] Inbound reply listener via Gmail IMAP with automated spam/newsletter filtering
- [x] Gemini AI tour proposal extractor (date, time, access notes, broker details)
- [x] 1-Click Google Calendar URL generator
- [x] 1-Tap tour confirmation back to broker via Telegram

### Phase 5: Future Enhancements
- [ ] Compass-exclusive direct listing feed
- [ ] Web dashboard calendar & building health badges (`web/`)
- [ ] SMS fallback notification option via Twilio
