require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
function targetHash() {
    const u = new URL(process.env.DATABASE_URL);
    return createHash('sha256').update([u.hostname, u.port, u.pathname, u.username].join('|')).digest('hex');
}
async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
    const dir = path.join(os.homedir(), '.local/state/nyc-housing-ai/backups', 'scoring-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    try {
        await client.connect();
        await client.query("SET TIME ZONE 'UTC'");
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const data = {};
        for (const table of ['listings', 'tour_schedules']) data[table] = (await client.query(`SELECT row_to_json(t) AS data FROM public.${table} t ORDER BY id`)).rows.map(r => r.data);
        const schema = {};
        const queries = {
            relations: `SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.reloptions,
                pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S') ORDER BY c.relname`,
            columns: `SELECT c.relname, a.attname, a.attnum, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS default_expression
                FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid JOIN pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`,
            constraints: `SELECT c.relname, x.conname, pg_get_constraintdef(x.oid) AS definition FROM pg_constraint x
                JOIN pg_class c ON c.oid = x.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
            indexes: `SELECT * FROM pg_indexes WHERE schemaname = 'public'`,
            policies: `SELECT * FROM pg_policies WHERE schemaname = 'public'`,
            grants: `SELECT * FROM information_schema.role_table_grants WHERE table_schema = 'public'`,
            triggers: `SELECT c.relname, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
            functions: `SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`,
            views: `SELECT * FROM pg_views WHERE schemaname = 'public'`,
            sequences: `SELECT * FROM pg_sequences WHERE schemaname = 'public'`
        };
        for (const [key, sql] of Object.entries(queries)) schema[key] = (await client.query(sql)).rows;
        const backup = { createdAt: new Date().toISOString(), targetHash: targetHash(), schema, data };
        const content = JSON.stringify(backup, null, 2);
        fs.writeFileSync(path.join(dir, 'backup.json'), content, { mode: 0o600, flag: 'wx' });
        const quote = s => '"' + s.replaceAll('"', '""') + '"';
        // Standalone table definitions supplement the complete catalog snapshot.
        const ddl = ['-- Private pre-scoring schema backup. Data is in backup.json.'];
        for (const table of ['listings', 'tour_schedules']) {
            const cols = schema.columns.filter(c => c.relname === table).map(c => `  ${quote(c.attname)} ${c.type}${c.default_expression ? ' DEFAULT ' + c.default_expression : ''}${c.attnotnull ? ' NOT NULL' : ''}`);
            const constraints = schema.constraints.filter(c => c.relname === table).map(c => `  CONSTRAINT ${quote(c.conname)} ${c.definition}`);
            ddl.push(`CREATE TABLE public.${quote(table)} (\n${[...cols, ...constraints].join(',\n')}\n);`);
            for (const index of schema.indexes.filter(i => i.tablename === table && !schema.constraints.some(c => c.relname === table && c.conname === i.indexname))) ddl.push(index.indexdef + ';');
            const relation = schema.relations.find(r => r.relname === table);
            if (relation?.relrowsecurity) ddl.push(`ALTER TABLE public.${quote(table)} ENABLE ROW LEVEL SECURITY;`);
            if (relation?.relforcerowsecurity) ddl.push(`ALTER TABLE public.${quote(table)} FORCE ROW LEVEL SECURITY;`);
        }
        fs.writeFileSync(path.join(dir, 'schema.sql'), ddl.join('\n\n') + '\n', { mode: 0o600, flag: 'wx' });
        fs.writeFileSync(path.join(dir, 'sha256'), createHash('sha256').update(content).digest('hex') + '\n', { mode: 0o600, flag: 'wx' });
        await client.query('COMMIT');
        console.log(JSON.stringify({ backup: dir, listings: data.listings.length, scored: data.listings.filter(l => l.is_evaluated).length, tours: data.tour_schedules.length }));
    } finally { await client.end(); }
}
module.exports = { targetHash };
if (require.main === module) main().catch(() => { console.error('Private database backup failed. No migration applied.'); process.exitCode = 1; });
