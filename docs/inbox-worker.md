# Persistent broker inbox worker

`housing-inbox` checks broker replies every minute, saves tour proposals, and queues tour alerts and follow-up prompts for the existing `housing-telegram` worker. The inbox worker never polls Telegram or sends broker email. Sending an inquiry, confirming a tour, or sending a follow-up still requires the existing button click.

Use Node.js 24+, the existing database configuration, `GMAIL_USER`, `GEMINI_API_KEY`, and numeric `TELEGRAM_CHAT_ID`. Configure `MAIL_BACKEND=gmail-api` and the Gmail OAuth settings described in [Cloud HTTPS setup](cloud-https.md), or use the existing `smtp-imap` backend on a host that supports it. Both transports are supported. No Supabase schema migration is required.

## Start and monitor

```sh
# Run from the checkout. The current cloud uses this private PM2 directory:
export PM2_HOME="$PWD/.state/pm2"
npm run inbox:start
npx pm2 save
npm run inbox:status
npm run inbox:logs
```

`inbox:worker` runs in the foreground. `inbox:status` reads local state without contacting Gmail, Telegram, or the listing database. It reports heartbeat freshness, the last completed inbox check, retry deadlines, processed message counts, and how many alerts have transferred to Telegram. Delivery receipts and uncertain sends are reported separately by `npm run telegram:status`.

`npm run inbox:stop` followed by `npx pm2 save` keeps the service intentionally stopped. The inbox config starts only `housing-inbox`; it does not activate Telegram. While Telegram is stopped, alerts remain queued on disk.

## Shared state and deployment

The default journal is `.state/inbox/worker.sqlite`. To move it, set `INBOX_STATE_DIR` to the same absolute private directory for both workers. They must run on the same host with access to that local directory and matching mailbox, database, and Telegram chat configuration. The journal binds to those settings and rejects an incompatible consumer. This is a local SQLite outbox, not a queue shared across servers.

Run one inbox worker per mailbox/deployment. An OS-backed SQLite lock prevents another inbox worker sharing its directory from starting, while allowing Telegram to consume queued alerts. Do not run the old combined `housing-daemon` inbox/nudge scans concurrently: they send alerts directly and do not share these checkpoints. Stop the old scanner before enabling this worker for the same mailbox. Preserve both inbox and Telegram state directories when moving hosts, with both workers stopped. The files contain extracted broker/tour information and must stay private; raw email bodies are not stored in this journal.

## Processing and recovery

- First startup examines the previous seven days of messages still in INBOX, including messages already read on a phone. Later scans use the last successful scan with a one-day overlap, so downtime does not reset the catch-up window. Archived/deleted mail outside INBOX is not discovered. Read/unread flags are left unchanged.
- Provider message identities are saved before processing. Previously ignored or completed messages are skipped after restart. Discovered messages that need retries remain in the journal even after they leave the time window. IMAP identities include UIDVALIDITY to avoid treating a recycled UID as the old email.
- Parsed proposals are saved locally before saving the tour to the main database. Stable tour IDs preserve existing records and confirmations. A failed save retries the same proposal without another AI call. The alert intent and message completion checkpoint commit together.
- Telegram commits each imported event before marking the inbox copy transferred. Repeating that handoff after a crash is safe. Delivery uses the existing receipt journal, rate-limit backoff, and manual review for ambiguous sends. See [Telegram delivery recovery](telegram-worker.md#recovery). Transferred means accepted by that journal, not delivered to Telegram.
- Tour alerts are cancelled if the saved tour was confirmed or its specific showing time has already passed before delivery. Ambiguous times remain unscheduled and have no calendar link.
- Follow-up prompts require an applied listing with a known broker address, at least 24 hours since applying, and no matching reply since then. The worker suppresses prompts for inquiries older than its initial mailbox coverage. Reply matching uses the actual sender address and suppresses all outstanding inquiries to that sender after a reply; this conservative rule may suppress prompts for multiple apartments handled by the same broker. Replies from a different address or archived before discovery cannot be matched.
- Nudges wait until discovered replies are processed and inbox checks are current. Telegram rechecks listing status, the inquiry timestamp, broker address, follow-up flags, and the reply journal before sending each prompt. The database's nudge notification flag is updated only after Telegram confirms delivery.

Transient message failures retry independently with persisted backoff, allowing other tour proposals to progress. Mailbox/database scan failures retry with backoff up to 30 minutes, respecting longer provider retry intervals. Failed messages remain visible in `inbox:status`; unresolved messages pause follow-up prompts. PM2 restarts process crashes and excessive memory use. A watchdog exits after three minutes without progress inside an operation; SIGINT/SIGTERM allows up to 15 seconds for shutdown before a forced exit.

PM2 cannot execute during host suspension. The managed cloud still requires a manual worker start after the environment restarts. On a continuously available Linux host, install the PM2 boot service with `npx pm2 startup` and save its process list. The existing macOS startup helper now recognizes saved `housing-inbox` services; re-run `npm run startup:install` to update that helper.

## Verification

`npm test` covers inbox checkpoints, parsed-proposal recovery, overlapping scans, queue handoff interruption, Telegram rate limits and uncertain sends, database acknowledgement failure, reply suppression, read-message discovery, and worker retries. `node scripts/test-inbox-recovery.js` starts the real entrypoint under an isolated PM2 supervisor using fixture services, kills it with SIGKILL, and verifies recovery without repeated parsing or duplicate alerts. It makes no real mailbox, database, Telegram, or broker requests and removes its temporary supervisor afterward.
