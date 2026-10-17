const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const stateFile = () => path.join(process.env.INBOX_STATE_DIR || path.resolve(__dirname, '../.state/inbox'), 'worker.sqlite');
function inboxIdentity(backend, env = process.env) {
    const database = backend === 'supabase' ? env.SUPABASE_URL : backend === 'postgres' ? env.DATABASE_URL : path.resolve(env.SQLITE_PATH || path.join(__dirname, '../listings.db'));
    return crypto.createHash('sha256').update(JSON.stringify([String(env.GMAIL_USER || '').toLowerCase(),
        env.MAIL_BACKEND || 'smtp-imap', backend, database, env.TELEGRAM_CHAT_ID])).digest('hex');
}

function openInboxState(filename, identity, { worker = true } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    let lock, db;
    try {
        if (worker) {
            lock = new DatabaseSync(filename + '.lock');
            fs.chmodSync(filename + '.lock', 0o600);
            lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        }
        db = new DatabaseSync(filename);
        fs.chmodSync(filename, 0o600);
        db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, uid TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, proposal TEXT, error TEXT, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS replies (sender TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS conversation_replies (id TEXT PRIMARY KEY, sender TEXT NOT NULL,
                listing_id TEXT, received_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, reference TEXT NOT NULL,
                payload TEXT NOT NULL, created_at INTEGER NOT NULL, forwarded_at INTEGER);`);
        const get = (key, fallback = null) => {
            const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
            return row ? JSON.parse(row.value) : fallback;
        };
        const set = (key, value) => db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
        const transaction = fn => {
            db.exec('BEGIN IMMEDIATE');
            try { const result = fn(); db.exec('COMMIT'); return result; }
            catch (error) { db.exec('ROLLBACK'); throw error; }
        };
        transaction(() => {
            if (get('identity') && get('identity') !== identity) throw new Error('Inbox journal belongs to a different mailbox, database, or chat');
            set('identity', identity);
        });
        const enqueue = event => db.prepare('INSERT OR IGNORE INTO outbox (id,kind,reference,payload,created_at) VALUES (?,?,?,?,?)')
            .run(event.id, event.kind, JSON.stringify(event.reference), JSON.stringify(event.payload), event.created_at);
        return {
            get, set, enqueue,
            discover(messages, at) { transaction(() => {
                for (const { id, uid } of messages) db.prepare('INSERT OR IGNORE INTO messages (id,uid,created_at) VALUES (?,?,?)').run(id, JSON.stringify(uid), at);
                set('last_scan_at', at);
            }); },
            ready: (at, limit = 25) => db.prepare("SELECT * FROM messages WHERE status NOT IN ('done','ignored') AND next_at<=? ORDER BY created_at,id LIMIT ?")
                .all(at, limit).map(row => ({ ...row, uid: JSON.parse(row.uid), proposal: row.proposal && JSON.parse(row.proposal) })),
            unfinished: () => db.prepare("SELECT COUNT(*) AS count FROM messages WHERE status NOT IN ('done','ignored')").get().count,
            prepared(id, proposal) { db.prepare("UPDATE messages SET proposal=?, status='prepared', error=NULL WHERE id=?").run(JSON.stringify(proposal), id); },
            finish(id, status = 'done') { db.prepare('UPDATE messages SET status=?, error=NULL WHERE id=?').run(status, id); },
            completeTour(id, event) { transaction(() => {
                enqueue(event);
                db.prepare("UPDATE messages SET status='done', error=NULL WHERE id=?").run(id);
            }); },
            fail(id, nextAt) { db.prepare("UPDATE messages SET status='retry', attempts=attempts+1, next_at=?, error='message_processing_failed' WHERE id=?").run(nextAt, id); },
            recordReply(sender, at) { if (sender && Number.isFinite(at)) db.prepare(`INSERT INTO replies VALUES (?,?)
                ON CONFLICT(sender) DO UPDATE SET received_at=MAX(received_at,excluded.received_at)`).run(sender, at); },
            repliedSince: (sender, at) => Boolean(db.prepare('SELECT 1 FROM replies WHERE sender=? AND received_at>=?').get(sender, at)),
            syncConversationReplies(rows) { transaction(() => {
                for (const row of rows) {
                    const receivedAt = Date.parse(row.at);
                    if (!Number.isFinite(receivedAt)) continue;
                    db.prepare(`INSERT INTO conversation_replies (id,sender,listing_id,received_at) VALUES (?,?,?,?)
                        ON CONFLICT(id) DO UPDATE SET sender=excluded.sender,listing_id=excluded.listing_id,received_at=excluded.received_at`)
                        .run(row.id, row.sender, row.listingId || null, receivedAt);
                }
            }); },
            repliedForListingSince(sender, listingId, at) {
                // Pre-migration sender-only evidence stays conservative. New
                // exact thread matches suppress only the corresponding listing.
                return Boolean(db.prepare('SELECT 1 FROM replies WHERE sender=? AND received_at>=?').get(sender, at) ||
                    db.prepare('SELECT 1 FROM conversation_replies WHERE received_at>=? AND (listing_id=? OR (listing_id IS NULL AND sender=?)) LIMIT 1')
                        .get(at, listingId || '', sender));
            },
            events: () => db.prepare('SELECT * FROM outbox WHERE forwarded_at IS NULL ORDER BY created_at,id LIMIT 100').all()
                .map(row => ({ ...row, reference: JSON.parse(row.reference), payload: JSON.parse(row.payload) })),
            forwarded(id, at) { db.prepare('UPDATE outbox SET forwarded_at=? WHERE id=?').run(at, id); },
            close() { db.close(); lock?.close(); }
        };
    } catch (error) { db?.close(); lock?.close(); throw error; }
}

function readInboxStatus(filename, now = Date.now()) {
    if (!fs.existsSync(filename)) return { healthy: false, status: 'not_initialized' };
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
        const value = db.prepare("SELECT value FROM meta WHERE key='heartbeat'").get();
        const heartbeat = value ? JSON.parse(value.value) : null;
        return { heartbeat, healthy: Boolean(heartbeat?.status === 'running' && now - heartbeat.at < 45000 &&
            heartbeat.lastCheckAt && now - heartbeat.lastCheckAt < 300000 && !heartbeat.error),
        messages: db.prepare('SELECT status,COUNT(*) AS count FROM messages GROUP BY status').all(),
        alerts: db.prepare('SELECT COUNT(*) AS total, COUNT(forwarded_at) AS transferred FROM outbox').get(),
        needsRetry: db.prepare("SELECT id,attempts,next_at FROM messages WHERE status='retry'").all() };
    } finally { db.close(); }
}

function createInboxBridge(filename, identity, now = Date.now) {
    const access = fn => {
        if (!fs.existsSync(filename)) return null;
        const state = openInboxState(filename, identity, { worker: false });
        try { return fn(state); } finally { state.close(); }
    };
    return {
        importInto(telegram) { access(inbox => {
            const events = inbox.events();
            // Commit to the Telegram journal first. Repeated imports are idempotent
            // if this process crashes before marking the source events transferred.
            telegram.enqueueEvents(events);
            for (const event of events) inbox.forwarded(event.id, now());
        }); },
        nudgeStatus(reference) { return access(inbox => {
            if (inbox.repliedForListingSince(reference.sender, reference.listingId, reference.appliedAt)) return 'cancel';
            const heartbeat = inbox.get('heartbeat');
            if (inbox.unfinished() || heartbeat?.status !== 'running' || heartbeat.error ||
                !heartbeat.lastCheckAt || now() - heartbeat.lastCheckAt > 300000 || now() - heartbeat.at > 45000) return 'wait';
            return 'ready';
        }) || 'wait'; }
    };
}
module.exports = { openInboxState, readInboxStatus, stateFile, inboxIdentity, createInboxBridge };
