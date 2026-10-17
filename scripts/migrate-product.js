require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const TABLES = ['listings', 'tour_schedules', 'evaluation_control', 'commute_control', 'feature_records'];
function databaseTargetHash(databaseUrl) {
    const url = new URL(databaseUrl);
    return hash([url.hostname, url.port, url.pathname, url.username].join('|'));
}
function validateBackup(directory, databaseUrl) {
    if (!directory) throw new Error('Run backup-scoring.js first and pass its private backup directory');
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077)) throw new Error('The backup directory must be private (mode 0700)');
    const raw = fs.readFileSync(path.join(directory, 'backup.json'));
    assert.equal(hash(raw), fs.readFileSync(path.join(directory, 'sha256'), 'utf8').trim(), 'Backup checksum mismatch');
    assert.equal(JSON.parse(raw).targetHash, databaseTargetHash(databaseUrl), 'Backup belongs to another database');
    assert.ok(fs.statSync(path.join(directory, 'schema.sql')).size > 0, 'Schema backup is required');
}
function writePrivate(file, content) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
}
async function snapshot(client) {
    const data = {}, existingTables = [];
    for (const table of TABLES) {
        const exists = (await client.query('SELECT to_regclass($1) AS name', ['public.' + table])).rows[0]?.name;
        if (!exists) {
            assert.ok(['commute_control', 'feature_records'].includes(table), `Required table ${table} is missing`);
            data[table] = [];
            continue;
        }
        existingTables.push(table);
        const order = table === 'feature_records' ? 'collection,id' : 'id';
        data[table] = (await client.query(`SELECT row_to_json(t) AS row FROM public.${table} t ORDER BY ${order}`)).rows;
    }
    const policies = (await client.query('SELECT * FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname', ['public'])).rows;
    return { data, policies, existingTables };
}
async function featureCatalog(client) {
    const queries = {
        columns: `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
            WHERE table_schema='public' AND table_name='feature_records' ORDER BY ordinal_position`,
        constraints: `SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
            WHERE c.conrelid=to_regclass('public.feature_records') ORDER BY c.conname`,
        indexes: "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='feature_records' ORDER BY indexname",
        grants: "SELECT * FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='feature_records' ORDER BY grantee,privilege_type",
        relation: `SELECT c.relrowsecurity,c.relforcerowsecurity,c.relacl,pg_get_userbyid(c.relowner) AS owner
            FROM pg_class c WHERE c.oid=to_regclass('public.feature_records')`,
        functions: `SELECT p.proname,pg_get_functiondef(p.oid) AS definition,p.proacl FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
            AND p.proname IN ('housing_feature_version','housing_feature_exchange','housing_requeue_evaluation') ORDER BY p.proname,p.oid`
    };
    const catalog = {};
    for (const [name, sql] of Object.entries(queries)) catalog[name] = (await client.query(sql)).rows;
    return catalog;
}
async function verify(client, before) {
    const after = await snapshot(client);
    assert.deepEqual(after.data, before.data, 'Migration changed existing data');
    assert.deepEqual(after.policies, before.policies, 'Migration changed existing row policies');
    assert.equal((await client.query('SELECT public.housing_feature_version() AS version')).rows[0]?.version, 1, 'Feature schema version mismatch');
    const functions = (await client.query(`SELECT
        to_regprocedure('public.housing_feature_exchange(text,text,text,bigint,boolean)') AS exchange,
        to_regprocedure('public.housing_requeue_evaluation(text)') AS requeue`)).rows[0];
    assert.ok(functions?.exchange && functions?.requeue, 'Feature functions are missing');
    assert.equal((await client.query("SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.feature_records')")).rows[0]?.relrowsecurity, true, 'Feature row-level security is disabled');
}
async function main({ directory = process.argv[2], env = process.env, ClientImpl = Client, log = console.log } = {}) {
    validateBackup(directory, env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname);
    // Match existing PostgreSQL maintenance tooling; application HTTPS clients
    // continue using their configured validated CA trust.
    const client = new ClientImpl({ connectionString: env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
    try {
        await client.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const before = await snapshot(client);
        const backup = { createdAt: new Date().toISOString(), targetHash: databaseTargetHash(env.DATABASE_URL), ...before, schema: await featureCatalog(client) };
        const content = JSON.stringify(backup, null, 2);
        const backupFile = path.join(directory, 'product-features-before.json');
        writePrivate(backupFile, content);
        writePrivate(path.join(directory, 'product-features-before.sha256'), hash(content) + '\n');
        assert.equal(hash(fs.readFileSync(backupFile)), hash(content), 'Private backup verification failed');
        const sql = fs.readFileSync(path.join(__dirname, '../migrations/003_product_features.sql'), 'utf8');
        await client.query(sql);
        await verify(client, before);
        // A repeated installation must preserve saved settings, events, histories,
        // worker receipts and the original application and notification state.
        await client.query(sql);
        await verify(client, before);
        await client.query('COMMIT');
        const result = { migrated: true, featureSchemaVersion: 1,
            unchangedListings: before.data.listings.length, unchangedTours: before.data.tour_schedules.length,
            unchangedFeatureRecords: before.data.feature_records.length, policiesPreserved: true, backup: backupFile };
        log(JSON.stringify(result));
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { await client.end(); }
}
module.exports = { main, validateBackup, databaseTargetHash, snapshot };
if (require.main === module) main().catch(() => {
    console.error('Product feature migration failed; no migration committed. Check the private backup and PostgreSQL connection.');
    process.exitCode = 1;
});
