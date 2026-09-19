require('dotenv').config();
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let pgPool = null;
let sqliteDb = null;
let activeEngine = 'pg';

if (process.env.DATABASE_URL) {
    pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10000,
        ssl: process.env.DATABASE_URL.includes('localhost') 
            ? false 
            : { rejectUnauthorized: false }
    });

    pgPool.on('error', (err) => {
        console.error('Unexpected background database error:', err.message);
    });
}

function initSQLite() {
    return new Promise((resolve, reject) => {
        const dbPath = path.resolve(__dirname, '..', 'listings.db');
        sqliteDb = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            sqliteDb.serialize(() => {
                sqliteDb.run(`
                    CREATE TABLE IF NOT EXISTS listings (
                        id TEXT PRIMARY KEY,
                        url TEXT,
                        title TEXT,
                        price INTEGER,
                        bedrooms REAL,
                        bathrooms REAL,
                        discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        is_evaluated BOOLEAN DEFAULT FALSE,
                        red_flags TEXT,
                        pros TEXT,
                        suitability_score INTEGER,
                        true_gross_rent INTEGER,
                        is_fee BOOLEAN DEFAULT FALSE,
                        fee_estimate TEXT,
                        is_notified BOOLEAN DEFAULT FALSE,
                        status TEXT DEFAULT 'inbox',
                        neighborhood TEXT,
                        is_preferred BOOLEAN DEFAULT FALSE,
                        source TEXT DEFAULT 'streeteasy',
                        normalized_address TEXT,
                        cross_posted_sources TEXT
                    );
                `);
                sqliteDb.all(`PRAGMA table_info(listings)`, (pErr, columns) => {
                    if (!pErr && columns) {
                        const hasStatus = columns.some(col => col.name === 'status');
                        if (!hasStatus) sqliteDb.run(`ALTER TABLE listings ADD COLUMN status TEXT DEFAULT 'inbox'`);
                        const hasNeighborhood = columns.some(col => col.name === 'neighborhood');
                        if (!hasNeighborhood) sqliteDb.run(`ALTER TABLE listings ADD COLUMN neighborhood TEXT`);
                        const hasPreferred = columns.some(col => col.name === 'is_preferred');
                        if (!hasPreferred) sqliteDb.run(`ALTER TABLE listings ADD COLUMN is_preferred INTEGER DEFAULT 0`);
                        const hasSource = columns.some(col => col.name === 'source');
                        if (!hasSource) sqliteDb.run(`ALTER TABLE listings ADD COLUMN source TEXT DEFAULT 'streeteasy'`);
                        const hasNormAddr = columns.some(col => col.name === 'normalized_address');
                        if (!hasNormAddr) sqliteDb.run(`ALTER TABLE listings ADD COLUMN normalized_address TEXT`);
                        const hasCross = columns.some(col => col.name === 'cross_posted_sources');
                        if (!hasCross) sqliteDb.run(`ALTER TABLE listings ADD COLUMN cross_posted_sources TEXT`);
                        const hasIdHash = columns.some(col => col.name === 'id_hash');
                        if (!hasIdHash) sqliteDb.run(`ALTER TABLE listings ADD COLUMN id_hash TEXT`);
                        const hasCommuteMin = columns.some(col => col.name === 'commute_minutes');
                        if (!hasCommuteMin) sqliteDb.run(`ALTER TABLE listings ADD COLUMN commute_minutes INTEGER`);
                        const hasCommuteSum = columns.some(col => col.name === 'commute_summary');
                        if (!hasCommuteSum) sqliteDb.run(`ALTER TABLE listings ADD COLUMN commute_summary TEXT`);
                        const hasHealth = columns.some(col => col.name === 'building_health');
                        if (!hasHealth) sqliteDb.run(`ALTER TABLE listings ADD COLUMN building_health TEXT`);
                        const hasAppliedAt = columns.some(col => col.name === 'applied_at');
                        if (!hasAppliedAt) sqliteDb.run(`ALTER TABLE listings ADD COLUMN applied_at TIMESTAMP`);
                        const hasNudgeNotified = columns.some(col => col.name === 'nudge_notified');
                        if (!hasNudgeNotified) sqliteDb.run(`ALTER TABLE listings ADD COLUMN nudge_notified INTEGER DEFAULT 0`);
                        const hasNudgedAt = columns.some(col => col.name === 'nudged_at');
                        if (!hasNudgedAt) sqliteDb.run(`ALTER TABLE listings ADD COLUMN nudged_at TIMESTAMP`);
                        const hasNudgeCount = columns.some(col => col.name === 'nudge_count');
                        if (!hasNudgeCount) sqliteDb.run(`ALTER TABLE listings ADD COLUMN nudge_count INTEGER DEFAULT 0`);
                    }
                    resolve();
                });
            });
        });
    });
}

async function initDB() {
    if (pgPool) {
        try {
            const client = await pgPool.connect();
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS listings (
                        id TEXT PRIMARY KEY,
                        url TEXT,
                        title TEXT,
                        price INTEGER,
                        bedrooms REAL,
                        bathrooms REAL,
                        discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        is_evaluated BOOLEAN DEFAULT FALSE,
                        red_flags TEXT,
                        pros TEXT,
                        suitability_score INTEGER,
                        true_gross_rent INTEGER,
                        is_fee BOOLEAN DEFAULT FALSE,
                        fee_estimate TEXT,
                        is_notified BOOLEAN DEFAULT FALSE,
                        status TEXT DEFAULT 'inbox',
                        neighborhood TEXT,
                        is_preferred BOOLEAN DEFAULT FALSE,
                        source TEXT DEFAULT 'streeteasy',
                        normalized_address TEXT,
                        cross_posted_sources TEXT
                    );
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS neighborhood TEXT;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_preferred BOOLEAN DEFAULT FALSE;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'streeteasy';
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS normalized_address TEXT;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS cross_posted_sources TEXT;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS id_hash TEXT;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS commute_minutes INTEGER;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS commute_summary TEXT;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS broker_email TEXT;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS building_health TEXT;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS nudge_notified BOOLEAN DEFAULT FALSE;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMP;
                    ALTER TABLE listings ADD COLUMN IF NOT EXISTS nudge_count INTEGER DEFAULT 0;
                `);
                activeEngine = 'pg';
                return pool;
            } finally {
                client.release();
            }
        } catch (err) {
            console.warn(`⚠️ PostgreSQL connection failed (${err.message}). Falling back to local SQLite database.`);
            activeEngine = 'sqlite';
            await initSQLite();
            return pool;
        }
    } else {
        console.log("ℹ️ No DATABASE_URL provided. Using local SQLite database.");
        activeEngine = 'sqlite';
        await initSQLite();
        return pool;
    }
}

const pool = {
    async query(sql, params = []) {
        if (activeEngine === 'pg' && pgPool) {
            return await pgPool.query(sql, params);
        }
        
        if (!sqliteDb) {
            await initSQLite();
        }
        const converted = sql.replace(/\$(\d+)/g, '?');
        return new Promise((resolve, reject) => {
            const trimmed = converted.trim().toUpperCase();
            if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
                sqliteDb.all(converted, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve({ rows: rows || [] });
                });
            } else {
                sqliteDb.run(converted, params, function(err) {
                    if (err) reject(err);
                    else resolve({ rows: [], rowCount: this.changes });
                });
            }
        });
    },
    end() {
        if (activeEngine === 'pg' && pgPool) {
            return pgPool.end();
        }
        if (sqliteDb) {
            return new Promise((resolve) => sqliteDb.close(resolve));
        }
        return Promise.resolve();
    }
};

module.exports = { pool, initDB };
