const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAllowance, WINDOW_MS } = require('../src/commute_allowance');
const { migrateCommute } = require('../src/commute_migration');
const { nextWeekdayArrival, dayStart } = require('../src/commute_time');
const { createCommuteService, commuteOrigin, parseRoute, FIELD_MASK, DESTINATION } = require('../src/google_commute');
const { createHttpsClient, HttpsError } = require('../src/https_client');
const listing = { id: 'a', title: '975 Nostrand Avenue, Apt 346', location_area: 'Brooklyn' };
const walk = { travelMode: 'WALK', staticDuration: '120s', distanceMeters: 100, navigationInstruction: { instructions: 'Walk to station' } };
const transit = line => ({ travelMode: 'TRANSIT', staticDuration: '600s', transitDetails: {
    transitLine: { nameShort: line, vehicle: { type: 'SUBWAY' }, agencies: [{ name: 'MTA', uri: 'https://mta.info' }] },
    stopDetails: { departureStop: { name: 'Origin station' }, arrivalStop: { name: 'Destination station' },
        departureTime: '2026-10-13T12:30:00Z', arrivalTime: '2026-10-13T12:40:00Z' }, stopCount: 4, headsign: 'Uptown' } });
const fixture = () => ({ routes: [{ duration: '1800s', distanceMeters: 7000, legs: [{ steps: [walk, transit('2'), walk, transit('A'), walk] }] }] });
let db, raw, dir, clock, admin, schema;
async function openSqlite() {
    const sqlite3 = require('sqlite3');
    raw = await new Promise((resolve, reject) => { const c = new sqlite3.Database(path.join(dir, 'test.db'), e => e ? reject(e) : resolve(c)); });
    raw.configure('busyTimeout', 10000);
    return { async query(sql, params = []) {
        const values = [];
        sql = sql.replace(/\$(\d+)/g, (_, n) => { values.push(params[n - 1]); return '?'; });
        return new Promise((resolve, reject) => {
            if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) raw.all(sql, values, (e, rows) => e ? reject(e) : resolve({ rows, rowCount: rows.length }));
            else raw.run(sql, values, function(e) { e ? reject(e) : resolve({ rows: [], rowCount: this.changes }); });
        });
    } };
}
before(async () => {
    const url = process.env.COMMUTE_TEST_DATABASE_URL;
    if (url) {
        assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
        const { Pool } = require('pg');
        admin = new Pool({ connectionString: url }); schema = 'commute_test_' + require('crypto').randomBytes(6).toString('hex');
        await admin.query(`CREATE SCHEMA ${schema}`);
        db = new Pool({ connectionString: url, options: '-c search_path=' + schema });
    } else { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commute-')); db = await openSqlite(); }
    await migrateCommute(db.query.bind(db), dir ? 'sqlite' : 'pg');
});
beforeEach(async () => {
    clock = Date.parse('2026-10-12T20:00:00Z');
    await db.query("UPDATE commute_control SET attempts = '[]', revision = 0, disabled_config = NULL, pause_until = 0");
});
after(async () => {
    if (raw) await new Promise(resolve => raw.close(resolve));
    if (dir) fs.rmSync(dir, { recursive: true });
    if (db?.end) await db.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
const allowance = () => createAllowance(db, () => clock);
function service(client, env = { GOOGLE_MAPS_API_KEY: 'private-fixture-key' }) {
    return createCommuteService({ allowance: allowance(), client, env, now: () => clock });
}
test('next weekday uses NY calendar, weekends, DST, and next day even before 9am', () => {
    for (const [input, output] of [
        ['2026-10-12T05:00:00Z','2026-10-13T13:00:00.000Z'],
        ['2026-10-13T01:00:00Z','2026-10-13T13:00:00.000Z'],
        ['2026-10-16T15:00:00Z','2026-10-19T13:00:00.000Z'],
        ['2026-10-17T15:00:00Z','2026-10-19T13:00:00.000Z'],
        ['2026-10-18T15:00:00Z','2026-10-19T13:00:00.000Z'],
        ['2026-03-06T20:00:00Z','2026-03-09T13:00:00.000Z'],
        ['2026-10-30T20:00:00Z','2026-11-02T14:00:00.000Z'],
        ['2026-12-31T20:00:00Z','2027-01-01T14:00:00.000Z']
    ]) assert.equal(nextWeekdayArrival(Date.parse(input)), output);
    assert.equal(new Date(dayStart(Date.parse('2026-03-08T20:00:00Z'))).toISOString(), '2026-03-08T05:00:00.000Z');
});
test('only usable street addresses and explicit borough/city; no neighborhood inference', () => {
    assert.equal(commuteOrigin(listing), '975 Nostrand Avenue, Brooklyn, NY');
    assert.equal(commuteOrigin({ ...listing, title: '31-01 31st Avenue #4', location_area: 'Queens' }), '31-01 31st Avenue, Queens, NY');
    assert.equal(commuteOrigin({ ...listing, title: '10 Grove Street', location_area: 'Jersey City' }), '10 Grove Street, Jersey City, NJ');
    for (const item of [{ ...listing, location_area: null, neighborhood: 'Williamsburg' },
        { ...listing, title: 'Williamsburg' }, { ...listing, title: '23 Main Street near Broadway' },
        { ...listing, title: '23 Main Street & 4th Avenue' }, { ...listing, title: '23 bedrooms near Main Street' }]) assert.equal(commuteOrigin(item), null);
});
test('route parsing preserves walking legs, lines, stops, schedules, agencies and transfer count', () => {
    const route = parseRoute(fixture());
    assert.equal(route.transfers, 1); assert.equal(route.walkingSeconds, 360); assert.equal(route.steps.length, 5);
    assert.equal(route.steps[1].transit.line, '2'); assert.equal(route.steps[3].transit.stopCount, 4);
    assert.equal(route.durationSeconds, 1800); assert.equal(route.walkingOnly, false);
    const walking = parseRoute({ routes: [{ duration: '120s', legs: [{ steps: [walk] }] }] });
    assert.equal(walking.walkingOnly, true); assert.equal(walking.transfers, 0);
    for (const value of [{}, { routes: [] }, { routes: [{ duration: 'invalid' }] }, { routes: [{ duration: '12s', legs: [{ steps: [] }] }] }]) assert.throws(() => parseRoute(value), { code: 'unavailable' });
    assert.throws(() => parseRoute({ ...fixture(), geocodingResults: { origin: { partialMatch: true } } }), { code: 'ambiguous_address' });
    assert.throws(() => parseRoute({ ...fixture(), geocodingResults: { origin: { type: ['locality'] } } }), { code: 'ambiguous_address' });
});
test('fixed Essentials request, one call, arrival/retrieval and attribution; no listing writes', async () => {
    let calls = 0;
    const saved = JSON.stringify(listing);
    const s = service({ async request(url, options) {
        calls++; assert.equal(url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
        assert.deepEqual(options.json, { origin: { address: '975 Nostrand Avenue, Brooklyn, NY' },
            destination: { address: DESTINATION }, travelMode: 'TRANSIT', arrivalTime: '2026-10-13T13:00:00.000Z',
            computeAlternativeRoutes: false, languageCode: 'en-US', units: 'IMPERIAL' });
        assert.equal(options.headers['X-Goog-FieldMask'], FIELD_MASK);
        return { data: fixture() };
    } });
    const result = await s.lookup(listing);
    assert.equal(calls, 1); assert.equal(result.attribution, 'Google Maps'); assert.equal(result.retrievedAt, new Date(clock).toISOString());
    assert.equal(JSON.stringify(listing), saved);
    const accounting = JSON.stringify((await db.query('SELECT * FROM commute_control')).rows);
    for (const forbidden of ['Nostrand', 'Brooklyn', 'MTA', 'private-fixture-key', 'duration', 'arrival']) assert.ok(!accounting.includes(forbidden));
    assert.equal((await s.status()).remaining.daily, 299);
});
test('atomic daily cap under concurrent service instances; disabled/capped requests make zero calls', async () => {
    await db.query('UPDATE commute_control SET attempts = $1', [JSON.stringify(Array(299).fill(clock))]);
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => allowance().reserve('configured')));
    assert.equal(outcomes.filter(Boolean).length, 1);
    const s = service({ request() { assert.fail('provider must not be called'); } });
    await assert.rejects(s.lookup(listing), { code: 'allowance_exhausted' });
    await assert.rejects(service({}, {}).lookup(listing), { code: 'unconfigured' });
    await assert.rejects(s.lookup({ ...listing, location_area: null }), { code: 'address_needed' });
    assert.equal((await allowance().status('configured')).remaining.daily, 0);
});
test('rolling cap reserves only the final slot under contention', async () => {
    await db.query('UPDATE commute_control SET attempts = $1', [JSON.stringify(Array(8999).fill(clock - 86400000))]);
    const results = await Promise.all(Array.from({ length: 20 }, () => allowance().reserve('configured')));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await allowance().status('configured')).remaining.rolling32Days, 0);
});
test('rolling 32-day cap, NY midnight, window expiry, and migration/restart persistence', async () => {
    await db.query('UPDATE commute_control SET attempts = $1', [JSON.stringify(Array(9000).fill(clock - 86400000))]);
    assert.equal(await allowance().reserve('configured'), false);
    assert.equal((await allowance().status('configured')).remaining.daily, 300);
    clock += WINDOW_MS;
    assert.equal(await allowance().reserve('configured'), true);
    await migrateCommute(db.query.bind(db), dir ? 'sqlite' : 'pg');
    if (raw) { await new Promise(resolve => raw.close(resolve)); db = await openSqlite(); }
    assert.equal((await allowance().status('configured')).remaining.daily, 299);
    clock = Date.parse('2026-11-02T04:59:59Z');
    await db.query('UPDATE commute_control SET attempts = $1', [JSON.stringify(Array(300).fill(clock))]);
    assert.equal(await allowance().reserve('configured'), false);
    clock += 1000;
    assert.equal(await allowance().reserve('configured'), true);
});
test('failed calls consume attempts; auth/configuration failure persists across service restart until corrected', async () => {
    let calls = 0;
    const env = { GOOGLE_MAPS_API_KEY: 'secret' };
    const client = { async request() { calls++; throw new HttpsError('Google', 'request rejected', 403); } };
    const s = service(client, env);
    await assert.rejects(s.lookup(listing), { code: 'configuration_error' });
    await assert.rejects(service(client, env).lookup(listing), { code: 'configuration_error' });
    assert.equal(calls, 1); assert.equal((await s.status()).remaining.daily, 299);
    env.GOOGLE_MAPS_CONFIG_VERSION = 'fixed-cloud-permissions';
    assert.equal((await s.status()).available, true);
});
test('429 pauses at least 5 minutes, honors longer retry, survives restart, and never retries', async () => {
    let calls = 0;
    const client = { async request() { calls++; const e = new HttpsError('Google', 'request rejected', 429); e.retryAfterMs = 600000; throw e; } };
    await assert.rejects(service(client).lookup(listing), { code: 'rate_limited' });
    assert.equal(calls, 1); clock += 300000;
    await assert.rejects(service(client).lookup(listing), { code: 'rate_limited' });
    clock += 300001; assert.equal((await service(client).status()).available, true);
    await allowance().pause(1); clock += 299999;
    assert.equal((await service(client).status()).available, false);
});
test('duplicate prevention, cancellation after reservation, timeout and sanitized provider errors', async () => {
    const abort = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const s = service({ async request(url, { signal }) {
        started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('secret address and credentials');
    } });
    const pending = s.lookup(listing, { signal: abort.signal });
    await ready;
    await assert.rejects(s.lookup(listing), { code: 'busy' });
    abort.abort(); await assert.rejects(pending, { code: 'cancelled' });
    assert.equal((await s.status()).remaining.daily, 299);
    const client = createHttpsClient({ dispatcher: {}, timeoutMs: 5, fetchImpl: async (url, { signal }) => {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('secret');
    } });
    await assert.rejects(service(client).lookup(listing), error => error.code === 'timeout' && !JSON.stringify(error).includes('secret'));
    assert.equal((await s.status()).remaining.daily, 298);
});
test('HTTPS errors preserve numeric/date Retry-After, never body, key or response headers', async () => {
    for (const retry of ['900', new Date(Date.now() + 900000).toUTCString()]) {
        const client = createHttpsClient({ dispatcher: {}, fetchImpl: async () => new Response('provider secret', { status: 429, headers: { 'retry-after': retry, 'secret': 'value' } }) });
        await assert.rejects(client.request('https://example.test'), e => e.retryAfterMs > 898000 && !JSON.stringify(e).includes('secret'));
    }
});
test('accounting fails closed without replaying ambiguous remote mutations', async () => {
    let calls = 0;
    const remote = createAllowance({ backend: 'supabase', async rpc(name) {
        if (name === 'housing_commute_state') return { id: 1, revision: 0, attempts: '[]', pause_until: 0, disabled_config: null };
        calls++; throw new Error('ambiguous network result');
    } }, () => clock);
    await assert.rejects(remote.reserve('configured')); assert.equal(calls, 1);
});
