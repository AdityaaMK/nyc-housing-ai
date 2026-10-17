const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openState(filename, identity) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    // A separate SQLite transaction is an OS-backed singleton lock. Crashes release
    // it automatically; the journal database still commits each delivery separately.
    const lock = new DatabaseSync(filename + '.lock');
    let db;
    try {
        fs.chmodSync(filename + '.lock', 0o600);
        lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        db = new DatabaseSync(filename);
        fs.chmodSync(filename, 0o600);
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS deliveries (
                id TEXT PRIMARY KEY, listing_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
                message_id INTEGER, error TEXT, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS listing_deliveries (listing_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL);`);
        const columns = new Set(db.prepare('PRAGMA table_info(deliveries)').all().map(row => row.name));
        for (const [name, type] of [['kind', "TEXT NOT NULL DEFAULT 'listing'"], ['payload', 'TEXT'], ['reference', 'TEXT']]) {
            if (!columns.has(name)) db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${type}`);
        }
        const get = (key, fallback = null) => {
            const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
            return row ? JSON.parse(row.value) : fallback;
        };
        const set = (key, value) => db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
        const transaction = work => {
            db.exec('BEGIN IMMEDIATE');
            try { const result = work(); db.exec('COMMIT'); return result; }
            catch (error) { db.exec('ROLLBACK'); throw error; }
        };
        if (get('identity') && get('identity') !== identity) throw new Error('Telegram state belongs to a different bot, chat, or database');
        set('identity', identity);
        // Telegram has no idempotency key. A crash after dispatch may have delivered
        // the message, so uncertain sends require review rather than blind replay.
        db.prepare("UPDATE deliveries SET status='uncertain', error='interrupted_send' WHERE status='sending'").run();
        return {
            get, set,
            enqueueEvents(events) { transaction(() => {
                for (const event of events) {
                    if (!['tour', 'nudge', 'price_change', 'tour_reminder'].includes(event.kind)) throw new Error('Unknown alert event');
                    db.prepare(`INSERT OR IGNORE INTO deliveries (id,listing_ids,created_at,kind,payload,reference)
                        VALUES (?,'[]',?,?,?,?)`).run('event:' + event.id, event.created_at, event.kind, JSON.stringify(event.payload), JSON.stringify(event.reference));
                }
            }); },
            enqueue(listings, now) {
                transaction(() => {
                    const add = (id, ids) => {
                        db.prepare('INSERT INTO deliveries (id, listing_ids, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(ids), now);
                        for (const listingId of ids) db.prepare('INSERT INTO listing_deliveries VALUES (?, ?)').run(listingId, id);
                    };
                    if (!get('initialized')) {
                        if (listings.length) add('backlog', listings.map(l => l.id));
                        set('initialized', true);
                    } else {
                        for (const listing of listings) {
                            if (!db.prepare('SELECT 1 FROM listing_deliveries WHERE listing_id=?').get(listing.id)) add('listing:' + listing.id, [listing.id]);
                        }
                    }
                });
            },
            ready: now => db.prepare("SELECT * FROM deliveries WHERE status IN ('pending','retry','sent') AND next_at <= ? ORDER BY created_at,id").all(now)
                .map(row => ({ ...row, listing_ids: JSON.parse(row.listing_ids), payload: row.payload && JSON.parse(row.payload),
                    reference: row.reference && JSON.parse(row.reference) })),
            preparing(id, ids) { db.prepare("UPDATE deliveries SET status='sending', listing_ids=?, attempts=attempts+1 WHERE id=?").run(JSON.stringify(ids), id); },
            sent(id, messageId) { db.prepare("UPDATE deliveries SET status='sent', message_id=?, error=NULL WHERE id=?").run(messageId, id); },
            finish(id, status = 'done') { db.prepare('UPDATE deliveries SET status=?, error=NULL WHERE id=?').run(status, id); },
            fail(id, status, error, nextAt = 0) { db.prepare('UPDATE deliveries SET status=?, error=?, next_at=? WHERE id=?').run(status, error, nextAt, id); },
            status() { return db.prepare('SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status').all(); },
            resolve(id, messageId) {
                const result = db.prepare(`UPDATE deliveries SET status=?, message_id=?, next_at=0, error=NULL
                    WHERE id=? AND status IN ('uncertain','failed')`).run(messageId ? 'sent' : 'retry', messageId || null, id);
                if (!result.changes) throw new Error('Delivery is not awaiting review');
            },
            close() { db.close(); lock.close(); }
        };
    } catch (error) { db?.close(); lock.close(); throw error; }
}

function readStatus(filename) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
        const heartbeat = db.prepare("SELECT value FROM meta WHERE key='heartbeat'").get();
        const value = heartbeat ? JSON.parse(heartbeat.value) : null;
        return { heartbeat: value, healthy: Boolean(value?.status === 'running' && Date.now() - value.at < 45000 &&
                value.lastPollAt && Date.now() - value.lastPollAt < 70000 && !value.pollError && !value.notifyError),
            deliveries: db.prepare('SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status').all(),
            needsReview: db.prepare("SELECT id, error FROM deliveries WHERE status IN ('uncertain','failed')").all() };
    } finally { db.close(); }
}

function resolveDelivery(filename, id, messageId = null) {
    if (messageId !== null && (!Number.isSafeInteger(messageId) || messageId <= 0)) throw new Error('A positive Telegram message ID is required');
    const reader = new DatabaseSync(filename, { readOnly: true });
    let identity;
    try { identity = JSON.parse(reader.prepare("SELECT value FROM meta WHERE key='identity'").get().value); }
    finally { reader.close(); }
    // Requires stopping the worker: the singleton lock also protects manual repair.
    const state = openState(filename, identity);
    try { state.resolve(id, messageId); } finally { state.close(); }
}
module.exports = { openState, readStatus, resolveDelivery };
