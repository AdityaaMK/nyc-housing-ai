# HTTPS backends for development and manual cloud jobs

The existing host keeps its PostgreSQL/SQLite and SMTP/IMAP defaults. Cloud jobs select `DB_BACKEND=supabase` and `MAIL_BACKEND=gmail-api` explicitly. No continuous worker is started by setup or `cloud:check`. The dashboard routes and their response fields remain unchanged; queue leases stay private.

Use a current Node.js LTS (Node 22.16+ recommended), run `npm ci`, and keep all service credentials out of source control. `.env.example` lists the settings. An explicit invalid or unavailable backend fails instead of selecting a different database or mail transport. Direct `pool.query` remains available for local PostgreSQL/SQLite maintenance scripts only.

## Prepare Supabase locally

1. Copy the **backend secret key** and project URL from the project's API key settings. Use `SUPABASE_SECRET_KEY`, never a browser publishable/anon key. Requests send the secret in `apikey`, not as a Bearer JWT. A secret key operates as `service_role`; this application needs existing table access for that role. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
2. Confirm the current application's scoring, rent-term, and Manhattan-commute schema migrations have already been applied to this database. `001_https_backends.sql` requires those columns and the singleton `evaluation_control` row. It does not initialize or backfill application data.
3. Review [the additive migration](../migrations/001_https_backends.sql). It installs named functions only, pins their search paths, revokes execution from `PUBLIC`, `anon`, and `authenticated`, and grants it to `service_role`. It does not change existing RLS policies or table grants and does not expose arbitrary SQL.
4. From the existing working copy with its local PostgreSQL connection configured, run:

   ```sh
   node scripts/backup-scoring.js
   npm run db:migrate:https -- /private/path/returned-by-backup
   ```

   The backup mechanism saves listings, tours, schema, policies, and function definitions privately outside the repository. The migration command verifies its checksum and database target, then applies the migration twice in a transaction. It compares every listing, tour, evaluation-control row, and existing policy before committing. Failure rolls back the transaction. Review both files before applying them to a live database; do not run migration commands in cloud startup.
5. Supabase startup calls `housing_schema_version` and checks the existing columns and control row without executing DDL. It fails closed if incompatible. Supabase/PostgREST must reload its schema after migration; the SQL sends its standard reload notification.

## Authorize the Gmail mailbox on a local workstation

