require('dotenv').config();
const { databaseBackend } = require('./backend_config');
const path = require('path');
const crypto = require('crypto');
const { migrateEvaluationQueue } = require('./evaluation_migration');
const { migrateRentTerms } = require('./rent_migration');

const columns = {
    url: 'TEXT', title: 'TEXT', price: 'INTEGER', bedrooms: 'REAL', bathrooms: 'REAL',
    discovered_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
    is_evaluated: 'BOOLEAN DEFAULT FALSE', red_flags: 'TEXT', pros: 'TEXT',
    suitability_score: 'INTEGER', true_gross_rent: 'INTEGER', is_fee: 'BOOLEAN DEFAULT FALSE',
    fee_estimate: 'TEXT', is_notified: 'BOOLEAN DEFAULT FALSE', status: "TEXT DEFAULT 'inbox'",
    location_area: 'TEXT', neighborhood: 'TEXT', is_preferred: 'BOOLEAN DEFAULT FALSE', source: "TEXT DEFAULT 'streeteasy'",
    normalized_address: 'TEXT', cross_posted_sources: 'TEXT', id_hash: 'TEXT',
    commute_minutes: 'INTEGER', commute_summary: 'TEXT', broker_email: 'TEXT', building_health: 'TEXT',
    manhattan_commute_minutes: 'REAL', manhattan_arrival_station: 'TEXT', manhattan_commute_summary: 'TEXT',
    applied_at: 'TIMESTAMP', nudge_notified: 'BOOLEAN DEFAULT FALSE', nudged_at: 'TIMESTAMP',
    nudge_count: 'INTEGER DEFAULT 0'
};
const tourColumns = {
    listing_address: 'TEXT', broker_email: 'TEXT', broker_name: 'TEXT', proposed_time: 'TEXT',
    proposed_datetime: 'TEXT', special_instructions: 'TEXT', status: "TEXT DEFAULT 'proposed'",
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
};
let pgPool;
let sqliteDb;
let ready;
let activeEngine;
const backend = databaseBackend();
let supabase;
if (backend === 'postgres') {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
        ssl: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname) ? false : { rejectUnauthorized: false } });
    pgPool.on('error', err => console.error('Unexpected background database error:', err.message));
}
function sqliteQuery(sql, params = []) {
    // Expand repeated and out-of-order PostgreSQL parameters in their occurrence order.
    const values = [];
    const converted = sql.replace(/\$(\d+)/g, (_, number) => {
        const value = params[Number(number) - 1];
        values.push(typeof value === 'boolean' ? Number(value) : value);
        return '?';
    });
    return new Promise((resolve, reject) => {
        if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(converted) || /\bRETURNING\b/i.test(converted)) {
            sqliteDb.all(converted, values, (err, rows) => err ? reject(err) : resolve({ rows, rowCount: rows.length }));
        } else {
            sqliteDb.run(converted, values, function(err) {
                err ? reject(err) : resolve({ rows: [], rowCount: this.changes });
            });
        }
    });
}
async function migrate(query, engine) {
    for (const [table, fields] of Object.entries({ listings: columns, tour_schedules: tourColumns })) {
        await query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, ${Object.entries(fields).map(([name, type]) => `${name} ${type}`).join(', ')})`);
        if (engine === 'sqlite') {
            const { rows } = await query(`PRAGMA table_info(${table})`);
            for (const [name, type] of Object.entries(fields)) {
                if (!rows.some(row => row.name === name)) await query(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
            }
        } else {
            for (const [name, type] of Object.entries(fields)) await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
        }
    }
    await migrateEvaluationQueue(query, engine);
    await migrateRentTerms(query, engine);
    const { rows } = await query('SELECT id FROM listings WHERE id_hash IS NULL');
    for (const row of rows) await query('UPDATE listings SET id_hash = $1 WHERE id = $2', [crypto.createHash('md5').update(row.id).digest('hex'), row.id]);
}
async function initialize() {
    if (backend === 'supabase') {
        supabase = require('./supabase_client').createSupabaseClient();
        await supabase.verifySchema();
        activeEngine = 'supabase';
    } else if (pgPool) {
        // Never silently switch to an empty local database when a configured database is unavailable.
        await migrate(pgPool.query.bind(pgPool), 'pg');
        activeEngine = 'pg';
    } else {
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = process.env.SQLITE_PATH || path.resolve(__dirname, '..', 'listings.db');
        await new Promise((resolve, reject) => {
            sqliteDb = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve());
        });
        sqliteDb.configure('busyTimeout', 10000);
        await migrate(sqliteQuery, 'sqlite');
        activeEngine = 'sqlite';
    }
    return pool;
}
function initDB() {
    if (!ready) ready = initialize();
    return ready;
}
const pool = {
    backend,
    async rpc(name, args) { await initDB(); return supabase.rpc(name, args); },
    async rest(table, options) { await initDB(); return supabase.rest(table, options); },
    async readAll(table, options) { await initDB(); return supabase.readAll(table, options); },
    async query(sql, params = []) {
        if (backend === 'supabase') throw new Error('Direct SQL is unavailable with DB_BACKEND=supabase; use repository operations or a local maintenance connection');
        await initDB();
        return activeEngine === 'pg' ? pgPool.query(sql, params) : sqliteQuery(sql, params);
    },
    async end() {
        if (supabase) await supabase.close();
        if (pgPool) await pgPool.end();
        if (sqliteDb) await new Promise((resolve, reject) => sqliteDb.close(err => err ? reject(err) : resolve()));
    }
};
module.exports = { pool, initDB, migrate };
