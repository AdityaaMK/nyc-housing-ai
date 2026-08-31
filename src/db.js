require('dotenv').config();
const { Pool } = require('pg');

// Use DATABASE_URL from .env. We use ssl rejectUnauthorized false for hosted DBs like Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') 
        ? false 
        : { rejectUnauthorized: false }
});

// Prevent Node process from crashing if a background idle connection drops (common with free-tier cloud DBs)
pool.on('error', (err) => {
    console.error('Unexpected background database error:', err.message);
});

async function initDB() {
    if (!process.env.DATABASE_URL) {
        console.warn("⚠️ DATABASE_URL is not set in .env! Database connection will fail.");
        return null;
    }
    
    const client = await pool.connect();
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
                status TEXT DEFAULT 'inbox'
            );
        `);
    } finally {
        client.release();
    }
    return pool;
}

module.exports = { pool, initDB };
