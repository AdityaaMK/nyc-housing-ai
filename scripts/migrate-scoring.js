require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { targetHash } = require('./backup-scoring');
const { migrateEvaluationQueue } = require('../src/evaluation_migration');
const { migrateRentTerms } = require('../src/rent_migration');
async function main() {
    const dir = process.argv[2];
    if (!dir) throw new Error('Private backup directory is required');
    const raw = fs.readFileSync(path.join(dir, 'backup.json'));
    assert.equal(createHash('sha256').update(raw).digest('hex'), fs.readFileSync(path.join(dir, 'sha256'), 'utf8').trim());
    const backup = JSON.parse(raw);
    assert.equal(backup.targetHash, targetHash());
    assert.ok(fs.statSync(path.join(dir, 'schema.sql')).size > 0);
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
    try {
        await client.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const before = (await client.query('SELECT * FROM public.listings ORDER BY id')).rows;
        await migrateEvaluationQueue(client.query.bind(client), 'pg');
        await migrateRentTerms(client.query.bind(client), 'pg');
        const after = (await client.query('SELECT * FROM public.listings ORDER BY id')).rows;
        for (let i = 0; i < before.length; i++) {
            for (const key of Object.keys(before[i]).filter(k => !k.startsWith('evaluation_'))) assert.deepEqual(after[i][key], before[i][key]);
        }
        assert.equal(before.length, after.length);
        await client.query('COMMIT');
        console.log(JSON.stringify({ migrated: after.length, preservedScored: before.filter(l => l.is_evaluated).length, evaluation: after.reduce((counts, l) => { counts[l.evaluation_status] = (counts[l.evaluation_status] || 0) + 1; return counts; }, {}) }));
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
    finally { await client.end(); }
}
main().catch(() => { console.error('Scoring migration failed; transaction rolled back.'); process.exitCode = 1; });
