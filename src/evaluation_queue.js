const { LEASE_MS, createQueue: createSqlQueue } = require('./repositories/sql_queue');
const { createSupabaseQueue } = require('./repositories/supabase_queue');
function createQueue(db, now = Date.now) {
    return db.backend === 'supabase' ? createSupabaseQueue(db) : createSqlQueue(db, now);
}
module.exports = { createQueue, LEASE_MS };
