// Only application request accounting; never addresses or provider content.
async function migrateCommute(query, engine) {
    await query(`CREATE TABLE IF NOT EXISTS commute_control (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision BIGINT NOT NULL DEFAULT 0,
        attempts TEXT NOT NULL DEFAULT '[]', disabled_config TEXT, pause_until BIGINT NOT NULL DEFAULT 0)`);
    if (engine === 'pg') await query('ALTER TABLE commute_control ENABLE ROW LEVEL SECURITY');
    await query('INSERT INTO commute_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
}
module.exports = { migrateCommute };