1. In [Google Cloud Console](https://console.cloud.google.com/), select or create a project. Under **APIs & Services → Library**, enable **Gmail API**. In **Google Auth Platform**, configure Branding and Audience, and add your mailbox as a test user if the consent app is in Testing. Under **Clients**, create an OAuth client of type **Desktop app** and download its JSON to a private location outside the repository. Google's [Node.js quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs) documents these console steps. The downloaded file supplies the client ID and client secret; the next step generates the refresh token.
2. Run this on the workstation where the browser can reach the loopback callback:

   ```sh
   npm run gmail:authorize -- /private/path/desktop-client.json your-mailbox@gmail.com
   ```

   The helper opens the browser, validates OAuth state, uses PKCE, requests offline access, and verifies that the grant belongs to the requested mailbox. Its only success output is the private credentials file path (directory mode `0700`, file mode `0600`). For local HTTPS mode set `GMAIL_CREDENTIALS_FILE` to that file. Do not paste token values into chat or commit the file.
3. The requested `gmail.modify` scope covers reading, sending, and removing the unread label. Raw messages are parsed using Mailparser; Nodemailer composes outgoing MIME with sender name, Reply-To, and BCC-to-self. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [sending MIME messages](https://developers.google.com/workspace/gmail/api/guides/sending)
4. A revoked/expired refresh token requires running authorization again. An external consent app in Testing may issue refresh tokens that expire after seven days for these scopes; use an appropriate publishing status for ongoing access. Review Google's verification requirements for your app's audience. Access tokens are cached only in memory, refreshed before expiry, and never written to disk. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

## Configure the cloud environment

In the selected environment, add ordinary variables `DB_BACKEND=supabase`, `MAIL_BACKEND=gmail-api`, `SUPABASE_URL`, `GMAIL_USER`, `GMAIL_CLIENT_ID`, and `DAEMON_MODE=false`. Project and mailbox identifiers must be readable values, not secret placeholders.

Add separate network secrets:

- `SUPABASE_SECRET_KEY`: allowed destination is the exact Supabase project hostname.
- `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN`: allowed destination is `oauth2.googleapis.com`.

Allow the project hostname, `gmail.googleapis.com`, and `oauth2.googleapis.com`. Network secrets provide placeholders; the proxy substitutes credentials only for approved HTTPS destinations on port 443. The transport preserves them in headers and JSON, and disables redirects and automatic mutation retries. Retain the provided `HTTPS_PROXY`/`HTTP_PROXY`, `NO_PROXY`, and CA settings. Use `NODE_EXTRA_CA_CERTS` before Node starts; `SSL_CERT_FILE` is also supported. Never disable TLS verification. [Codex Cloud configuration](https://learn.chatgpt.com/docs/environments/cloud-environments)

Run `npm run cloud:check` in the environment test terminal and again in a new task after publishing the environment. It checks the HTTPS schema, bounded database reads, token refresh, and mailbox identity. It sends no messages, marks no mail read, claims no jobs, and starts no worker. A local run does not establish that the cloud proxy, allowlist, CA, or network-secret replacement works.

For the first cloud dry run, select the HTTPS PR branch and use this task prompt after configuring the credentials and applying the reviewed migration locally:

> Install dependencies with `npm ci`, then run `npm run cloud:check`. Report the exit status and sanitized results. Do not print environment values, send email or Telegram messages, mark mail read, apply migrations, claim evaluation jobs, or start the application or any workers. If credentials or schema are missing, stop the check and list only the missing setting names or required migration.

Successful output is `{"schema":"compatible","databaseReads":"ok","tokenRefresh":"ok","mailboxIdentity":"matches GMAIL_USER"}`. Missing credentials or incompatible schema means access is **not yet verified**; an HTTP response alone is not a successful authenticated dry run.

Additional existing workflows need their own destinations and credentials:

- Gemini: `generativelanguage.googleapis.com` (`GEMINI_API_KEY`).
- Telegram: `api.telegram.org` (`TELEGRAM_BOT_TOKEN` and ordinary `TELEGRAM_CHAT_ID`).
- Building health: `data.cityofnewyork.us`.
- Scraping: `streeteasy.com`, `www.renthop.com`, `www.compass.com`, and any required resource or redirect hosts encountered by those sites. Chromium downloads may require `storage.googleapis.com`; package installation needs `registry.npmjs.org`.

Those older clients have their own proxy behavior. Their allowlist entries alone do not verify proxy/placeholder compatibility; test each workflow separately before using its credentials. This change's shared HTTPS transport covers Supabase and Gmail.

## Run and roll back

After `cloud:check` passes, `npm run api` starts the existing dashboard API and `npm run evaluate -- --limit 10 --no-retries` starts one bounded scoring job. Scoring additionally requires Gemini credentials and reachable listing pages. Only run a full `npm start` cycle when intentionally authorizing its notifications and inbox workflow. Do not start PM2, `evaluate:worker`, or `DAEMON_MODE=true` in a development environment. Continuous monitoring stays on the current host.

Rollback is selecting the previous database and mail backends (or removing both selections to restore the original defaults). Leave additive HTTPS functions installed. No listing, tour, score, application, or notification data needs conversion or restoration to switch back.

If a send or mutation times out, its outcome may be unknown. Check Gmail Sent or the relevant database row before manually retrying. Expired evaluation leases recover through the queue with the existing retry budget.

## Validation

`npm test` runs fixture-backed tests with no real sends or live database writes. An additional opt-in integration suite creates and drops a random **local** database and launches PostgREST with a deliberately low response cap:

```sh
HTTPS_TEST_DATABASE_URL=postgresql://localhost/postgres \
POSTGREST_BIN=/path/to/postgrest npm test
```

The local database account needs database/role creation rights; never point this at a shared server. The suite checks schema idempotency, preserved data/RLS, repository parity beyond 1,000 rows, atomic claims, stale leases, retries, deduplication, and shared throttling. The existing direct PostgreSQL queue regression is available via `QUEUE_TEST_DATABASE_URL=postgresql://localhost/postgres node scripts/test-queue-postgres.js`.

`RUN_HTTPS_PROXY_TEST=1 node --test test/https-proxy.test.js` verifies real CONNECT proxy routing and CA validation using temporary local TLS fixtures. It requires permission to listen on localhost and an OpenSSL executable (override with `OPENSSL_BIN`).

### Verification in the implementation sandbox (2026-10-12)

- The review snapshot, including the newer location/startup changes from `main`, passed 53 tests (`node --test --test-skip-pattern='Gmail parses|listing ingestion' test/*.test.js`), with two opt-in integration tests skipped. The prerequisite snapshot passed 36 tests with the end-to-end ingestion test excluded, and dashboard build/lint passed. The earlier full suite had two tests blocked by the unavailable Mailparser installation (raw MIME parsing and the existing end-to-end inbox flow). The declared dependency and lockfile are ready; `npm install --package-lock-only --offline` succeeded using upstream lock metadata, but package downloads failed with DNS/network restrictions. Run `npm ci` and repeat `npm test` in the prepared environment.
- PostgreSQL/PostgREST integration remains unrun: the installed PostgreSQL binary cannot execute on this machine's architecture, and no PostgREST executable was supplied. The opt-in test is skipped without these settings.
- The opt-in proxy/TLS test reached `listen EPERM` on localhost. Transport unit tests cover deadlines, sanitized errors, proxy-agent use, and unchanged placeholders, but do not substitute for this real TLS test.
- The existing private database backup command could not connect. No live migration was applied, and no live data was written. `cloud:check` stops at missing Supabase configuration. Both supplied `.env` files contain PostgreSQL and Gmail app-password settings, not the new backend key/OAuth credentials. The cloud environment has not been changed or published.
