const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createWorkerReporter, createHealthService, classify } = require('../src/health_service');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-worker-health-'));
    const database = new DatabaseSync(path.join(directory, 'features.db'));
    database.exec('CREATE TABLE feature_records(collection TEXT,id TEXT,data TEXT,revision INTEGER,updated_at TEXT,PRIMARY KEY(collection,id))');
    let clock = Date.parse('2026-10-17T12:00:00Z');
    const now = () => clock;
    const store = require('../src/feature_store').createFeatureStore({ backend: 'sqlite', async query(sql, parameters = []) {
        const values = [];
        const statement = sql.replace(/\$(\d+)/g, (_match, index) => { values.push(parameters[Number(index) - 1]); return '?'; });
        const rows = database.prepare(statement).all(...values); return { rows, rowCount: rows.length };
    } }, now);
    const repository = { statsRows: async () => ({ rows: [{ evaluation_status: 'pending' }, { evaluation_status: 'processing' },
        { evaluation_status: 'retry_wait' }, { evaluation_status: 'retry_wait' }, { evaluation_status: 'failed' }, { evaluation_status: 'completed' }] }) };
    const service = options => createHealthService({ store, repository, now, local: false, ...options });
    t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { directory, now, store, repository, service, advance: milliseconds => { clock += milliseconds; } };
}

function localDirectories(t, f) {
    const originalInbox = process.env.INBOX_STATE_DIR, originalTelegram = process.env.TELEGRAM_STATE_DIR;
    process.env.INBOX_STATE_DIR = path.join(f.directory, 'inbox'); process.env.TELEGRAM_STATE_DIR = path.join(f.directory, 'telegram');
    t.after(() => {
        if (originalInbox === undefined) delete process.env.INBOX_STATE_DIR; else process.env.INBOX_STATE_DIR = originalInbox;
        if (originalTelegram === undefined) delete process.env.TELEGRAM_STATE_DIR; else process.env.TELEGRAM_STATE_DIR = originalTelegram;
    });
}

test('a worker killed after a healthy heartbeat becomes stale without another database write', async t => {
    const f = fixture(t); const reporter = createWorkerReporter('scorer', { store: f.store, now: f.now, intervalMs: 3600000 });
    t.after(() => reporter.stop());
    await reporter.report({ lastSuccessAt: f.now(), backlog: 4 });
    let status = await f.service().status(); assert.equal(status.workers.find(worker => worker.name === 'scorer').status, 'healthy');
    f.advance(60001); status = await f.service().status();
    assert.equal(status.workers.find(worker => worker.name === 'scorer').status, 'stale');
    assert.deepEqual(status.queues.scoring, { pending: 1, processing: 1, completed: 1, retry_wait: 2, failed: 1 });
});

test('a recent heartbeat with repeated errors is degraded and recovery retains the latest successful operation', async t => {
    const f = fixture(t); const reporter = createWorkerReporter('inbox', { store: f.store, now: f.now, intervalMs: 3600000 });
    t.after(() => reporter.stop());
    await reporter.report({ lastSuccessAt: f.now() }); const firstSuccess = f.now();
    for (let i = 0; i < 3; i++) { f.advance(20000); await reporter.report({ error: 'mailbox_or_database_unavailable', backlog: 7 }); }
    let worker = (await f.service().status()).workers.find(row => row.name === 'inbox');
    assert.equal(worker.status, 'degraded'); assert.equal(worker.lastSuccessAt, firstSuccess); assert.equal(worker.backlog, 7);
    await reporter.report({ error: null, lastSuccessAt: f.now(), backlog: 0 });
    worker = (await f.service().status()).workers.find(row => row.name === 'inbox');
    assert.equal(worker.status, 'healthy'); assert.equal(worker.lastSuccessAt, f.now());
});

test('unknown, stopped and malformed heartbeat states remain distinguishable', async t => {
    const f = fixture(t);
    assert.ok((await f.service().status()).workers.every(worker => worker.status === 'unknown'));
    const reporter = createWorkerReporter('scraper', { store: f.store, now: f.now, intervalMs: 3600000 });
    await reporter.report(); assert.equal((await f.service().status()).workers.find(row => row.name === 'scraper').status, 'degraded');
    await reporter.stop(); f.advance(86400000);
    assert.equal((await f.service().status()).workers.find(row => row.name === 'scraper').status, 'stopped');
    assert.equal(classify({ status: 'running', heartbeat_at: 'not a timestamp', last_success_at: f.now() }, f.now()), 'stale');
    assert.equal(classify({ status: 'running', heartbeat_at: f.now() + 3600000, last_success_at: f.now() }, f.now()), 'stale');
});

