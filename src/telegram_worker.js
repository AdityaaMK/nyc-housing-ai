require('dotenv').config({ quiet: true });
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { openState, readStatus, resolveDelivery } = require('./telegram_state');
const { eligibleForAlert, buildListingAlert, buildBacklogAlert } = require('./telegram_messages');
const { loadPreferences } = require('./preferences');

const stateFile = () => path.join(process.env.TELEGRAM_STATE_DIR || path.resolve(__dirname, '../.state/telegram'), 'worker.sqlite');
const sleep = (ms, signal) => delay(ms, undefined, { signal });
const code = error => Number.isInteger(error?.errorCode) ? `telegram_${error.errorCode}` : 'connection_or_service_error';
const retryDelay = (error, attempts = 1) => {
    const retry = Number(error?.retryAfter || 0) * 1000;
    return Math.max(1000, Number.isFinite(retry) ? retry : 0, Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)));
};

async function notificationCycle({ state, repository, api, chatId, signal, now = Date.now,
    preferences = loadPreferences(), batchSize = 3, wait = sleep }) {
    const { rows } = await repository.pendingNotifications();
    const matches = rows.filter(row => eligibleForAlert(row, preferences));
    const current = new Map(matches.map(row => [row.id, row]));
    state.enqueue(matches, now());
    let sent = 0;
    for (const delivery of state.ready(now())) {
        if (signal?.aborted) break;
        if (delivery.status === 'sent') {
            // A receipt is committed locally before the remote notified flags. If
            // the database is down, resume this acknowledgement without resending.
            for (const id of delivery.listing_ids) await repository.markNotified(id);
            state.finish(delivery.id);
            continue;
        }
        if (sent >= batchSize || state.get('send_pause_until', 0) > now()) continue;
        const listings = delivery.listing_ids.map(id => current.get(id)).filter(Boolean);
        if (!listings.length) { state.finish(delivery.id, 'cancelled'); continue; }
        const payload = delivery.id === 'backlog' ? buildBacklogAlert(listings) : buildListingAlert({ ...listings[0], is_preferred: true });
        const ids = listings.map(l => l.id);
        state.preparing(delivery.id, ids);
        let receipt;
        try {
            receipt = await api.sendMessage({ chat_id: chatId, ...payload }, signal);
        } catch (error) {
            const status = error?.errorCode;
            if (status === 429 || status === 401 || status === 403 || status >= 500) {
                const nextAt = now() + Math.max(status === 401 || status === 403 ? 300000 : 0, retryDelay(error, delivery.attempts + 1));
                state.fail(delivery.id, 'retry', code(error), nextAt);
                state.set('send_pause_until', nextAt);
            } else {
                // A structured Telegram 4xx is a known rejection. A timeout,
                // broken connection or malformed response has an unknown outcome.
                state.fail(delivery.id, status >= 400 && status < 500 ? 'failed' : 'uncertain', code(error));
            }
            continue;
        }
        if (!Number.isSafeInteger(receipt?.message_id)) {
            state.fail(delivery.id, 'uncertain', 'missing_receipt');
            continue;
        }
        state.sent(delivery.id, receipt.message_id);
        state.set('last_delivery_at', now());
        sent++;
        for (const id of ids) await repository.markNotified(id);
        state.finish(delivery.id);
        await wait(1100, signal);
    }
    return { matching: matches.length, sent };
}

async function pollOnce({ api, bot, state, signal, now = Date.now }) {
    const updates = await api.getUpdates({ offset: state.get('offset', 0), timeout: 20,
        limit: 20, allowed_updates: ['callback_query', 'message'] }, signal);
    if (!Array.isArray(updates)) throw new Error('Invalid updates');
    state.set('last_poll_at', now());
    for (const update of updates) {
        if (signal?.aborted) break;
        if (!Number.isSafeInteger(update.update_id) || update.update_id < state.get('offset', 0)) continue;
        // Checkpoint before dispatch: a crash must not replay an email-producing
        // button click. Interrupted actions are visible in the local status record.
        state.set('offset', update.update_id + 1);
        state.set('last_action', { updateId: update.update_id, status: 'started', at: now() });
        await bot.handleUpdate(update);
        state.set('last_action', { updateId: update.update_id, status: 'handled', at: now() });
    }
}

