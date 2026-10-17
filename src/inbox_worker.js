require('dotenv').config({ quiet: true });
const { setTimeout: delay } = require('node:timers/promises');
const { openInboxState, readInboxStatus, stateFile, inboxIdentity } = require('./inbox_state');
const { inspectMessage, tourProposal, nudgeEvent } = require('./inbox_messages');
const sleep = (ms, signal) => delay(ms, undefined, { signal });
const retryDelay = (attempts, error) => Math.max(Number(error?.retryAfterMs) || 0, Math.min(1800000, 10000 * 2 ** Math.min(attempts, 8)));

async function inboxCycle({ state, repository, connect, analyze, conversations, signal, now = Date.now, batchSize = 25, progress = () => {} }) {
    const inquiries = (await repository.inboxInquiries()).rows;
    const knownBrokers = new Set(inquiries.map(row => String(row.broker_email).trim().toLowerCase()));
    let connection, failures = 0;
    try {
        connection = await connect();
        if (signal?.aborted) return;
        const scanAt = now();
        const since = state.get('last_scan_at') ? state.get('last_scan_at') - 86400000 : state.get('coverage_start', scanAt - 7 * 86400000);
        if (!state.get('coverage_start')) state.set('coverage_start', since);
        // Include messages already opened on a phone. Read/unread flags belong to
        // the mailbox owner; our own journal is the processing checkpoint.
        const ids = await connection.listMessages(new Date(since));
        state.discover(ids.map(uid => ({ id: connection.identity(uid), uid })), scanAt);
        progress();
        for (const item of state.ready(now(), batchSize)) {
            if (signal?.aborted) break;
            try {
                let proposal = item.proposal;
                if (!proposal) {
                    // An IMAP UID can be recycled after UIDVALIDITY changes.
                    if (connection.identity(item.uid) !== item.id) { state.finish(item.id, 'ignored'); continue; }
                    let message;
                    try { message = await connection.getMessage(item.uid); }
                    catch (error) {
                        if (error?.status !== 404) throw error;
                        state.finish(item.id, 'ignored'); continue;
                    }
                    const initial = inspectMessage(message);
                    const match = conversations ? await conversations.matchMessage(message, inquiries) : null;
                    const inspected = inspectMessage(message, knownBrokers.has(initial.sender) || Boolean(match?.candidateListingIds?.length));
                    if (!inspected.relevant || inspected.sender === String(connection.user || process.env.GMAIL_USER || '').toLowerCase()) {
                        state.finish(item.id, 'ignored'); continue;
                    }
                    const conversation = conversations ? await conversations.recordInbound(item.id, message, inquiries) : null;
                    const receivedAt = Date.parse(message.receivedAt);
                    if (!conversations && Number.isFinite(receivedAt) && receivedAt <= now() + 300000) state.recordReply(inspected.sender, receivedAt);
                    const analysis = await analyze(inspected.subject, inspected.from, inspected.body, inspected.receivedAt);
                    if (typeof analysis?.is_tour_invitation !== 'boolean') throw new Error('Invalid tour analysis');
                    if (!analysis.is_tour_invitation) { state.finish(item.id); continue; }
                    proposal = tourProposal(item.id, inspected, analysis);
                    if (conversation) proposal.conversationId = conversation.id;
                    // Freeze the proposal before touching the remote database, so
                    // retries never generate a different tour for the same email.
                    state.prepared(item.id, proposal);
                }
                if (signal?.aborted) break;
                await repository.saveTour(proposal.tour);
                if (conversations && proposal.conversationId) await conversations.linkTour(proposal.conversationId, proposal.tour.id);
                state.completeTour(item.id, { id: 'tour:' + proposal.tour.id, kind: 'tour',
                    reference: { tourId: proposal.tour.id }, payload: proposal.payload, created_at: now() });
            } catch (error) {
                failures++; state.fail(item.id, now() + retryDelay(item.attempts, error));
            } finally { progress(); }
        }
        if (signal?.aborted) return;
        if (conversations) state.syncConversationReplies(await conversations.inboundReplies());
        // Finish discovering/processing replies before offering follow-ups. A
        // delayed or failed message must not be mistaken for an unanswered inquiry.
        if (!state.unfinished()) {
            for (const listing of inquiries) {
                const appliedAt = Date.parse(listing.applied_at);
                if (listing.status !== 'applied' || !Number.isFinite(appliedAt) || now() - appliedAt < 86400000 ||
                    appliedAt < state.get('coverage_start') ||
                    listing.nudge_notified || Number(listing.nudge_count) > 0) continue;
                const event = nudgeEvent(listing, now());
                if (!state.repliedForListingSince(event.reference.sender, listing.id, appliedAt)) state.enqueue(event);
            }
        }
        state.set('last_check_at', now());
        return { failures, pending: state.unfinished() };
    } finally { await connection?.close(); }
}

