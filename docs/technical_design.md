# Core Systems Technical Design

## 1. Real-Time Monitoring & Web Scraping (Ingestion)

The biggest hurdle in NYC housing is **DataDome**, the bot-protection software used by StreetEasy. Naive scraping gets banned instantly. We will implement a two-pronged approach:

### A. The "Zero-Ban" IMAP Listener (Fastest)
Instead of polling StreetEasy constantly and risking bans, we let them push to us.
- **Tech Stack:** Python, `imap-tools`, dedicated Gmail account.
- **Mechanism:** 
  1. Create a dedicated Gmail (e.g., `aditya.housingbot@gmail.com`).
  2. Set up StreetEasy Saved Searches with "Instant Alerts" to this email.
  3. A Python script uses IMAP `IDLE` to maintain an open connection to the inbox.
  4. The millisecond an email arrives, the script parses the HTML body, extracts the listing URL and Price, and passes it to the AI Evaluator. Latency is typically < 5 seconds.

### B. Stealth Playwright Scraper (For full page data & secondary sources)
When we get a URL from the IMAP listener (or when polling Compass/RentHop), we need the full listing text and photos.
- **Tech Stack:** Python, `playwright`, `playwright-stealth`.
- **Mechanism:** 
  - Instead of parsing messy HTML DOM elements, we inject JavaScript to extract the `__NEXT_DATA__` JSON blob that modern React apps (like StreetEasy/Compass) embed in the page source. This gives us clean, structured data (coordinates, raw description, exact amenity booleans) in milliseconds.

## 2. Aggregation & Deduplication

Listings often appear on Compass or RentHop before StreetEasy, or are cross-posted. We need a unified database so you don't get pinged 3 times for the same apartment.

### Data Schema (Pydantic / SQLite)
Every scraped listing is normalized into a standard format:
- `id` (UUID)
- `source` (enum: streeteasy, compass, renthop)
- `external_url`
- `address_normalized` (e.g., "123-W-45-ST-APT-4B")
- `price`, `bedrooms`, `bathrooms`, `sqft`
- `broker_fee_status` (enum: no_fee, fee, unknown)

### Deduplication Engine
- When a new listing comes in, we run an address normalizer (converting "West 45th Street" to "W 45 ST").
- We query the SQLite DB: `SELECT * FROM listings WHERE address_normalized = ? AND unit = ?`.
- If it exists, we link the new source URL to the existing record rather than treating it as a new alert.

## 3. AI Implementation (Evaluation & Parsing)

NYC listing descriptions are notoriously deceptive. We will use a Large Language Model (e.g., Gemini Pro) with **Structured JSON Outputs** to turn paragraphs of broker-speak into hard data.

### The AI Prompt & Output Schema
We pass the raw listing description and basic stats into the LLM and force it to return a JSON object like this:

```json
{
  "true_gross_rent": 4000,
  "advertised_net_rent": 3692,
  "concession_details": "1 month free on 13 month lease",
  "is_railroad_layout": false,
  "is_basement": false,
  "has_in_unit_laundry": true,
  "broker_fee_estimate": "15% of annual rent ($7,200)",
  "red_flags": ["Fifth floor walk-up", "No mention of natural light"],
  "suitability_score": 85
}
```

### Key AI Evaluations:
1. **The Net-Effective Trap:** The AI looks for "net effective" or "X months free". It calculates what your *actual* monthly check will be (Gross Rent), because landlords require you to pay Gross, and give you a "free month" at the end.
2. **Layout & Lighting Detection:** Brokers hide bad layouts. If the AI sees words like "flex", "railroad", "interior room", or "skylight" (often meaning no actual windows), it docks the `suitability_score`.
3. **Fee Extraction:** StreetEasy sometimes masks broker fees in the description. The AI parses sentences like "tenant pays 15% broker fee" and calculates the exact upfront cash required.