test('a valid empty scan is different from blocked, partial and parser-failure scans; latest evidence wins', async t => {
    const f = fixture(t);
    const scan = (id, data) => f.store.create('source_scans', id, { source: 'streeteasy', feed_url: 'https://streeteasy.com/for-rent/manhattan',
        completed_at: new Date(f.now()).toISOString(), parsed_count: 0, observation_count: 0, outcome: 'empty', ...data });
    await scan('old', { outcome: 'blocked', failure_category: 'blocked' }); f.advance(1000);
    await scan('new', {});
    await scan('renthop', { source: 'renthop', feed_url: 'https://renthop.com/search/nyc', outcome: 'parser_failure', failure_category: 'parser_failure' });
    await scan('compass', { source: 'compass', feed_url: 'https://compass.com/for-rent/new-york', outcome: 'blocked', failure_category: 'blocked' });
    await scan('partial', { feed_url: 'https://streeteasy.com/for-rent/brooklyn', outcome: 'partial', parsed_count: 4, observation_count: 3 });
    const { sources } = await f.service().status();
    assert.equal(sources.length, 4);
    const empty = sources.find(source => source.feed.endsWith('/manhattan')); assert.equal(empty.status, 'empty'); assert.equal(empty.count, 0); assert.equal(empty.error, null);
    assert.equal(sources.find(source => source.source === 'renthop').status, 'parser_failure');
    assert.equal(sources.find(source => source.source === 'compass').status, 'blocked');
    assert.equal(sources.find(source => source.feed.endsWith('/brooklyn')).status, 'partial');
    f.advance(900001); assert.ok((await f.service().status()).sources.every(source => source.status === 'stale'));
});

test('local journals override shared worker records, expose counts, and never expose message payloads or action metadata', async t => {
    const f = fixture(t), originalInbox = process.env.INBOX_STATE_DIR, originalTelegram = process.env.TELEGRAM_STATE_DIR;
    process.env.INBOX_STATE_DIR = path.join(f.directory, 'inbox'); process.env.TELEGRAM_STATE_DIR = path.join(f.directory, 'telegram');
    t.after(() => {
        if (originalInbox === undefined) delete process.env.INBOX_STATE_DIR; else process.env.INBOX_STATE_DIR = originalInbox;
        if (originalTelegram === undefined) delete process.env.TELEGRAM_STATE_DIR; else process.env.TELEGRAM_STATE_DIR = originalTelegram;
    });
    const inboxModule = require('../src/inbox_state');
    const inbox = inboxModule.openInboxState(inboxModule.stateFile(), 'fixture');
    inbox.discover([{ id: 'private-message-id', uid: 'provider-secret-id' }], f.now());
    inbox.set('heartbeat', { status: 'running', at: f.now(), lastCheckAt: f.now(), error: 'provider-body-private-secret' }); inbox.close();
    const telegram = require('../src/telegram_state').openState(require('../src/telegram_worker').stateFile(), 'fixture');
    telegram.enqueueEvents([{ id: 'private-alert', kind: 'tour', created_at: f.now(), reference: { tourId: 'private-tour' }, payload: { text: 'private-email-body' } }]);
    telegram.set('heartbeat', { status: 'stopped', at: f.now(), lastPollAt: f.now(), lastAction: { content: 'private-callback-data' } }); telegram.close();
    for (const name of ['inbox', 'telegram']) await f.store.create('worker_health', name, { status: 'running', heartbeat_at: f.now() - 1000, last_success_at: f.now() - 1000, error: null });
    const result = await f.service({ local: true }).status();
    assert.equal(result.workers.find(row => row.name === 'inbox').status, 'degraded');
    assert.equal(result.workers.find(row => row.name === 'telegram').status, 'stopped');
    assert.equal(result.queues.inboxPending, 1); assert.equal(result.queues.telegramPending, 1);
    assert.equal(result.queues.inboxPendingSource, 'local_journal'); assert.equal(result.queues.telegramPendingSource, 'local_journal');
    assert.doesNotMatch(JSON.stringify(result), /private-|provider-secret|\.sqlite|\.state|callback/);
});

