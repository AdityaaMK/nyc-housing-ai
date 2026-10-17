async function migrateFeatures(query, engine) {
    await query(`CREATE TABLE IF NOT EXISTS feature_records (
        collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        PRIMARY KEY (collection,id))`);
    await query('CREATE INDEX IF NOT EXISTS feature_records_updated ON feature_records(collection,updated_at)');
    if (engine === 'pg') await query('ALTER TABLE feature_records ENABLE ROW LEVEL SECURITY');
}
module.exports = { migrateFeatures };
