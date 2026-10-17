const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
const { migrate } = require('../src/db');
const { createFeatureStore } = require('../src/feature_store');
const { createRepository } = require('../src/repository');
const { createListingInsights, ingestObservedListing } = require('../src/listing_insights');
test('real SQLite observes duplicates, preserves actions and receipts, and recovers history/outbox after reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-insights-'));
    let raw, repository, store, service;
    function open() {
        raw = new DatabaseSync(path.join(dir, 'test.sqlite'));
        const db = { backend: 'sqlite', async query(sql, params = []) {
            const values = [];
            const parsed = sql.replace(/\$(\d+)/g, (_, index) => { const value = params[Number(index) - 1]; values.push(typeof value === 'boolean' ? Number(value) : value); return '?'; });
            const stmt = raw.prepare(parsed);
            if (/^\s*(SELECT|PRAGMA|WITH)/i.test(parsed) || /\bRETURNING\b/i.test(parsed)) { const rows = stmt.all(...values); return { rows, rowCount: rows.length }; }
            return { rows: [], rowCount: Number(stmt.run(...values).changes) };
        } };
        repository = createRepository(db); store = createFeatureStore(db);
        service = createListingInsights({ store, repository, isEligible: () => true, onTermsChanged: repository.requeueEvaluation });
        return db;
    }
    try {
        const db = open(); await migrate(db.query.bind(db), 'sqlite');
        const listing = { id: 'rental', title: '100 Main St #4', url: 'https://www.renthop.com/listings/main/4/123',
            source: 'renthop', normalized_address: '100-MAIN-ST-4', price: 3000, bedrooms: 2, bathrooms: 2 };
        await ingestObservedListing({ listing, repository, insights: service });
        await db.query("UPDATE listings SET status='applied',is_notified=true,is_evaluated=true,evaluation_status='completed',suitability_score=90 WHERE id=$1", [listing.id]);
        await ingestObservedListing({ listing: { ...listing, price: 2850 }, repository, insights: service });
        await ingestObservedListing({ listing: { ...listing, id: 'crosspost', url: 'https://www.compass.com/homedetails/rental/123_lid/', source: 'compass', price: 2900 }, repository, insights: service });
        assert.equal((await repository.listListings()).rows.length, 1);
        assert.equal((await service.getInsights('rental')).sources.length, 2);
        raw.close(); open();
        await ingestObservedListing({ listing: { ...listing, price: 2850 }, repository, insights: service });
        const persisted = (await repository.getListing('rental')).rows[0];
        assert.equal(persisted.status, 'applied'); assert.equal(persisted.is_notified, 1); assert.equal(persisted.suitability_score, 90);
        assert.equal(persisted.price, 2850); assert.equal(persisted.evaluation_status, 'pending');
        assert.equal((await store.list('events')).length, 1);
        assert.equal((await service.getInsights('rental')).price_history.length, 3);
    } finally { raw?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
