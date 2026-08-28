# System Architecture: NYC Housing AI

## 1. Ingestion Layer
- **StreetEasy Instant Email Ingestion**: Zero-ban webhook receiving instant alert emails, parsing listing URLs in <1s.
- **Stealth Scraper / Poller**: Playwright / Puppeteer with stealth headers polling newest listings sorted by date.
- **Multi-Source Aggregator**: Ingesting from RentHop, Compass, and Leasebreak.

## 2. Storage & Deduplication
- Local SQLite / PostgreSQL database storing `listings`, `inquiries`, `broker_conversations`, and `user_preferences`.
- Deduplication key based on normalized address + unit number + price to avoid duplicate alerts.

## 3. AI Evaluation Pipeline
- **Rent True-Cost Normalizer**: Calculates gross rent, concessions (e.g. "1 month free on 12-month lease"), and broker fee impact.
- **Layout & Amenities Classifier**: Scans text for railroad layouts, basement units, natural light mentions, and W/D availability.
- **Commute Scorer**: Computes door-to-door transit times to saved target locations (workplaces, favorite subway lines).

## 4. Outreach & Notification Dispatcher
- **Instant Mobile Bot (Telegram/SMS)**: Rich notifications with photo preview, summary breakdown, and action buttons.
- **Inquiry Submission**: Generates customized tenant introduction packet matching the broker's listing tone.
