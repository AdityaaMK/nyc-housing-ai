# Google commute lookup

Each listing has a **Get Google commute** button. It requests one recommended transit route to **620 8th Avenue, New York, NY 10018**, arriving by **9:00 AM America/New_York on the next Monday–Friday after today**. Holidays are included. Daylight-saving time is handled in New York time. The existing external Maps link remains available.

The Google result is labeled **Google Maps transit estimate**, with the requested arrival date/time, retrieval time, walking steps, transit lines/stops, transfers, and attribution. Walking-only results are labeled explicitly. It is independent of saved AI commute estimates, apartment scores, and the 20-minute Manhattan-access preference. No scoring worker is enabled by this feature.

## Configure Google Cloud

1. Select a Google Cloud project, enable billing, and enable **Routes API**.
2. Create a server-side API key. Restrict its API access to **Routes API**; restrict application access to the server's egress IP addresses where supported by the hosting setup. Keep the key out of frontend builds, browser storage, source control, command arguments, and logs.
3. Set `GOOGLE_MAPS_API_KEY` privately in the API environment or its ignored `.env` file, then restart only `housing-api`. For a proxy-backed cloud environment, allow `routes.googleapis.com` on HTTPS port 443 and scope the network secret to that hostname. The existing HTTPS client honors proxy/CA settings without redirects or retries.
4. In Google Cloud → Google Maps Platform → Quotas → Routes API, set **Directions - ComputeRoutes per request quota per day** to **300** and the unused **DistanceMatrix - ComputeRouteMatrix per-element quota per day** to **0**. These are enforced quotas; billing alerts alone do not stop requests. The app additionally caps attempted requests at **300 per New York calendar day** and **9,000 in any rolling 32 × 24-hour window**. Failed and cancelled attempts count. Allowance is shared by all processes connected to the same database and survives restarts and key changes. Do not clear or independently copy the accounting table while sharing the same Google billing allowance.
5. If Google rejects authentication, permissions, billing or request configuration, the app persists a block tied to a SHA-256 configuration fingerprint. Correct the configuration, then replace the key or increment `GOOGLE_MAPS_CONFIG_VERSION` and restart the API. Changing this version does not reset request counts. A 429 pauses all lookups for at least five minutes, honoring longer `Retry-After` instructions. No automatic route retries or Gemini fallback occur.
6. Once configured, click one usable listing for a smoke test. Confirm the route and New York arrival date/time, then check that the allowance decreased by one. Without credentials, the button remains visibly unconfigured and makes no Google requests.

Only basic Compute Routes fields are requested: a TRANSIT route, origin/destination addresses, arrival time, duration/distance, walking instructions, transit details and geocoding match metadata. There are no intermediate waypoints, alternate routes, traffic options, optimization, tolls or other Pro/Enterprise features. The application cap is conservative relative to the documented Essentials allowance; it cannot prevent charges from other applications or projects on the billing account, different SKU use elsewhere, or future pricing changes. Review [Routes billing](https://developers.google.com/maps/documentation/routes/usage-and-billing), [SKU triggers](https://developers.google.com/maps/billing-and-pricing/sku-details#routes-essentials), and [current pricing](https://developers.google.com/maps/billing-and-pricing/pricing).

## Data handling and endpoints

`POST /api/listings/:id/commute` resolves the origin from the saved listing on the server. Request bodies cannot override routing parameters. A usable numbered street address and explicit borough/city are required; neighborhood inference is never used for an API origin. Partial/geographic-only geocoding matches are rejected. Missing/ambiguous addresses, no route, provider failure, timeout, cancellation and unavailable allowance have separate dashboard states. A failed lookup clears the previous result and never becomes a verified estimate.

`GET /api/commute/status` reports `configured`, `available`, a fixed status code, remaining daily/rolling allowances, limits and optional rate-limit retry time. It never returns credentials, configuration fingerprints, addresses or directions. Reading status and refreshing listings spend no Google requests.

Both endpoints send `Cache-Control: no-store`. Only the current page's React state holds returned routes, arrival/retrieval times and directions. Reload discards them. No route content is stored in the database, browser storage or application logs. `commute_control` stores only application request timestamps, revision, pause deadline and blocked configuration fingerprint. Reservations use an atomic conditional revision update; only confirmed conflicts may retry the database operation. An ambiguous database failure makes no Google call and is never automatically replayed.

Follow [Google's Routes policies](https://developers.google.com/maps/documentation/routes/policies) when distributing the app, including attribution and publicly accessible terms/privacy disclosures where required. Compact listing cards display the prescribed Google Maps text attribution beside route content, plus returned transit agency names/links. All provider strings are rendered as text.

## Migration and deployment

SQLite creates the additive `commute_control` table during initialization. For a live SQLite upgrade, first use SQLite's `.backup` command (or the SQLite backup API) to snapshot the active database privately. PostgreSQL initialization also creates the accounting table for direct SQL access. Supabase HTTPS requires [002_google_commute.sql](../migrations/002_google_commute.sql), applied using a maintenance PostgreSQL connection; it never performs DDL over REST. The new RPCs are restricted to `service_role`, use pinned search paths, and leave existing tables, policies, scores and queue state untouched.

For the existing PostgreSQL host:

```sh
node scripts/backup-scoring.js
node scripts/migrate-commute.js /private/backup/directory/returned/above
npm run build --prefix web
# Restart only the existing API process with the established process manager.
```

The migration verifies the backup checksum and target, snapshots all listing/tour/evaluation-control data and policies, saves any pre-existing commute accounting privately, applies SQL twice in a transaction, and compares the snapshots before committing. A failed verification rolls back. Leave the additive table/functions in place on rollback so request accounting is retained. Remove the key to disable requests immediately after an API restart.

The API serves `web/dist` at its root after a dashboard build. Production frontend requests use the same origin unless `VITE_API_URL` is explicitly set; development defaults to `http://localhost:3001`. Restarting the API does not start the scorer, scraper, notifications or outreach.

## Verification

```sh
npm test
npm run lint --prefix web
npm run build --prefix web
node scripts/test-dashboard.js
node scripts/test-commute-dashboard.js
COMMUTE_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55439/postgres node --test test/commute.test.js
COMMUTE_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55439/postgres node scripts/test-commute-postgres.js
```

PostgreSQL commands refuse remote hosts and create/remove uniquely named test schemas/databases. The second command exercises the Supabase RPC serializer against the actual migrated PostgreSQL functions under `service_role`; it does not replace a hosted Supabase/PostgREST smoke test. Browser fixtures intercept all API requests and make no Google calls.
