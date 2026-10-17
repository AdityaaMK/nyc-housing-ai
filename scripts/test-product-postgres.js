// Integration test: creates/drops one disposable localhost PostgreSQL database.
// Run with PRODUCT_TEST_DATABASE_URL=postgresql://...@127.0.0.1:PORT/postgres.
// The adapter below exercises production Supabase serialization against real SQL
// RPC functions; no external PostgREST/Supabase host or production URL is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
    const connection = process.env.PRODUCT_TEST_DATABASE_URL;
    assert.ok(connection, 'Set PRODUCT_TEST_DATABASE_URL to a disposable localhost PostgreSQL instance.');
    const target = new URL(connection);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Remote databases are forbidden.');
    assert.ok(['postgres:', 'postgresql:'].includes(target.protocol), 'Expected a PostgreSQL URL.');
    // These modules must never initialize the user's configured database for a fixture run.
    process.env.DB_BACKEND = 'sqlite'; process.env.DATABASE_URL = '';
    const { migrate } = require('../src/db');
    const { createFeatureStore } = require('../src/feature_store');
    const { createSqlRepository, createSupabaseRepository } = require('../src/repository');
    const { createSupabaseClient } = require('../src/supabase_client');
    const admin = new Pool({ connectionString: target.toString(), connectionTimeoutMillis: 5000 });
    const name = 'housing_product_test_' + randomBytes(8).toString('hex');
    const createdRoles = [];
    let db, roleDb, created = false;
    const backgroundErrors = [];
    admin.on('error', error => backgroundErrors.push(error.code || 'database_error'));
    try {
        await admin.query('CREATE DATABASE ' + name); created = true;
        for (const role of ['anon', 'authenticated', 'service_role']) {
            if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
                await admin.query(`CREATE ROLE ${role}${role === 'service_role' ? ' BYPASSRLS' : ''}`); createdRoles.push(role);
            }
        }
        target.pathname = '/' + name;
        db = new Pool({ connectionString: target.toString(), max: 20 });
        db.on('error', error => backgroundErrors.push(error.code || 'database_error'));
        await migrate(db.query.bind(db), 'pg');
        await db.query("INSERT INTO listings(id,title,status,is_notified,is_evaluated,suitability_score,evaluation_status,evaluation_attempts) VALUES ('historic','Historic apartment','applied',true,true,88,'completed',2), ('historic-sql','Historic apartment','applied',true,true,88,'completed',2), ('passed','Passed apartment','passed',true,true,85,'completed',1), ('processing','Claimed apartment','applied',true,true,90,'processing',1)");
        await db.query("INSERT INTO tour_schedules(id,listing_address,status) VALUES ('historic-tour','20 West 34th Street','confirmed')");
        await db.query("INSERT INTO feature_records(collection,id,data,revision,updated_at) VALUES ('watchlist','historic','{\"saved\":true}',7,'2026-10-01T00:00:00.000Z')");
        await db.query('CREATE POLICY existing_private_policy ON feature_records FOR SELECT TO authenticated USING (false)');
        const beforeListings = (await db.query('SELECT * FROM listings ORDER BY id')).rows;
        const beforeTours = (await db.query('SELECT * FROM tour_schedules ORDER BY id')).rows;
        const beforeRecords = (await db.query('SELECT * FROM feature_records ORDER BY collection,id')).rows;
        const beforePolicies = (await db.query("SELECT * FROM pg_policies WHERE tablename='feature_records' ORDER BY policyname")).rows;
        const sql = fs.readFileSync(path.join(__dirname, '../migrations/003_product_features.sql'), 'utf8');
        await db.query('BEGIN'); await db.query(sql); await db.query(sql); await db.query('COMMIT');
        assert.deepEqual((await db.query('SELECT * FROM listings ORDER BY id')).rows, beforeListings);
        assert.deepEqual((await db.query('SELECT * FROM tour_schedules ORDER BY id')).rows, beforeTours);
        assert.deepEqual((await db.query('SELECT * FROM feature_records ORDER BY collection,id')).rows, beforeRecords);
        assert.deepEqual((await db.query("SELECT * FROM pg_policies WHERE tablename='feature_records' ORDER BY policyname")).rows, beforePolicies);
        assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='feature_records'::regclass")).rows[0].relrowsecurity, true);
        const functions = ['housing_feature_version()', 'housing_feature_exchange(text,text,text,bigint,boolean)', 'housing_requeue_evaluation(text)'];
        for (const role of ['anon', 'authenticated']) {
            for (const fn of functions) assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, fn])).rows[0].allowed, false);
            for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await db.query("SELECT has_table_privilege($1,'feature_records',$2) AS allowed", [role, operation])).rows[0].allowed, false);
        }
        for (const fn of functions) assert.equal((await db.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS allowed", [fn])).rows[0].allowed, true);
        for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await db.query("SELECT has_table_privilege('service_role','feature_records',$1) AS allowed", [operation])).rows[0].allowed, true);
        assert.ok((await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE proname IN ('housing_feature_version','housing_feature_exchange','housing_requeue_evaluation')")).rows.every(fn => !fn.prosecdef && fn.proconfig.includes('search_path=pg_catalog, public')));
        // Existing 001 setup grants the service backend these old table privileges.
        await db.query('GRANT USAGE ON SCHEMA public TO service_role');
        await db.query('GRANT SELECT,UPDATE ON listings TO service_role');
        roleDb = new Pool({ connectionString: target.toString(), options: '-c role=service_role', max: 20 });
        roleDb.on('error', error => backgroundErrors.push(error.code || 'database_error'));
        const rpcArguments = {
            housing_feature_version: () => [],
            housing_feature_exchange: json => [json.p_collection, json.p_id, json.p_data, json.p_revision, json.p_remove],
            housing_requeue_evaluation: json => [json.p_id]
        };
        let restReads = 0, rpcCalls = 0;
        const client = createSupabaseClient({ env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SECRET_KEY: 'private-local-fixture' }, client: {
            async request(endpoint, { json, headers, method }) {
                const url = new URL(endpoint); assert.equal(url.origin, 'https://fixture.test');
                assert.equal(headers.apikey, 'private-local-fixture');
                if (url.pathname.startsWith('/rest/v1/rpc/')) {
                    const fn = url.pathname.split('/').pop(); assert.ok(Object.hasOwn(rpcArguments, fn)); assert.equal(method, 'POST');
                    const args = rpcArguments[fn](json); rpcCalls++;
                    const result = await roleDb.query(`SELECT public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS value`, args);
                    return { data: result.rows[0].value, headers: new Headers() };
                }
                assert.equal(url.pathname, '/rest/v1/feature_records'); assert.equal(method, 'GET'); restReads++;
                const eq = key => {
                    const value = url.searchParams.get(key); assert.ok(value?.startsWith('eq."'));
                    return JSON.parse(value.slice(3));
                };
                const collection = eq('collection'), id = url.searchParams.has('id') ? eq('id') : null;
                const offset = Number(url.searchParams.get('offset') || 0), limit = Math.min(127, Number(url.searchParams.get('limit') || 1000));
                const args = id === null ? [collection] : [collection, id];
                const where = 'collection=$1' + (id === null ? '' : ' AND id=$2');
                const total = Number((await roleDb.query('SELECT count(*) AS total FROM feature_records WHERE ' + where, args)).rows[0].total);
                const result = await roleDb.query(`SELECT * FROM feature_records WHERE ${where} ORDER BY id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, limit, offset]);
                return { data: result.rows, headers: new Headers({ 'content-range': `${offset}-${offset + Math.max(0, result.rowCount - 1)}/${total}` }) };
            }, close() {}
        } });
        const remote = { ...client, backend: 'supabase' };
        const direct = createFeatureStore(db), rest = createFeatureStore(remote);
        await direct.verify(); await rest.verify();
        assert.deepEqual(await rest.get('watchlist', 'historic'), await direct.get('watchlist', 'historic'));
        const oddId = 'listing,with"quotes\\and(parentheses)';
        const original = await rest.create('watchlist', oddId, { listingId: oddId, saved: true });
        assert.equal(original.revision, 1);
        assert.deepEqual((await rest.create('watchlist', oddId, { saved: false })).data, original.data);
        assert.deepEqual(await direct.get('watchlist', oddId), await rest.get('watchlist', oddId));
        const initial = await direct.put('preferences', 'active', { budget: 3000 }, { expectedRevision: 0 });
        const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (index % 2 ? direct : rest).put('preferences', 'active', { budget: index }, { expectedRevision: initial.revision })));
        assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
        assert.ok(outcomes.filter(result => result.status === 'rejected').every(result => result.reason.status === 409));
        assert.equal((await rest.get('preferences', 'active')).revision, 2);
        const creates = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? direct : rest).create('watchlist', 'concurrent', { winner: index })));
        assert.ok(creates.every(row => row.revision === 1 && row.data.winner === creates[0].data.winner));
        await assert.rejects(rest.remove('preferences', 'active', { expectedRevision: 1 }), { status: 409 });
        await rest.remove('preferences', 'active', { expectedRevision: 2 });
        assert.equal(await direct.get('preferences', 'active'), null);
        const event = { id: 'price:one', kind: 'price_drop', reference: { listingId: 'historic' }, payload: { drop: 150 }, created_at: 100 };
        const queued = await rest.enqueueEvent(event);
        await direct.put('events', event.id, { ...queued.data, status: 'done', telegramMessageId: 12 }, { expectedRevision: queued.revision });
        const replay = await rest.enqueueEvent(event);
        assert.equal(replay.data.status, 'done'); assert.equal(replay.data.telegramMessageId, 12);
        // Verify pagination through the real client's Content-Range reader.
        await db.query("INSERT INTO feature_records(collection,id,data,revision,updated_at) SELECT 'pagination','id-'||lpad(i::text,4,'0'),'{\"saved\":true}',1,'2026-10-01T00:00:00.000Z' FROM generate_series(1,1205) i");
        assert.deepEqual(await rest.list('pagination'), await direct.list('pagination'));
        assert.equal((await rest.list('pagination')).length, 1205); assert.ok(restReads >= 20); assert.ok(rpcCalls >= 25);
        const remoteRepo = createSupabaseRepository(remote), sqlRepo = createSqlRepository(db);
        const requeue = remoteRepo.requeueEvaluation || remoteRepo.requeueListing;
        assert.equal(typeof requeue, 'function', 'Repository exposes requeue operation');
        assert.equal((await requeue('historic')).rowCount, 1);
        const historical = (await sqlRepo.getListing('historic')).rows[0];
        assert.equal(historical.status, 'applied'); assert.equal(historical.is_notified, true); assert.equal(historical.suitability_score, 88);
        assert.equal(historical.is_evaluated, false); assert.equal(historical.evaluation_status, 'pending'); assert.equal(historical.evaluation_attempts, 0);
        assert.equal((await requeue('historic')).rowCount, 0); assert.equal((await requeue('passed')).rowCount, 0); assert.equal((await requeue('processing')).rowCount, 0);
        assert.equal((await sqlRepo.requeueEvaluation('historic-sql')).rowCount, 1);
        const sqlHistorical = (await sqlRepo.getListing('historic-sql')).rows[0];
        for (const key of ['status', 'is_notified', 'suitability_score', 'is_evaluated', 'evaluation_status', 'evaluation_attempts', 'evaluation_next_at', 'evaluation_last_error', 'evaluation_claim_token', 'evaluation_claim_expires_at']) {
            assert.deepEqual(sqlHistorical[key], historical[key], 'SQL/RPC requeue parity for ' + key);
        }
        assert.equal((await sqlRepo.requeueEvaluation('passed')).rowCount, 0);
        assert.equal((await sqlRepo.requeueEvaluation('processing')).rowCount, 0);
        const savedRecords = (await db.query('SELECT * FROM feature_records ORDER BY collection,id')).rows;
        const savedListings = (await db.query('SELECT * FROM listings ORDER BY id')).rows;
        await db.query(sql);
        assert.deepEqual((await db.query('SELECT * FROM feature_records ORDER BY collection,id')).rows, savedRecords);
        assert.deepEqual((await db.query('SELECT * FROM listings ORDER BY id')).rows, savedListings);
    } finally {
        await roleDb?.end(); await db?.end();
        if (created) {
            // Pool.end resolves before the server necessarily consumes each socket's
            // final Terminate frame. Wait briefly instead of killing healthy clients.
            for (let attempt = 0; attempt < 40; attempt++) {
                if (!(await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [name])).rowCount) break;
                await delay(25);
            }
            await admin.query('DROP DATABASE ' + name);
        }
        for (const role of createdRoles.reverse()) await admin.query('DROP ROLE ' + role);
        await admin.end();
    }
    assert.deepEqual(backgroundErrors, []);
    console.log('PostgreSQL + Supabase adapter checks passed: additive/idempotent migration, preserved listing/tour/feature data and policies, RLS/grants, invoker RPCs, CAS races, idempotent creation/events, pagination, and safe requeue.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
