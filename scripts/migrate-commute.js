require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { targetHash } = require('./backup-scoring');
async function main() {
    const dir = process.argv[2];
    if (!dir) throw new Error('Run backup-scoring.js first and pass its private backup directory');
    const raw = fs.readFileSync(path.join(dir, 'backup.json'));
    assert.equal(createHash('sha256').update(raw).digest('hex'), fs.readFileSync(path.join(dir, 'sha256'), 'utf8').trim());
    const backup = JSON.parse(raw);
    assert.equal(backup.targetHash, targetHash());
    assert.ok(fs.statSync(path.join(dir, 'schema.sql')).size > 0);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
    try {
        await client.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const snapshot = async () => {
            const data = {};
            for (const table of ['listings', 'tour_schedules', 'evaluation_control']) data[table] = (await client.query(`SELECT row_to_json(t) AS row FROM public.${table} t ORDER BY id`)).rows;
            data.policies = (await client.query('SELECT * FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname', ['public'])).rows;
            return data;
        };
        const before = await snapshot();
        const exists = (await client.query("SELECT to_regclass('public.commute_control') AS name")).rows[0].name;
        const accounting = exists ? (await client.query('SELECT * FROM public.commute_control ORDER BY id')).rows : null;
        // Supplement the original private backup with existing allowance state before DDL.
        fs.writeFileSync(path.join(dir, 'commute-control-before.json'), JSON.stringify(accounting), { mode: 0o600, flag: 'wx' });
        const sql = fs.readFileSync(path.join(__dirname, '../migrations/002_google_commute.sql'), 'utf8');
        await client.query(sql);
        assert.deepEqual(await snapshot(), before);
        if (accounting) assert.deepEqual((await client.query('SELECT * FROM public.commute_control ORDER BY id')).rows, accounting);
        const once = (await client.query('SELECT * FROM public.commute_control ORDER BY id')).rows;
        await client.query(sql);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual((await client.query('SELECT * FROM public.commute_control ORDER BY id')).rows, once);
        await client.query('COMMIT');
        console.log(JSON.stringify({ migrated: true, unchangedListings: before.listings.length,
            unchangedScored: before.listings.filter(l => l.row.is_evaluated).length, accountingPreserved: true }));
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await client.end(); }
}
main().catch(() => { console.error('Commute migration failed; no migration committed. Check the private backup and database connectivity.'); process.exitCode = 1; });
