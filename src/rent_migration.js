const rentColumns = { effective_monthly_rent: 'NUMERIC(12,2)', rent_terms: 'TEXT' };
async function migrateRentTerms(query, engine) {
    const existing = engine === 'sqlite' ? (await query('PRAGMA table_info(listings)')).rows : [];
    for (const [name, type] of Object.entries(rentColumns)) {
        if (engine === 'sqlite') {
            if (!existing.some(c => c.name === name)) await query(`ALTER TABLE listings ADD COLUMN ${name} ${type}`);
        } else await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    // Historical advertised prices are not silently reclassified as calculated rents.
}
module.exports = { migrateRentTerms, rentColumns };
