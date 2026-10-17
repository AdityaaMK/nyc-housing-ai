# Persistent Telegram worker

The independent `housing-telegram` process listens for existing bot buttons and checks for newly scored matches every 30 seconds. It does not start the scraper, scorer, inbox listener, or nudge scanner. Existing buttons can still send an inquiry, confirm a tour, or send a nudge when clicked in the configured chat. `/status` reports that the bot is responding. Other chats and forwarded/inline buttons without the configured chat are ignored.

It also consumes tour alerts and follow-up prompts queued by the separate [broker inbox worker](inbox-worker.md). Both workers must share `INBOX_STATE_DIR` on the same host and use matching mailbox/database/chat settings. The inbox worker can queue alerts while Telegram is stopped. Imported alerts use this same delivery journal and recovery commands. Follow-up prompts wait for a fresh inbox check and are rechecked for broker replies before dispatch.

Use Node.js 24+, the existing database credentials, `TELEGRAM_BOT_TOKEN`, and a numeric `TELEGRAM_CHAT_ID`. Set `TELEGRAM_STATE_DIR` to a private persistent directory (default `.state/telegram` in the checkout). Keep the existing proxy and CA environment settings. The Telegram transport uses the shared proxy configuration, validates TLS, and disables hidden request retries. `NODE_USE_ENV_PROXY=1` in the PM2 config also enables proxy routing for the existing Gemini callback code on Node 24.

## Start and monitor

```sh
npm run telegram:start
npx pm2 save
npm run telegram:status
npm run telegram:logs
```

Use the same `PM2_HOME` for all PM2 commands if the host uses a custom directory. `telegram:status` reads the journal independently of PM2 and reports a fresh heartbeat, recent successful polling, delivery counts, and deliveries needing review. It does not make Telegram requests. Configuration failures before journal creation appear in PM2 logs. `telegram:worker` runs in the foreground for debugging.

The current cloud setup uses a private PM2 directory inside the checkout. From `/workspace/nyc-housing-ai`, set `export PM2_HOME="$PWD/.state/pm2"` before any of the PM2/start/stop/log commands above. The journal remains in `.state/telegram`. This leaves the previously saved scoring-worker configuration in its separate PM2 directory intact.

Run exactly one deployment for this bot. The journal has an OS-backed lock against duplicate workers sharing the state directory; Telegram polling conflicts cause backoff and pause notifications. This is not a distributed lock across different hosts or state directories. Do not run the legacy `housing-daemon`, `src/bot.js`, or `src/notifier.js` alongside this worker for the same bot. A pre-existing webhook is left intact and blocks polling startup.

The first successful notification scan sends one summary of existing eligible matches (with links to the top five), then marks those matches notified. Subsequent matches receive individual cards and action buttons, at most three per scan, spaced by at least 1.1 seconds. Passed/contacted/applied listings, low scores, and listings outside saved preferences are excluded. Queued alerts are rechecked against current listing eligibility before sending.

## Recovery

PM2 restarts crashes with exponential backoff, restarts excessive memory use, and keeps trying after startup failures. Network/database failures inside the worker retry without exiting. A watchdog terminates a polling or delivery operation stalled for three minutes so PM2 can replace the process. SIGINT/SIGTERM abort polling and allow up to 15 seconds to close; a forced stop retains the delivery journal. Heartbeats are written every ten seconds.

The SQLite journal commits each delivery intent and Telegram receipt on persistent disk. A database failure after Telegram confirms delivery retries only the database acknowledgement. Pending delivery retry times, Telegram flood-wait pauses, and the update offset survive restarts. No Supabase schema migration is needed.

Telegram does not provide an idempotency key for message sending. A timeout or crash after dispatch can have an unknown outcome. Such deliveries are held as `uncertain`, not automatically resent; definitive Telegram rejections can retry with backoff. Malformed/invalid messages are held as `failed`. Check `npm run telegram:status` for both. Stop the worker before resolving a held delivery:

```sh
npm run telegram:stop
# If the message arrived, record its Telegram message ID; only DB acknowledgement will run:
node src/telegram_worker.js --ack DELIVERY_ID MESSAGE_ID
# Or, only after verifying that it did not arrive, explicitly allow another send:
node src/telegram_worker.js --retry DELIVERY_ID
npm run telegram:start
npx pm2 save
```

The update offset is committed before invoking a callback, so a crash does not automatically repeat a broker email action. An interrupted action appears as `started` in the last-action record. Check the application/email state before clicking again. This is an intentional at-most-once handling tradeoff: a crash can interrupt an action before completion.

Preserve the entire state directory when moving hosts, with the old worker stopped. Do not share or copy it into concurrently running deployments. The journal binds to its bot/chat/database identity. Losing the directory loses local receipts, retry state, and polling checkpoints; acknowledged listings remain notified in the main database. Treat the state files and PM2 saved environment as private.

## Host reboot and sleep

PM2 survives application crashes while its host runs. It cannot execute while the host is asleep, suspended, or shut down. A continuously available Linux server with persistent storage is required for unattended 24/7 availability.

On an always-on Linux server, run `npx pm2 startup`, execute the host-specific systemd command it prints, then `npx pm2 save`. That registers PM2 recovery at boot. The managed development cloud has no systemd service manager; saving a PM2 list alone does not install a cloud startup hook. After that environment restarts, launch the worker again with `npm run telegram:start` using the same state directory and current credentials.

On macOS, run `npx pm2 save` and `npm run startup:install` after starting the worker. The updated LaunchAgent recognizes saved Telegram and scoring workers and preserves their restart settings. It recovers at login and after wake; it does not run during sleep. Re-run the installer to update an existing LaunchAgent helper. To deliberately keep Telegram stopped, run `npm run telegram:stop` followed by `npx pm2 save`.

## Verification

`npm test` includes persistent delivery/retry tests, database acknowledgement recovery, backlog handling, callback authorization, polling recovery, and a real child-process SIGKILL test verifying lock release and uncertain-send recovery. These use fixture services and temporary state.

`node scripts/test-telegram-recovery.js` runs the real worker entrypoint under an isolated PM2 daemon with fixture services, sends SIGKILL, and verifies that PM2 starts a new healthy worker. It sends no real messages and removes its temporary daemon/state afterward. For live deployment, additionally verify the Telegram receipt and database flags after the first summary, then check that restarting does not repeat it.
