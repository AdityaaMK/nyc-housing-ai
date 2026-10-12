// Additive queue migration. ISO UTC timestamps work in both PostgreSQL and SQLite.
const evaluationColumns = {
    evaluation_status: "TEXT NOT NULL DEFAULT 'pending' CHECK (evaluation_status IN ('pending', 'processing', 'retry_wait', 'completed', 'failed'))",
    evaluation_attempts: 'INTEGER NOT NULL DEFAULT 0',
    evaluation_next_at: 'TIMESTAMPTZ',
    evaluation_last_error: 'TEXT',
    evaluation_completed_at: 'TIMESTAMPTZ',
    evaluation_claim_token: 'TEXT',
    evaluation_claim_expires_at: 'TIMESTAMPTZ'
};
async function migrateEvaluationQueue(query, engine) {
    const existing = engine === 'sqlite' ? (await query('PRAGMA table_info(listings)')).rows : [];
    for (const [name, type] of Object.entries(evaluationColumns)) {
        if (engine === 'sqlite') {
            if (!existing.some(c => c.name === name)) await query(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
        } else await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    // Historical scores and all user/application/notification fields stay untouched.
    await query(`UPDATE listings SET evaluation_status = 'completed',
        evaluation_completed_at = COALESCE(evaluation_completed_at, $1),
        evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL
        WHERE is_evaluated = true AND evaluation_status <> 'completed'`, [new Date().toISOString()]);
    await query(`CREATE INDEX IF NOT EXISTS listings_evaluation_queue_idx
        ON listings (evaluation_status, evaluation_next_at, discovered_at, id)`);
    await query(`CREATE TABLE IF NOT EXISTS evaluation_control (
        id INTEGER PRIMARY KEY, next_request_at TIMESTAMPTZ, pause_until TIMESTAMPTZ)`);
    if (engine === 'pg') await query('ALTER TABLE evaluation_control ENABLE ROW LEVEL SECURITY');
    await query('INSERT INTO evaluation_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
}
module.exports = { migrateEvaluationQueue, evaluationColumns };
