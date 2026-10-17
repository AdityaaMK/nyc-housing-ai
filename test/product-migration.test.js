const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { main, databaseTargetHash } = require('../scripts/migrate-product');
const databaseUrl = 'postgresql://fixture:private-fixture@localhost:5432/housing_test';
const digest = value => createHash('sha256').update(value).digest('hex');
function backup() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-migration-'));
    fs.chmodSync(directory, 0o700);
    const content = JSON.stringify({ targetHash: databaseTargetHash(databaseUrl), data: {} });
    fs.writeFileSync(path.join(directory, 'backup.json'), content, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'sha256'), digest(content), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'schema.sql'), '-- fixture schema', { mode: 0o600 });
    return directory;
}
function clientFixture(directory, { existingFeatures = true, changedRows = false, version = 1 } = {}) {
    const queries = [], logs = [], tables = {
        listings: [{ id: 'listing', status: 'applied', is_notified: true, suitability_score: 90 }],
        tour_schedules: [{ id: 'tour', status: 'confirmed' }],
        evaluation_control: [{ id: 1, pause_until: '2026-10-17T18:00:00Z' }],
        commute_control: [{ id: 1, attempts: '[1,2]' }],
        ...(existingFeatures ? { feature_records: [{ collection: 'settings', id: 'search', revision: 4, data: '{"private":"saved"}' }] } : {})
    };
    let migrations = 0, closed = false;
    class ClientImpl {
        async connect() {}
        async end() { closed = true; }
        async query(sql, params = []) {
            queries.push(sql);
            if (sql.includes('-- Additive feature storage.')) {
                // No schema mutation may occur until the fresh backup and digest
                // have both reached the private filesystem.
                const file = path.join(directory, 'product-features-before.json');
                assert.equal(digest(fs.readFileSync(file)), fs.readFileSync(path.join(directory, 'product-features-before.sha256'), 'utf8').trim());
                migrations++;
                tables.feature_records ||= [];
                if (changedRows) tables.listings[0].status = 'passed';
                return { rows: [] };
            }
            if (sql.startsWith('SELECT to_regclass($1)')) return { rows: [{ name: tables[params[0].slice('public.'.length)] ? params[0] : null }] };
            if (sql.startsWith('SELECT row_to_json')) {
                const table = sql.match(/FROM public\.([a-z_]+)/)[1];
                return { rows: tables[table].map(row => ({ row: structuredClone(row) })) };
            }
            if (sql.includes('FROM pg_policies')) return { rows: [{ tablename: 'listings', policyname: 'fixture_policy' }] };
            if (sql.startsWith('SELECT public.housing_feature_version')) return { rows: [{ version }] };
            if (sql.includes("to_regprocedure('public.housing_feature_exchange")) return { rows: [{ exchange: 'housing_feature_exchange', requeue: 'housing_requeue_evaluation' }] };
            if (sql.startsWith('SELECT relrowsecurity')) return { rows: [{ relrowsecurity: true }] };
            return { rows: [] };
        }
    }
    return { ClientImpl, queries, logs, log: value => logs.push(value), get migrations() { return migrations; }, get closed() { return closed; } };
}
test('product migration backs up existing records before DDL and verifies idempotency', async () => {
    const directory = backup(), client = clientFixture(directory);
    try {
        const result = await main({ directory, env: { DATABASE_URL: databaseUrl }, ClientImpl: client.ClientImpl, log: client.log });
        assert.equal(result.featureSchemaVersion, 1); assert.equal(result.unchangedFeatureRecords, 1);
        assert.equal(client.migrations, 2); assert.ok(client.queries.includes('COMMIT')); assert.ok(!client.queries.includes('ROLLBACK')); assert.equal(client.closed, true);
        const file = path.join(directory, 'product-features-before.json'), saved = JSON.parse(fs.readFileSync(file));
        assert.equal(fs.statSync(file).mode & 0o077, 0);
        assert.equal(saved.data.listings[0].row.status, 'applied'); assert.equal(saved.data.listings[0].row.is_notified, true);
        assert.equal(saved.data.feature_records[0].row.revision, 4); assert.equal(saved.data.commute_control.length, 1);
        assert.equal(saved.data.evaluation_control.length, 1); assert.ok(saved.schema.functions);
        assert.ok(!client.logs.join('\n').includes('private-fixture')); assert.ok(!client.logs.join('\n').includes('"saved"'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('first product migration permits an absent feature table without inventing saved records', async () => {
    const directory = backup(), client = clientFixture(directory, { existingFeatures: false });
    try {
        const result = await main({ directory, env: { DATABASE_URL: databaseUrl }, ClientImpl: client.ClientImpl, log: client.log });
        assert.equal(result.unchangedFeatureRecords, 0); assert.equal(client.migrations, 2);
        const saved = JSON.parse(fs.readFileSync(path.join(directory, 'product-features-before.json')));
        assert.deepEqual(saved.data.feature_records, []); assert.ok(!saved.existingTables.includes('feature_records'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('product migration rolls back unexpected row changes or an invalid schema version', async () => {
    for (const options of [{ changedRows: true }, { version: 2 }]) {
        const directory = backup(), client = clientFixture(directory, options);
        try {
            await assert.rejects(main({ directory, env: { DATABASE_URL: databaseUrl }, ClientImpl: client.ClientImpl, log: client.log }), /Migration changed existing data|Feature schema version mismatch/);
            assert.ok(client.queries.includes('ROLLBACK')); assert.ok(!client.queries.includes('COMMIT')); assert.equal(client.closed, true);
            assert.ok(fs.existsSync(path.join(directory, 'product-features-before.json')));
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
});
test('tampered backups and a different database target fail before connecting', async () => {
    for (const kind of ['tampered', 'target', 'permissions']) {
        const directory = backup();
        let clients = 0;
        class NoConnection { constructor() { clients++; } }
        try {
            if (kind === 'tampered') fs.appendFileSync(path.join(directory, 'backup.json'), ' ');
            if (kind === 'permissions') fs.chmodSync(directory, 0o755);
            const url = kind === 'target' ? databaseUrl.replace('housing_test', 'other_database') : databaseUrl;
            await assert.rejects(main({ directory, env: { DATABASE_URL: url }, ClientImpl: NoConnection }), /Backup checksum mismatch|Backup belongs to another database|must be private/);
            assert.equal(clients, 0);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
});
test('an existing private product backup is never overwritten and prevents DDL', async () => {
    const directory = backup(), client = clientFixture(directory);
    fs.writeFileSync(path.join(directory, 'product-features-before.json'), 'keep me', { mode: 0o600 });
    try {
        await assert.rejects(main({ directory, env: { DATABASE_URL: databaseUrl }, ClientImpl: client.ClientImpl, log: client.log }), error => error.code === 'EEXIST');
        assert.equal(client.migrations, 0); assert.ok(client.queries.includes('ROLLBACK'));
        assert.equal(fs.readFileSync(path.join(directory, 'product-features-before.json'), 'utf8'), 'keep me');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