async function runInboxWorker({ state, repository, connect, analyze, conversations, signal, now = Date.now, wait = sleep,
    intervalMs = 60000, log = console.log, onStall = () => process.exit(1), onHeartbeat }) {
    let active = false, lastProgress = now(), error = null;
    let reporting = false, lastReported = -Infinity;
    const heartbeat = () => {
        const snapshot = { at: now(), pid: process.pid, status: signal.aborted ? 'stopping' : 'running',
            lastCheckAt: state.get('last_check_at'), lastScanAt: state.get('last_scan_at'), retryAt: state.get('retry_at', 0), error };
        state.set('heartbeat', snapshot);
        if (onHeartbeat && !reporting && now() - lastReported >= 10000) {
            reporting = true; lastReported = now();
            Promise.resolve().then(() => onHeartbeat({ ...snapshot, backlog: state.unfinished() })).catch(() => {}).finally(() => { reporting = false; });
        }
    };
    const progress = () => { lastProgress = now(); heartbeat(); };
    heartbeat();
    const timer = setInterval(() => {
        heartbeat();
        if (active && now() - lastProgress > 180000) { log('Inbox worker stalled; restarting.'); onStall(); }
    }, 10000);
    try {
        while (!signal.aborted) {
            const retryAt = state.get('retry_at', 0);
            if (retryAt > now()) { await wait(Math.min(retryAt - now(), 60000), signal).catch(() => {}); continue; }
            active = true; progress();
            try {
                const result = await inboxCycle({ state, repository, connect, analyze, conversations, signal, now, progress });
                error = result?.failures || result?.pending ? 'messages_pending' : null;
                state.set('failures', 0); state.set('retry_at', 0);
            } catch (cause) {
                if (signal.aborted) break;
                error = 'mailbox_or_database_unavailable';
                const attempts = state.get('failures', 0) + 1;
                state.set('failures', attempts);
                state.set('retry_at', now() + retryDelay(attempts, cause));
                log('Inbox cycle unavailable; retry scheduled.');
            } finally { active = false; heartbeat(); }
            await wait(intervalMs, signal).catch(() => {});
        }
    } finally { clearInterval(timer); heartbeat(); }
}

async function main(args = process.argv.slice(2)) {
    if (args.length) {
        if (args.length !== 1 || args[0] !== '--status') throw new Error('Usage: inbox:worker or inbox:status');
        console.log(JSON.stringify(readInboxStatus(stateFile()), null, 2)); return;
    }
    if (!process.env.GMAIL_USER || !process.env.GEMINI_API_KEY || !/^-?\d+$/.test(process.env.TELEGRAM_CHAT_ID || '')) {
        throw new Error('Mailbox, Gemini key, and numeric Telegram chat ID required');
    }
    process.umask(0o077);
    const { initDB, pool } = require('./db');
    const { repository } = require('./repository');
    const { openMailbox } = require('./mailbox');
    const { analyzeInboundEmail } = require('./inbound_listener');
    const controller = new AbortController();
    let state, hardStop, health;
    const shutdown = () => { controller.abort(); hardStop ||= setTimeout(() => process.exit(1), 15000).unref(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    try {
        state = openInboxState(stateFile(), inboxIdentity(pool.backend));
        await initDB();
        health = require('./health_service').createWorkerReporter('inbox');
        console.log('Inbox worker ready; broker replies and follow-up prompts are queued for Telegram.');
        await runInboxWorker({ state, repository, conversations: require('./conversations').getConversationService(),
            connect: openMailbox, analyze: (...args) => analyzeInboundEmail(...args, { quiet: true }), signal: controller.signal,
            onHeartbeat: value => health.report({ status: value.status, lastSuccessAt: value.lastCheckAt, error: value.error, backlog: value.backlog }) });
    } finally {
        shutdown();
        state?.set('heartbeat', { ...(state.get('heartbeat') || {}), at: Date.now(), status: 'stopped' });
        state?.close();
        await health?.stop();
        await pool.end(); await require('./https_client').httpsClient.close();
        clearTimeout(hardStop);
        process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    }
}
if (require.main === module) main().catch(() => { console.error('Inbox worker stopped; check mailbox, database, configuration, and state lock.'); process.exitCode = 1; });
module.exports = { inboxCycle, runInboxWorker, main };