async function runTelegramWorker({ api, bot, state, repository, chatId, signal, now = Date.now,
    wait = sleep, log = console.log, intervalMs = 30000, onStall = () => process.exit(1) }) {
    let polling = false, notifying = false, pollStarted = now(), notifyStarted = now();
    let lastPoll = 0, pollError = null, notifyError = null;
    const heartbeat = () => state.set('heartbeat', { at: now(), pid: process.pid, status: signal.aborted ? 'stopping' : 'running',
        lastPollAt: state.get('last_poll_at'), lastDeliveryAt: state.get('last_delivery_at'),
        pollError, notifyError, lastAction: state.get('last_action') });
    heartbeat();
    const timer = setInterval(() => {
        heartbeat();
        if ((polling && now() - pollStarted > 180000) || (notifying && now() - notifyStarted > 180000)) {
            log('Telegram worker stalled; restarting.');
            onStall();
        }
    }, 10000);
    const poll = async () => {
        let failures = 0;
        while (!signal.aborted) {
            const retryAt = state.get('poll_retry_at', 0);
            if (retryAt > now()) {
                await wait(Math.min(retryAt - now(), 60000), signal).catch(() => {});
                continue;
            }
            polling = true; pollStarted = now();
            let waitMs = 0;
            try {
                await pollOnce({ api, bot, state, signal, now });
                failures = 0; pollError = null; lastPoll = now();
            } catch (error) {
                if (signal.aborted) break;
                pollError = code(error); lastPoll = 0;
                waitMs = Math.max(error?.errorCode === 409 ? 60000 : 0, retryDelay(error, ++failures));
                state.set('poll_retry_at', now() + waitMs);
                log(`Telegram polling unavailable (${pollError}); retrying.`);
            } finally { polling = false; heartbeat(); }
        }
    };
    const notify = async () => {
        while (!signal.aborted) {
            notifying = true; notifyStarted = now();
            try {
                // Do not send if another poller owns the bot or polling is down.
                if (lastPoll && now() - lastPoll < 60000) {
                    const result = await notificationCycle({ state, repository, api, chatId, signal, now, wait });
                    notifyError = null;
                    if (result.sent) log(`Telegram delivery confirmed: ${result.sent} message(s).`);
                }
            } catch {
                if (!signal.aborted) { notifyError = 'delivery_or_database_unavailable'; log('Telegram delivery cycle interrupted; retrying.'); }
            } finally { notifying = false; heartbeat(); }
            await wait(intervalMs, signal).catch(() => {});
        }
    };
    try { await Promise.all([poll(), notify()]); }
    finally { clearInterval(timer); heartbeat(); }
}

async function main(args = process.argv.slice(2)) {
    if (args.length) {
        if (args[0] === '--retry' && args.length === 2) { resolveDelivery(stateFile(), args[1]); return; }
        if (args[0] === '--ack' && args.length === 3) { resolveDelivery(stateFile(), args[1], Number(args[2])); return; }
        if (args.length !== 1 || args[0] !== '--status') throw new Error('Usage: telegram:worker or telegram:status');
        console.log(JSON.stringify(readStatus(stateFile()), null, 2)); return;
    }
    if (!process.env.TELEGRAM_BOT_TOKEN || !/^-?\d+$/.test(process.env.TELEGRAM_CHAT_ID || '')) throw new Error('Telegram token and numeric chat ID required');
    process.umask(0o077);
    const { Bot } = require('node-telegram-bot-api');
    const { fetch } = require('undici');
    const { createDispatcher } = require('./https_client');
    const dispatcher = createDispatcher();
    const controller = new AbortController();
    let hardStop;
    const shutdown = () => {
        controller.abort();
        hardStop ||= setTimeout(() => process.exit(1), 15000).unref();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, { timeoutMs: 30000, maxRetries: 0,
        fetch: (url, init) => fetch(url, { ...init, dispatcher, redirect: 'error',
            signal: AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : [])]) }) });
    let state;
    const { initDB, pool } = require('./db');
    try {
        const self = await bot.api.getMe(controller.signal);
        const webhook = await bot.api.getWebhookInfo(controller.signal);
        if (webhook.url) throw new Error('Webhook is already configured; polling cannot start');
        const identity = crypto.createHash('sha256').update(JSON.stringify([self.id, process.env.TELEGRAM_CHAT_ID,
            pool.backend, process.env.SUPABASE_URL || process.env.DATABASE_URL || process.env.SQLITE_PATH || 'default'])).digest('hex');
        state = openState(stateFile(), identity);
        await initDB();
        require('./bot').setupBotHandlers(bot);
        bot.command(['start', 'status'], async ctx => {
            if (String(ctx.chat?.id) !== process.env.TELEGRAM_CHAT_ID) return;
            await ctx.reply('Housing alerts are running. New matches are checked every 30 seconds.');
        });
        const { repository } = require('./repository');
        console.log('Telegram worker ready; polling and notifications supervised.');
        await runTelegramWorker({ api: bot.api, bot, state, repository, chatId: process.env.TELEGRAM_CHAT_ID, signal: controller.signal });
    } finally {
        shutdown();
        state?.set('heartbeat', { ...(state.get('heartbeat') || {}), at: Date.now(), status: 'stopped' });
        state?.close();
        await pool.end(); await dispatcher.close();
        clearTimeout(hardStop);
        process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    }
}
if (require.main === module) main().catch(() => { console.error('Telegram worker stopped; check configuration, state lock, database, and Telegram access.'); process.exitCode = 1; });
module.exports = { notificationCycle, pollOnce, runTelegramWorker, main, stateFile, retryDelay };
