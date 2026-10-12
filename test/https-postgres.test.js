// Opt-in integration: creates and drops a uniquely named LOCAL database only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const url = process.env.HTTPS_TEST_DATABASE_URL;
const postgrestBin = process.env.POSTGREST_BIN;
const plain = value => JSON.parse(JSON.stringify(value));
test('disposable PostgreSQL and PostgREST: repository parity, queue races, leases, throttle, RLS and migration idempotency',
    { skip: !url || !postgrestBin ? 'Set HTTPS_TEST_DATABASE_URL to localhost PostgreSQL and POSTGREST_BIN to a PostgREST executable' : false }, async () => {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
    process.env.DB_BACKEND = 'sqlite'; process.env.DATABASE_URL = '';
    const { Pool } = require('pg');
    const { migrate } = require('../src/db');
    const { createSqlRepository, createSupabaseRepository } = require('../src/repository');
    const { createSupabaseClient } = require('../src/supabase_client');
    const { createQueue } = require('../src/evaluation_queue');
    const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    const name = 'housing_https_test_' + randomBytes(8).toString('hex');
    let db, processRest, started = false, processError;
    const createdRoles = [];
    const port = Number(process.env.POSTGREST_TEST_PORT || 13042);
    assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535);
    try {
        await admin.query('CREATE DATABASE ' + name); started = true;
        for (const role of ['anon', 'authenticated', 'service_role']) {
            if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
                await admin.query(`CREATE ROLE ${role}${role === 'service_role' ? ' BYPASSRLS' : ''}`); createdRoles.push(role);
            }
        }
        const target = new URL(url); target.pathname = '/' + name;
        db = new Pool({ connectionString: target.toString(), max: 12 });
        await migrate(db.query.bind(db), 'pg');
        await db.query('ALTER TABLE listings ENABLE ROW LEVEL SECURITY');
        await db.query('CREATE POLICY fixture_policy ON listings FOR SELECT TO authenticated USING (false)');
        await db.query('GRANT USAGE ON SCHEMA public TO service_role');
        await db.query('GRANT SELECT, INSERT, UPDATE ON listings, tour_schedules, evaluation_control TO service_role');
        await db.query("INSERT INTO listings (id, title, price, is_evaluated, suitability_score, is_notified, status, effective_monthly_rent, discovered_at) VALUES ('historic', 'Historic', NULL, true, 0, true, 'applied', 2000, '2026-10-01T00:00:00')");
        await db.query("INSERT INTO tour_schedules (id, status) VALUES ('historic-tour','confirmed')");
        const before = (await db.query('SELECT * FROM listings')).rows;
        const policies = (await db.query('SELECT * FROM pg_policies ORDER BY policyname')).rows;
        const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_https_backends.sql'), 'utf8');
        await db.query('BEGIN'); await db.query(sql); await db.query(sql); await db.query('COMMIT');
        assert.deepEqual((await db.query('SELECT * FROM listings')).rows, before);
        assert.deepEqual((await db.query('SELECT * FROM pg_policies ORDER BY policyname')).rows, policies);
        for (const role of ['anon', 'authenticated']) {
            const functions = (await db.query("SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS allowed FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'housing_%'", [role])).rows;
            assert.ok(functions.length >= 13); assert.ok(functions.every(f => !f.allowed));
        }
        processRest = spawn(postgrestBin, [], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env,
            PGRST_DB_URI: target.toString(), PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'service_role',
            PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(port), PGRST_DB_MAX_ROWS: '127' } });
        processRest.once('error', error => { processError = error; });
        const base = 'http://127.0.0.1:' + port;
        let ready = false;
        for (let i = 0; i < 80; i++) {
            if (processError) throw processError;
            if (processRest.exitCode != null) throw new Error('Disposable PostgREST exited during startup');
            try { if ((await fetch(base + '/')).ok) { ready = true; break; } } catch {}
            await delay(100);
        }
        assert.ok(ready, 'Disposable PostgREST must start');
        // Only this fixture adapter translates the production HTTPS origin into local
        // disposable HTTP; production createHttpsClient never accepts HTTP.
        const rest = createSupabaseClient({ env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SECRET_KEY: 'fixture' }, client: {
            async request(endpoint, options) {
                const u = new URL(endpoint);
                const response = await fetch(base + u.pathname.replace('/rest/v1', '') + u.search, {
                    method: options.method, headers: { ...options.headers, 'Content-Type': 'application/json' },
                    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) })
                });
                assert.ok(response.ok, 'PostgREST response HTTP ' + response.status);
                const body = await response.text(); return { data: body ? JSON.parse(body) : null, headers: response.headers };
            }, close() {}
        } });
        await rest.verifySchema();
        const remote = { ...rest, backend: 'supabase' }, q = createQueue(remote), other = createQueue(remote);
        const remoteRepo = createSupabaseRepository(remote), sqlRepo = createSqlRepository(db);
        await db.query("INSERT INTO listings (id, title, price, discovered_at) SELECT 'bulk-' || lpad(i::text,4,'0'), 'Fixture', CASE WHEN i % 2 = 0 THEN 2500 ELSE NULL END, '2026-10-01T00:00:00'::timestamp FROM generate_series(1,1205) i");
        assert.deepEqual(plain(await remoteRepo.listListings()), plain(await sqlRepo.listListings()));
        assert.deepEqual(plain(await remoteRepo.statsRows()), plain(await sqlRepo.statsRows()));
        assert.deepEqual(plain(await remoteRepo.listTours()), plain(await sqlRepo.listTours()));
        assert.equal((await remoteRepo.setListingStatus('missing', 'passed')).rowCount, 0);
        assert.equal((await remoteRepo.setListingStatus('bulk-0001', 'contacted')).rowCount, 1);
        assert.equal((await remoteRepo.insertListing({ id: 'bulk-0001', title: 'overwrite' })).rowCount, 0);
        assert.equal((await remoteRepo.saveTour({ id: 'historic-tour', proposed_time: 'overwrite' })).rowCount, 0);
        await db.query("UPDATE listings SET evaluation_status = 'failed' WHERE id LIKE 'bulk-%'");
        await remoteRepo.insertListing({ id: 'candidate', price: null });
        const claims = await Promise.all([q.claim(), other.claim()]); assert.equal(claims.filter(Boolean).length, 1);
        const old = claims.find(Boolean);
        assert.deepEqual((await Promise.all([q.reserveRequest(), other.reserveRequest()])).sort(), [false, true]);
        assert.equal(await q.reserveRequest(), false);
        const gap = (await db.query('SELECT EXTRACT(EPOCH FROM (next_request_at - clock_timestamp())) AS gap FROM evaluation_control')).rows[0].gap;
        assert.ok(Number(gap) <= 5 && Number(gap) > 0);
        await db.query("UPDATE listings SET evaluation_claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = 'candidate'");
        const evalValue = { true_gross_rent: 2500, is_fee: false, fee_estimate: 'None', red_flags: [], pros: ['One', 'Two'], suitability_score: 0,
            neighborhood: 'Fixture', is_preferred_neighborhood: false, commute_minutes: null, commute_summary: null, location_area: null, effective_monthly_rent: null };
        assert.equal(await q.complete(old, evalValue, { grade: 'Unknown' }), false);
        await q.recoverExpired();
        let row = (await remoteRepo.getListing('candidate')).rows[0]; assert.equal(row.evaluation_status, 'retry_wait');
        assert.equal(row.evaluation_last_error, 'Evaluation interrupted; claim expired.');
        assert.equal(await q.claim(), null);
        await db.query("UPDATE listings SET evaluation_next_at = clock_timestamp() WHERE id = 'candidate'");
        assert.equal(await q.claim({ noRetries: true }), null);
        assert.equal(await q.claim({ exclude: ['candidate'] }), null);
        const next = await q.claim(); assert.notEqual(next.evaluation_claim_token, old.evaluation_claim_token);
        assert.equal((await q.fail(old, 'invalid')).rowCount, 0);
        assert.equal((await q.release(old, 'shutdown')).rowCount, 0);
        assert.equal(await q.complete(next, evalValue, { grade: 'Unknown' }), true);
        row = (await remoteRepo.getListing('candidate')).rows[0]; assert.equal(row.suitability_score, 0); assert.equal(row.price, null);
        assert.equal(row.is_fee, false); assert.equal(row.pros, '["One","Two"]'); assert.equal(row.building_health, '{"grade":"Unknown"}');
        await remoteRepo.insertListing({ id: 'retry' });
        for (let attempt = 1; attempt <= 3; attempt++) {
            const claimed = await q.claim(); assert.equal(claimed.evaluation_attempts, attempt); await q.fail(claimed, 'timeout');
            row = (await remoteRepo.getListing('retry')).rows[0];
            assert.equal(row.evaluation_status, attempt === 3 ? 'failed' : 'retry_wait');
            if (attempt < 3) {
                const remaining = row.evaluation_next_at.getTime() - Date.now();
                assert.ok(remaining > (attempt === 1 ? 50000 : 290000));
                await db.query("UPDATE listings SET evaluation_next_at = clock_timestamp() WHERE id = 'retry'");
            }
        }
        assert.equal(await q.claim(), null);
        const until = await q.pause(900000); assert.ok(until - Date.now() > 890000);
        assert.ok(await other.pauseUntil() >= until); assert.equal(await other.reserveRequest(), false);
        await remoteRepo.insertListing({ id: 'paused' }); assert.equal(await other.claim(), null);
        assert.equal(await other.pause(300000), until);
        await db.query('UPDATE evaluation_control SET pause_until = NULL, next_request_at = NULL');
        const released = await q.claim(); await q.release(released, 'shutdown');
        assert.equal((await remoteRepo.getListing('paused')).rows[0].evaluation_attempts, 0);
        await db.query("UPDATE listings SET normalized_address = 'ADDRESS' WHERE id = 'paused'");
        await Promise.all(['one', 'two', 'one'].map(newUrl => remoteRepo.recordDuplicate({ normalizedAddress: 'ADDRESS', newUrl, newSource: 'fixture' })));
        assert.deepEqual(JSON.parse((await remoteRepo.getListing('paused')).rows[0].cross_posted_sources).map(s => s.url).sort(), ['one','two']);
    } finally {
        if (processRest && processRest.exitCode === null) { processRest.kill(); await new Promise(resolve => processRest.once('exit', resolve)); }
        await db?.end();
        if (started) await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
        for (const role of createdRoles.reverse()) await admin.query('DROP ROLE ' + role);
        await admin.end();
    }
});
