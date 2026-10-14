// Restore the private snapshot only into disposable LOCAL PostgreSQL, then verify the migration.
const { Client } = require('pg');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { migrateEvaluationQueue } = require('../src/evaluation_migration');
const { migrateRentTerms } = require('../src/rent_migration');
async function main() {
    const url = process.env.QUEUE_TEST_DATABASE_URL;
    assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Disposable LOCAL PostgreSQL required');
    const dir = process.argv[2], snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json')));
    const schema = 'housing_restore_test_' + randomBytes(8).toString('hex');
    const client = new Client({ connectionString: url });
    try {
        await client.connect();
        await client.query("SET TIME ZONE 'UTC'");
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8').replaceAll('public.', schema + '.'));
        for (const table of ['listings', 'tour_schedules']) {
            await client.query(`INSERT INTO ${schema}.${table} SELECT * FROM json_populate_recordset(NULL::${schema}.${table}, $1)`, [JSON.stringify(snapshot.data[table])]);
            const restored = (await client.query(`SELECT row_to_json(t) AS data FROM ${schema}.${table} t ORDER BY id`)).rows.map(r => r.data);
            assert.deepEqual(restored, snapshot.data[table]);
        }
        await client.query(`SET search_path TO ${schema}`);
        await migrateEvaluationQueue(client.query.bind(client), 'pg');
        await migrateRentTerms(client.query.bind(client), 'pg');
        const after = (await client.query('SELECT row_to_json(t) AS data FROM listings t ORDER BY id')).rows.map(r => r.data);
        for (let i = 0; i < after.length; i++) {
            for (const key of Object.keys(snapshot.data.listings[i])) assert.deepEqual(after[i][key], snapshot.data.listings[i][key]);
            assert.equal(after[i].evaluation_status, after[i].is_evaluated ? 'completed' : 'pending');
        }
        console.log(JSON.stringify({ restored: after.length, preservedScored: after.filter(l => l.is_evaluated).length, migrationVerified: true }));
    } finally {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await client.end();
    }
}
main().catch(() => { console.error('Private backup restore verification failed.'); process.exitCode = 1; });
