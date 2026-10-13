// Creates and removes one disposable local database. Never use production URLs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createAllowance } = require('../src/commute_allowance');
const { createSupabaseClient } = require('../src/supabase_client');
async function main() {
    const url = process.env.COMMUTE_TEST_DATABASE_URL;
    assert.ok(url && ['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'Requires disposable localhost PostgreSQL');
    const admin = new Pool({ connectionString: url });
    const name = 'commute_migration_' + require('crypto').randomBytes(6).toString('hex');
    const roles = []; let db, remoteDb;
    try {
        await admin.query(`CREATE DATABASE ${name}`);
        for (const role of ['anon', 'authenticated', 'service_role']) {
            if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
                await admin.query(`CREATE ROLE ${role}${role === 'service_role' ? ' BYPASSRLS' : ''}`); roles.push(role);
            }
        }
        const target = new URL(url); target.pathname = '/' + name;
        db = new Pool({ connectionString: target.toString() });
        await db.query("CREATE TABLE listings (id text PRIMARY KEY, suitability_score integer, status text, is_notified boolean); INSERT INTO listings VALUES ('scored', 88, 'applied', true)");
        const before = (await db.query('SELECT * FROM listings')).rows;
        const sql = fs.readFileSync(require('path').join(__dirname, '../migrations/002_google_commute.sql'), 'utf8');
        await db.query('BEGIN'); await db.query(sql); await db.query(sql); await db.query('COMMIT');
        assert.deepEqual((await db.query('SELECT * FROM listings')).rows, before);
        assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'commute_control'::regclass")).rows[0].relrowsecurity, true);
        for (const role of ['anon', 'authenticated']) {
            for (const fn of ['housing_commute_state()', 'housing_commute_exchange(bigint,text,text,bigint)']) {
                assert.equal((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, fn])).rows[0].allowed, false);
            }
            assert.equal((await db.query("SELECT has_table_privilege($1, 'commute_control', 'SELECT') AS allowed", [role])).rows[0].allowed, false);
        }
        remoteDb = new Pool({ connectionString: target.toString(), options: '-c role=service_role' });
        await db.query('GRANT USAGE ON SCHEMA public TO service_role');
        // Exercise the real HTTPS client RPC serializer against the migrated RPCs.
        const client = createSupabaseClient({ env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SECRET_KEY: 'private-fixture' }, client: {
            async request(endpoint, { json, headers }) {
                assert.equal(headers.apikey, 'private-fixture');
                const fn = new URL(endpoint).pathname.split('/').pop();
                const args = fn === 'housing_commute_state' ? [] : [json.p_revision, json.p_attempts, json.p_disabled_config, json.p_pause_until];
                assert.ok(['housing_commute_state', 'housing_commute_exchange'].includes(fn));
                const result = await remoteDb.query(`SELECT public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS value`, args);
                return { data: result.rows[0].value, headers: new Headers() };
            }, close() {}
        } });
        const now = Date.parse('2026-10-12T20:00:00Z');
        await db.query('UPDATE commute_control SET attempts = $1', [JSON.stringify(Array(299).fill(now))]);
        const remote = { ...client, backend: 'supabase' };
        const results = await Promise.all(Array.from({ length: 20 }, () => createAllowance(remote, () => now).reserve('configured')));
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal((await createAllowance(remote, () => now).status('configured')).remaining.daily, 0);
        const accounting = (await db.query('SELECT * FROM commute_control')).rows;
        await db.query(sql); assert.deepEqual((await db.query('SELECT * FROM commute_control')).rows, accounting);
        assert.deepEqual((await db.query('SELECT * FROM listings')).rows, before);
        console.log('PostgreSQL + Supabase RPC checks passed: migration, idempotency, preserved scores/accounting, RLS, role grants, atomic reservations.');
    } finally {
        await remoteDb?.end(); await db?.end();
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        for (const role of roles.reverse()) await admin.query(`DROP ROLE ${role}`);
        await admin.end();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