test('health serializes only safe timestamps, counts, source categories and credential-free feed paths', async t => {
    const f = fixture(t), secret = 'RAW_PRIVATE_SECRET';
    const reporter = createWorkerReporter('scorer', { store: f.store, now: f.now, intervalMs: 3600000 });
    await reporter.report({ lastSuccessAt: f.now(), error: `Authorization: Bearer ${secret}`, backlog: -3 }); await reporter.stop();
    const saved = await f.store.get('worker_health', 'scorer'); assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
    await f.store.create('worker_health', 'inbox', { status: 'running', heartbeat_at: f.now(), last_success_at: secret, backlog: { token: secret }, error: secret });
    await f.store.create('source_scans', 'credentials', { source: 'streeteasy', feed_url: `https://user:${secret}@streeteasy.com/for-rent/manhattan?api_key=${secret}#${secret}`,
        completed_at: new Date(f.now()).toISOString(), outcome: 'failed', failure_category: secret, observation_count: { token: secret } });
    await f.store.create('source_scans', 'invalid', { source: secret, feed_url: '/workspace/.state/' + secret, completed_at: secret, outcome: secret });
    const result = await f.service().status(); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.equal(result.sources.find(source => source.source === 'streeteasy').feed, 'https://streeteasy.com/for-rent/manhattan');
    assert.equal(result.workers.find(worker => worker.name === 'inbox').lastSuccessAt, null);
});

test('stop waits for an in-flight write and durably records stopped before storage can close', async () => {
    let release, started; const blocked = new Promise(resolve => { release = resolve; });
    const writing = new Promise(resolve => { started = resolve; });
    const writes = []; let record = null;
    const reporter = createWorkerReporter('telegram', { intervalMs: 3600000, now: () => 1000000,
        store: { async update(_collection, _id, transform) {
            const snapshot = transform(record); writes.push(snapshot);
            if (writes.length === 1) { started(); await blocked; }
            record = snapshot; return { data: record };
        } } });
    const reporting = reporter.report({ lastSuccessAt: 1000000 }); await writing;
    let stopped = false; const stopping = reporter.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    release(); await Promise.all([reporting, stopping]);
    assert.equal(record.status, 'stopped'); assert.equal(writes.length, 2);
    await reporter.report({ status: 'running' }); assert.equal(record.status, 'stopped'); assert.equal(writes.length, 2);
});

test('reporter restart preserves last success and storage outages remain nonfatal', async t => {
    const f = fixture(t); const previousSuccess = f.now() - 50000;
    await f.store.create('worker_health', 'inbox', { status: 'stopped', heartbeat_at: previousSuccess, last_success_at: previousSuccess });
    const reporter = createWorkerReporter('inbox', { store: f.store, now: f.now, intervalMs: 3600000 });
    await reporter.report({ error: 'messages_pending' }); await reporter.stop();
    assert.equal((await f.store.get('worker_health', 'inbox')).data.last_success_at, previousSuccess);
    const unavailable = createWorkerReporter('scorer', { intervalMs: 3600000, store: { update: async () => { throw new Error('Private database credentials'); } } });
    await unavailable.report({ error: 'scoring_failed' }); await unavailable.stop();
});

test('an older stopped local journal cannot mask a newer shared deployment or supply its queue counts', async t => {
    const f = fixture(t); localDirectories(t, f);
    const inboxModule = require('../src/inbox_state');
    const inbox = inboxModule.openInboxState(inboxModule.stateFile(), 'fixture');
    inbox.discover([{ id: 'old', uid: 'old' }], f.now() - 86400000);
    inbox.set('heartbeat', { status: 'stopped', at: f.now() - 86400000, lastCheckAt: f.now() - 86400000 }); inbox.close();
    const telegramFile = require('../src/telegram_worker').stateFile();
    let telegram = require('../src/telegram_state').openState(telegramFile, 'fixture');
    telegram.set('heartbeat', { status: 'stopped', at: f.now() - 86400000, lastPollAt: f.now() - 86400000 }); telegram.close();
    for (const name of ['inbox', 'telegram']) await f.store.create('worker_health', name, { status: 'running', heartbeat_at: f.now(), last_success_at: f.now(), backlog: 3 });
    let result = await f.service({ local: true }).status();
    for (const name of ['inbox', 'telegram']) {
        const worker = result.workers.find(row => row.name === name);
        assert.equal(worker.status, 'healthy'); assert.equal(worker.source, 'shared'); assert.equal(worker.backlog, 3);
    }
    assert.equal(result.queues.inboxPending, null); assert.equal(result.queues.telegramPending, null);
    assert.equal(result.queues.inboxPendingSource, null); assert.equal(result.queues.telegramPendingSource, null);
    telegram = require('../src/telegram_state').openState(telegramFile, 'fixture');
    telegram.set('heartbeat', { status: 'stopped', at: f.now() }); telegram.close();
    result = await f.service({ local: true }).status();
    assert.equal(result.workers.find(row => row.name === 'telegram').source, 'shared', 'equal timestamps keep shared evidence');
});

