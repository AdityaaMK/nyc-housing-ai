const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DATABASE_URL = '';
process.env.DB_BACKEND = 'sqlite';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-repository-'));
process.env.SQLITE_PATH = path.join(dir, 'test.db');
const { pool } = require('../src/db');
const { createRepository, createSupabaseRepository } = require('../src/repository');
const { databaseBackend, mailBackend } = require('../src/backend_config');
const { createHttpsClient, createDispatcher, HttpsError } = require('../src/https_client');
const { createSupabaseClient } = require('../src/supabase_client');
const repo = createRepository(pool);
after(async () => { await pool.end(); fs.rmSync(dir, { recursive: true, force: true }); });
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
test('backend defaults, explicit selections, invalid configurations and lazy drivers', async () => {
    assert.equal(databaseBackend({}), 'sqlite'); assert.equal(databaseBackend({ DATABASE_URL: 'postgres://fixture' }), 'postgres');
    assert.equal(databaseBackend({ DB_BACKEND: 'sqlite', DATABASE_URL: 'postgres://fixture' }), 'sqlite');
    assert.equal(mailBackend({}), 'smtp-imap');
    for (const env of [{ DB_BACKEND: 'bad' }, { DB_BACKEND: 'postgres' }, { DB_BACKEND: 'supabase' }]) assert.throws(() => databaseBackend(env));
    assert.throws(() => mailBackend({ MAIL_BACKEND: 'bad' }));
    const script = `const Module=require('module'),load=Module._load;
        Module._load=function(id,...args){if(['pg','sqlite3','sqlite','imap-simple'].includes(id))throw Error('driver eagerly loaded');return load.call(this,id,...args)};
        const db=require('./src/db');require('./src/mailbox');db.pool.query('SELECT 1').catch(e=>{if(!e.message.includes('Direct SQL'))process.exit(1)});`;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env,
        DB_BACKEND: 'supabase', SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'fixture', MAIL_BACKEND: 'gmail-api' } });
    assert.equal(child.status, 0, child.stderr);
});
test('HTTPS uses EnvHttpProxyAgent, preserves secret placeholders, rejects redirects/HTTP and sanitizes failures without retries', async () => {
    const marker = 'NETWORK_SECRET_PLACEHOLDER:oauth+/$value=';
    let calls = 0;
    const client = createHttpsClient({ fetchImpl: async (url, options) => {
        calls++; assert.equal(url.protocol, 'https:'); assert.equal(options.dispatcher.constructor.name, 'EnvHttpProxyAgent');
        assert.equal(options.redirect, 'error'); assert.equal(JSON.parse(options.body).refresh_token, marker);
        assert.ok(options.body.includes(marker)); assert.equal(options.headers.apikey, marker);
        return response({ ok: true });
    } });
    assert.deepEqual((await client.request('https://fixture.test', { method: 'POST', json: { refresh_token: marker }, headers: { apikey: marker } })).data, { ok: true });
    await assert.rejects(client.request('http://fixture.test'), /requires HTTPS/); assert.equal(calls, 1); await client.close();
    let attempts = 0;
    const broken = createHttpsClient({ dispatcher: {}, fetchImpl: async () => { attempts++; throw new Error(marker); } });
    await assert.rejects(broken.request('https://fixture.test', { method: 'POST', json: { secret: marker } }), error => {
        assert.ok(!JSON.stringify(error).includes(marker)); assert.ok(!error.stack.includes(marker)); assert.equal(error.cause, undefined); return true;
    }); assert.equal(attempts, 1);
    for (const status of [401, 403, 429, 503]) {
        const rejected = createHttpsClient({ dispatcher: {}, fetchImpl: async () => response({ secret: marker }, status) });
        await assert.rejects(rejected.request('https://fixture.test'), e => e instanceof HttpsError && e.status === status && !e.message.includes(marker));
    }
    assert.throws(() => createDispatcher({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /validation/);
    assert.throws(() => createDispatcher({ SSL_CERT_FILE: '/missing/ca' }), /CA certificate/);
});
test('HTTPS deadlines cover response bodies as well as connection setup', async () => {
    const deadline = createHttpsClient({ timeoutMs: 5, dispatcher: {}, fetchImpl: async (_, options) => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('private URL')), { once: true });
    }) });
    await assert.rejects(deadline.request('https://fixture.test'), /deadline/);
    const bodyDeadline = createHttpsClient({ timeoutMs: 5, dispatcher: {}, fetchImpl: async (_, options) => ({ ok: true,
        text: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('private body')))) }) });
    await assert.rejects(bodyDeadline.request('https://fixture.test'), /deadline/);
});
test('Supabase paginates beyond 1,000 rows even when the server caps pages lower, using apikey only', async () => {
    const all = Array.from({ length: 2307 }, (_, i) => ({ id: String(i).padStart(5, '0'), is_fee: false, price: null }));
    let reads = 0;
    const client = createHttpsClient({ dispatcher: {}, fetchImpl: async (url, opts) => {
        assert.equal(opts.headers.apikey, 'secret-placeholder'); assert.equal(opts.headers.Authorization, undefined);
        const offset = Number(url.searchParams.get('offset')); assert.equal(url.searchParams.get('order'), 'id.asc'); reads++;
        return response(all.slice(offset, offset + 321), 200, { 'content-range': `${offset}-${Math.min(offset + 320, all.length - 1)}/${all.length}` });
    } });
    const db = createSupabaseClient({ env: { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'secret-placeholder' }, client });
    assert.deepEqual(await db.readAll('listings', { order: 'id.asc' }), all); assert.equal(reads, 8);
    for (const url of ['http://fixture.test', 'https://user:pass@fixture.test', 'https://fixture.test/path', 'https://fixture.test:8443']) {
        assert.throws(() => createSupabaseClient({ env: { SUPABASE_URL: url, SUPABASE_SECRET_KEY: 'fixture' } }));
    }
});
test('Supabase startup checks only schema version and fails closed', async () => {
    const calls = [];
    const db = createSupabaseClient({ env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SECRET_KEY: 'fixture' }, client: {
        request: async (url, opts) => { calls.push([String(url), opts]); return { data: 1 }; }, close() {}
    } });
    await db.verifySchema(); assert.equal(calls.length, 1); assert.ok(calls[0][0].endsWith('/rpc/housing_schema_version'));
    const incompatible = createSupabaseClient({ env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SECRET_KEY: 'fixture' }, client: { request: async () => ({ data: 2 }) } });
    await assert.rejects(incompatible.verifySchema(), /incompatible/);
});
test('repository preserves conflicts, affected rows, nulls, flags, tours, deduplication and outreach on SQLite', async () => {
    assert.equal((await repo.insertListing({ id: 'a', title: 'fixture', price: null, normalized_address: '1-MAIN-ST-1' })).rowCount, 1);
    assert.equal((await repo.insertListing({ id: 'a', title: 'overwrite' })).rowCount, 0);
    assert.equal((await repo.setListingStatus('missing', 'passed')).rowCount, 0);
    assert.equal((await repo.setListingStatus('a', 'contacted')).rowCount, 1);
    await Promise.all(['url1', 'url2', 'url1'].map(newUrl => repo.recordDuplicate({ normalizedAddress: '1-MAIN-ST-1', newUrl, newSource: 'fixture' })));
    let listing = (await repo.getListing('a')).rows[0];
    assert.equal(listing.title, 'fixture'); assert.equal(listing.price, null); assert.equal(listing.is_notified, 0);
    assert.deepEqual(JSON.parse(listing.cross_posted_sources).map(s => s.url).sort(), ['url1', 'url2']);
    await repo.markApplied('a'); await repo.setBrokerEmail('a', 'broker@example.test'); await repo.recordNudge('a');
    listing = (await repo.getListing('a')).rows[0]; assert.equal(listing.status, 'applied'); assert.equal(listing.nudge_count, 1);
    assert.deepEqual((await repo.inboxInquiries()).rows.map(row => row.id), ['a']);
    assert.ok(listing.applied_at); await repo.markNotified('a'); assert.equal((await repo.getListing('a')).rows[0].is_notified, 1);
    assert.equal((await repo.saveTour({ id: 'tour', proposed_datetime: null, proposed_time: 'TBD' })).rowCount, 1);
    assert.equal((await repo.saveTour({ id: 'tour', proposed_time: 'overwrite' })).rowCount, 0);
    assert.equal((await repo.getTour('tour')).rows[0].proposed_time, 'TBD');
    assert.equal((await repo.countTours()).rows[0].count, 1); await repo.confirmTour('tour');
    assert.equal((await repo.getTour('tour')).rows[0].status, 'confirmed');
});
test('Supabase mutation counts come from exact totals and filters escape PostgREST syntax', async () => {
    const calls = [];
    const r = createSupabaseRepository({ async rest(table, opts) { calls.push({ table, opts }); return { data: [], headers: new Headers({ 'content-range': '*/0' }) }; } });
    assert.equal((await r.setListingStatus('a,b)"\\c', 'passed')).rowCount, 0);
    assert.equal(calls[0].opts.params.id, 'eq."a,b)\\"\\\\c"');
    await r.insertListing({ id: 'a', price: null }); assert.match(calls[1].opts.prefer, /resolution=ignore-duplicates/);
    const many = createSupabaseRepository({ async rest() { return { data: [{ id: 'one returned row' }], headers: new Headers({ 'content-range': '0-0/1201' }) }; } });
    assert.equal((await many.passListing('collision')).rowCount, 1201);
});
test('cloud diagnostic only reads schema/tables and verifies mailbox identity', async () => {
    const operations = [];
    const report = await require('../scripts/cloud-check').check({ database: {
        verifySchema: async () => operations.push('schema'),
        rest: async (table, options) => { assert.equal(options.method, undefined); assert.equal(options.params.limit, 1); operations.push(table); return { data: [] }; }
    }, gmail: { verifyIdentity: async () => operations.push('identity') } });
    assert.deepEqual(operations, ['schema', 'listings', 'tour_schedules', 'identity']); assert.equal(report.databaseReads, 'ok');
});
test('Supabase inbox inquiry scan includes all applied contacts without the legacy five-row cap', async () => {
    const expected = Array.from({ length: 12 }, (_, i) => ({ id: String(i) }));
    const repo = createSupabaseRepository({ readAll: async (table, params) => {
        assert.equal(table, 'listings'); assert.equal(params.status, 'eq.applied');
        assert.equal(params.broker_email, 'not.is.null'); assert.equal(params.limit, undefined); return expected;
    } });
    assert.deepEqual((await repo.inboxInquiries()).rows, expected);
});
test('Supabase normalization preserves PostgreSQL dashboard timestamps, booleans, nulls and decimal strings', () => {
    const { normalizeRow } = require('../src/supabase_client');
    const raw = { id: 'fixture', discovered_at: '2026-10-12T12:34:56', evaluation_completed_at: '2026-10-12T16:35:00+00:00',
        proposed_datetime: '2026-10-20T17:30:00-04:00', effective_monthly_rent: 2500, price: null, is_fee: false, suitability_score: 0 };
    const normalized = normalizeRow(raw);
    assert.equal(normalized.discovered_at.toISOString(), new Date(raw.discovered_at).toISOString());
    assert.equal(normalized.evaluation_completed_at.toISOString(), '2026-10-12T16:35:00.000Z');
    assert.equal(normalized.proposed_datetime, raw.proposed_datetime); assert.equal(normalized.effective_monthly_rent, '2500.00');
    assert.equal(normalized.price, null); assert.equal(normalized.is_fee, false); assert.equal(normalized.suitability_score, 0);
});
test('HTTPS completion persists every current SQL scoring field exactly once', async () => {
    let update;
    const { createQueue } = require('../src/evaluation_queue');
    const sqlQueue = createQueue({ backend: 'sqlite', query: async sql => { update = sql; return { rowCount: 1 }; } });
    await sqlQueue.complete({ id: 'fixture', price: null, evaluation_claim_token: 'lease' }, {
        true_gross_rent: 2500, is_fee: false, fee_estimate: 'None', red_flags: [], pros: [],
        suitability_score: 0, neighborhood: 'Fixture', is_preferred_neighborhood: false,
        commute_minutes: null, commute_summary: null, location_area: null,
        manhattan_commute_minutes: null, manhattan_arrival_station: null, manhattan_commute_summary: null
    }, { grade: 'Unknown' });
    const fields = sql => [...sql.split(/UPDATE (?:public\.)?listings SET/i)[1].split(/\bWHERE\b/i)[0].matchAll(/\b([a-z_]+)\s*=/g)].map(m => m[1]);
    const migration = fs.readFileSync(path.join(__dirname, '../migrations/001_https_backends.sql'), 'utf8');
    const complete = migration.split('FUNCTION public.housing_queue_complete')[1].split('END $$;')[0];
    const remoteFields = fields(complete);
    assert.equal(new Set(remoteFields).size, remoteFields.length, 'Duplicate assignments would make the RPC invalid');
    assert.deepEqual([...remoteFields].sort(), fields(update).sort(), 'New scoring fields must be preserved through both transports');
});
