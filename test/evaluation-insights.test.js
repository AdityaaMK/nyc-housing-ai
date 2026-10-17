const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DB_BACKEND = 'sqlite';
process.env.GEMINI_API_KEY = 'fixture';
const { migrate } = require('../src/db');
const { createFeatureStore } = require('../src/feature_store');
const { createRepository } = require('../src/repository');
const { createListingInsights } = require('../src/listing_insights');
const { runWorker, reconcileListingAssessment } = require('../src/evaluation_worker');
let raw, db, store, repository, service, clock;
const value = () => ({ suitability_score: 90, true_gross_rent: 2500, is_fee: false, fee_estimate: 'None',
    rent_terms: { concessions_mentioned: false, lease_months: null, free_months: 0, rent_credit: 0 },
    location_area: 'Manhattan', neighborhood: "Hell's Kitchen", is_preferred_neighborhood: true,
    commute_minutes: 15, commute_summary: '15 minutes', pros: [], red_flags: [] });
const observation = { listingId: 'apt', source: 'renthop', url: 'https://www.renthop.com/listings/main/4/123', advertised_rent: 2500, availability: 'active' };
const row = async () => (await repository.getListing('apt')).rows[0];
const options = extra => ({ db, store, repository, now: () => clock, sleep: async ms => { clock += ms; }, limit: 1,
    describe: async () => 'A one bedroom apartment with verified gross rent, located in Manhattan.', evaluate: async () => value(),
    healthCheck: async () => ({ grade: 'Unknown', isHazardous: false, summary: 'Unverified' }), log() {}, ...extra });
before(async () => {
    raw = new DatabaseSync(':memory:');
    db = { backend: 'sqlite', async query(sql, params = []) {
        const values = [];
        const parsed = sql.replace(/\$(\d+)/g, (_, index) => { const value = params[Number(index) - 1]; values.push(typeof value === 'boolean' ? Number(value) : value); return '?'; });
        const stmt = raw.prepare(parsed);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(parsed) || /\bRETURNING\b/i.test(parsed)) { const rows = stmt.all(...values); return { rows, rowCount: rows.length }; }
        return { rows: [], rowCount: Number(stmt.run(...values).changes) };
    } };
    await migrate(db.query.bind(db), 'sqlite');
    repository = createRepository(db); store = createFeatureStore(db);
    service = createListingInsights({ store, repository, now: () => new Date(clock), isEligible: () => true, onTermsChanged: repository.requeueEvaluation });
});
beforeEach(async () => {
    clock = Date.parse('2026-10-16T12:00:00Z');
    await db.query('DELETE FROM listings'); await db.query('DELETE FROM feature_records');
    await db.query('UPDATE evaluation_control SET pause_until=NULL,next_request_at=NULL');
    await repository.insertListing({ id: 'apt', title: '100 Main St #4', url: observation.url, source: 'renthop', price: 2500, bedrooms: 1, bathrooms: 1 });
    await db.query("UPDATE listings SET is_notified=true,status='applied' WHERE id='apt'");
    await service.observe(observation);
});
after(() => raw.close());
test('rent changes during an active evaluation are requeued after completion, then clear after a fresh attempt', async () => {
    await service.observe({ ...observation, advertised_rent: 2450 });
    const previousSnapshot = (await store.get('listing_insights', 'apt')).data.snapshot_id;
    const report = await runWorker(options({ evaluate: async () => {
        assert.equal((await row()).evaluation_status, 'processing');
        await service.observe({ ...observation, advertised_rent: 2400 });
        assert.equal((await row()).evaluation_status, 'processing', 'observer does not replace an active claim');
        return value();
    } }));
    assert.equal(report.aiCalls, 1); assert.equal(report.results[0].assessmentOutdated, true);
    assert.equal((await row()).evaluation_status, 'pending'); assert.equal((await row()).is_notified, 1); assert.equal((await row()).status, 'applied');
    const current = await store.get('listing_insights', 'apt');
    assert.notEqual(current.data.snapshot_id, previousSnapshot); assert.equal(current.data.assessment_outdated, true);
    await runWorker(options());
    assert.equal((await row()).evaluation_status, 'completed');
    assert.equal((await store.get('listing_insights', 'apt')).data.assessment_outdated, false);
});
test('a first price-change marker created during scoring is not mistaken for an already evaluated snapshot', async () => {
    assert.equal(await store.get('listing_insights', 'apt'), null);
    await runWorker(options({ evaluate: async () => { await service.observe({ ...observation, advertised_rent: 2400 }); return value(); } }));
    assert.equal((await row()).evaluation_status, 'pending');
    assert.equal((await store.get('listing_insights', 'apt')).data.assessment_outdated, true);
});
test('a source update racing the compare-and-swap clear retains new evidence and requests a fresh evaluation', async () => {
    await service.observe({ ...observation, advertised_rent: 2450 });
    const initialInsight = await store.get('listing_insights', 'apt');
    await db.query("UPDATE listings SET is_evaluated=true,evaluation_status='completed' WHERE id='apt'");
    let injected = false;
    const racingStore = { ...store, async put(collection, id, data, options) {
        if (collection === 'listing_insights' && data.assessment_outdated === false && !injected) {
            injected = true; await service.observe({ ...observation, advertised_rent: 2400 });
        }
        return store.put(collection, id, data, options);
    } };
    assert.equal(await reconcileListingAssessment({ store: racingStore, repository, id: 'apt', initialInsight }), true);
    assert.equal((await row()).evaluation_status, 'pending');
    assert.equal((await store.get('listing_insights', 'apt')).data.assessment_outdated, true);
});
test('a source change immediately after a successful metadata clear cannot strand a stale completed score', async () => {
    await service.observe({ ...observation, advertised_rent: 2450 });
    const initialInsight = await store.get('listing_insights', 'apt');
    await db.query("UPDATE listings SET is_evaluated=true,evaluation_status='completed' WHERE id='apt'");
    let injected = false;
    const racingStore = { ...store, async put(collection, id, data, options) {
        const result = await store.put(collection, id, data, options);
        if (collection === 'listing_insights' && data.assessment_outdated === false && !injected) {
            injected = true; await service.observe({ ...observation, advertised_rent: 2400 });
        }
        return result;
    } };
    assert.equal(await reconcileListingAssessment({ store: racingStore, repository, id: 'apt', initialInsight }), true);
    assert.equal((await row()).evaluation_status, 'pending');
    assert.equal((await store.get('listing_insights', 'apt')).data.assessment_outdated, true);
});
test('the observer publishes the stale marker before invoking a potentially ineffective active-claim requeue', async () => {
    let callbackSawMarker = false;
    const ordered = createListingInsights({ store, repository, now: () => new Date(clock), isEligible: () => true,
        onTermsChanged: async () => { callbackSawMarker = (await store.get('listing_insights', 'apt'))?.data.assessment_outdated === true; } });
    await ordered.observe({ ...observation, advertised_rent: 2400 });
    assert.equal(callbackSawMarker, true);
});