test('an unreadable local file preserves shared health and falls back to a sanitized local error only without shared evidence', async t => {
    const f = fixture(t); localDirectories(t, f);
    const file = require('../src/inbox_state').stateFile(); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'private non-SQLite message contents');
    await f.store.create('worker_health', 'inbox', { status: 'running', heartbeat_at: f.now(), last_success_at: f.now(), error: null });
    let result = await f.service({ local: true }).status();
    assert.equal(result.workers.find(row => row.name === 'inbox').status, 'healthy');
    assert.equal(result.workers.find(row => row.name === 'inbox').source, 'shared');
    await f.store.remove('worker_health', 'inbox'); result = await f.service({ local: true }).status();
    const worker = result.workers.find(row => row.name === 'inbox');
    assert.equal(worker.status, 'stale'); assert.equal(worker.error, 'database_unavailable'); assert.equal(worker.source, 'local_journal');
    assert.doesNotMatch(JSON.stringify(result), /private|\.sqlite|workspace/);
});

test('operation history persists across restart, ignores unchanged heartbeats, is bounded and exposes only sanitized fields', async t => {
    const f = fixture(t); const reporter = createWorkerReporter('scorer', { store: f.store, now: f.now, intervalMs: 3600000 });
    await reporter.report({ lastSuccessAt: f.now() });
    for (let i = 0; i < 5; i++) { f.advance(10); await reporter.report(); }
    assert.equal((await f.store.list('worker_runs')).length, 1, 'ordinary heartbeats do not add operations');
    f.advance(10); await reporter.report({ error: 'RAW_PRIVATE_SECRET Authorization bearer' });
    let runs = (await f.service().status()).workers.find(row => row.name === 'scorer').recentRuns;
    assert.equal(runs[0].outcome, 'failure'); assert.equal(runs[0].error, 'connection_or_service_error');
    assert.doesNotMatch(JSON.stringify(await f.store.list('worker_runs')), /RAW_PRIVATE_SECRET/);
    for (let i = 0; i < 40; i++) { f.advance(10); await reporter.report({ lastSuccessAt: f.now(), error: null }); }
    f.advance(10); await reporter.stop();
    assert.equal((await f.store.list('worker_runs')).length, 30);
    assert.equal((await f.store.get('worker_health', 'scorer')).data.recent_runs.length, 30);
    const restarted = createWorkerReporter('scorer', { store: f.store, now: f.now, intervalMs: 3600000 });
    f.advance(10); await restarted.report(); f.advance(10); await restarted.stop();
    runs = (await f.service().status()).workers.find(row => row.name === 'scorer').recentRuns;
    assert.equal(runs.length, 30); assert.equal(runs[0].outcome, 'stopped'); assert.equal(runs[1].outcome, 'started');
    assert.ok(runs.some(run => run.outcome === 'success')); assert.ok(runs.every(run => Number.isFinite(run.at)));
    assert.equal((await f.store.list('worker_runs')).length, 30);
});

test('interrupted history append is recovered idempotently from durable health on reporter restart', async t => {
    const f = fixture(t); const create = f.store.create; let failAppend = true;
    f.store.create = async (...args) => { if (failAppend && args[0] === 'worker_runs') throw new Error('history storage interrupted'); return create(...args); };
    const reporter = createWorkerReporter('inbox', { store: f.store, now: f.now, intervalMs: 3600000 });
    await reporter.report({ lastSuccessAt: f.now() }); f.advance(10); await reporter.report({ error: 'messages_pending' });
    f.advance(10); await reporter.stop();
    assert.equal((await f.store.list('worker_runs')).length, 0);
    assert.equal((await f.service().status()).workers.find(worker => worker.name === 'inbox').recentRuns.length, 3);
    failAppend = false;
    const restarted = createWorkerReporter('inbox', { store: f.store, now: f.now, intervalMs: 3600000 });
    f.advance(10); await restarted.report(); const count = (await f.store.list('worker_runs')).length;
    assert.equal(count, 4); await restarted.report(); assert.equal((await f.store.list('worker_runs')).length, count);
    await restarted.stop();
});
