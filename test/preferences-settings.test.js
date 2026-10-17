const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
const { migrate } = require('../src/db');
const { createFeatureStore } = require('../src/feature_store');
const { createRepository } = require('../src/repository');
const { createPreferencesService } = require('../src/preferences_service');
const { installPreferencesApi } = require('../src/preferences_api');
const { defaultPreferences, validatePreferences, loadPreferences, refreshPreferences, assessPreferences } = require('../src/preferences');
const { getSearchFeeds } = require('../src/search_feeds');
const { applyScoringRules } = require('../src/evaluator');
let raw, dir, db, store, repository, service;
function open() {
    raw = new DatabaseSync(path.join(dir, 'test.sqlite'));
    db = { backend: 'sqlite', async query(sql, params = []) {
        const args = [];
        sql = sql.replace(/\$(\d+)/g, (_, index) => { const value = params[index - 1]; args.push(typeof value === 'boolean' ? Number(value) : value); return '?'; });
        const statement = raw.prepare(sql);
        if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) { const rows = statement.all(...args); return { rows, rowCount: rows.length }; }
        return { rows: [], rowCount: Number(statement.run(...args).changes) };
    } };
    store = createFeatureStore(db); repository = createRepository(db); service = createPreferencesService({ store, repository });
}
before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-preferences-')); open(); await migrate(db.query.bind(db), 'sqlite'); });
beforeEach(async () => { await db.query('DELETE FROM listings'); await db.query('DELETE FROM feature_records'); await refreshPreferences(store); });
after(() => { raw.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const listing = (extra = {}) => ({ id: 'a', title: '100 Main St', location_area: 'Manhattan', neighborhood: 'LES', bedrooms: 1, bathrooms: 1, price: 2600, is_evaluated: true, suitability_score: 90, ...extra });
async function saveListing(row) {
    await repository.insertListing({ id: row.id, title: row.title, url: 'https://example.test/' + row.id, price: row.price, bedrooms: row.bedrooms, bathrooms: row.bathrooms, location_area: row.location_area, neighborhood: row.neighborhood });
    await db.query("UPDATE listings SET status=$2,is_evaluated=true,is_notified=true,suitability_score=90,evaluation_status='completed' WHERE id=$1", [row.id, row.status || 'inbox']);
}
test('settings seed once, persist across reopen, and refresh a process snapshot', async () => {
    const initial = await service.get();
    assert.equal(initial.revision, 1); assert.equal(initial.budgets.twoBedroom.maxRent, 5000);
    const saved = await service.update({ ...initial, budgets: { ...initial.budgets, studioOneBedroom: { ...initial.budgets.studioOneBedroom, maxRent: 2400 } } });
    assert.equal(saved.revision, 2);
    raw.close(); open();
    assert.equal((await service.get()).budgets.studioOneBedroom.maxRent, 2400);
    assert.equal(loadPreferences().revision, 2);
    await store.put('settings', 'search', { ...validatePreferences(saved), includedAreaCommute: { ...saved.includedAreaCommute, maxMinutes: 25 } }, { expectedRevision: 2 });
    assert.equal(loadPreferences().includedAreaCommute.maxMinutes, 20, 'another process has not reached its next cycle');
    assert.equal((await refreshPreferences(store)).includedAreaCommute.maxMinutes, 25);
});
test('invalid settings and stale revisions never partially change saved settings', async () => {
    const initial = await service.get();
    for (const patch of [
        { includedAreas: ['Atlantis'] },
        { includedAreaCommute: { maxMinutes: 0, destination: 'any Manhattan arrival station' } },
        { officeCommute: { maxMinutes: 0, destination: 'Office' } },
        { budgets: { ...initial.budgets, twoBedroom: { ...initial.budgets.twoBedroom, minRent: 7000 } } },
        { budgets: { ...initial.budgets, twoBedroom: { ...initial.budgets.twoBedroom, minBedrooms: 1 } } },
        { schemaVersion: 2 }
    ]) {
        await assert.rejects(service.update({ ...initial, ...patch }), error => error.status === 400);
        assert.deepEqual(await service.get(), initial);
    }
    await service.update({ ...initial, includedAreas: ['Queens'] });
    await assert.rejects(service.update(initial), error => error.status === 409);
    assert.deepEqual((await service.get()).includedAreas, ['Queens']);
});
test('same revision drives source feed bounds, deterministic matching, and scoring', async () => {
    const initial = await service.get();
    const saved = await service.update({ ...initial, budgets: { ...initial.budgets, studioOneBedroom: { ...initial.budgets.studioOneBedroom, minRent: 2000, maxRent: 2500 } } });
    for (const source of ['streetEasy', 'renthop', 'compass']) {
        const feed = getSearchFeeds(source).find(item => item.area === 'Manhattan' && item.match(1, 1, 2400));
        assert.equal(feed.preferenceRevision, saved.revision); assert.match(feed.url, /2000/); assert.match(feed.url, /2500/);
        assert.equal(feed.match(1, 1, 2600), false); assert.equal(feed.match(1, 0, 2400), false);
    }
    assert.equal(assessPreferences(listing(), saved).matches, false);
    assert.equal(assessPreferences(listing({ effective_monthly_rent: 2450, true_gross_rent: 2700 }), saved).matches, true);
    assert.equal(assessPreferences(listing({ bedrooms: null }), saved).matches, false);
    const { evaluation } = await applyScoringRules(listing(), {
        suitability_score: 99, true_gross_rent: 2600, is_fee: false, fee_estimate: 'None',
        rent_terms: { concessions_mentioned: false, lease_months: null, free_months: 0, rent_credit: 0 },
        location_area: 'Manhattan', neighborhood: 'LES', is_preferred_neighborhood: true,
        commute_minutes: 15, commute_summary: '15 minutes', pros: [], red_flags: []
    }, { preferences: saved, healthCheck: async () => ({ grade: 'A' }) });
    assert.equal(evaluation.suitability_score, 40); assert.equal(evaluation.preferences_revision, saved.revision);
});
test('office limit and regional Manhattan arrival remain independent and unknown values are explicit', async () => {
    const preferences = { ...loadPreferences(), officeCommute: { maxMinutes: 30, destination: '620 8th Ave, New York, NY' } };
    const row = listing({ location_area: 'Queens', neighborhood: 'Astoria', manhattan_commute_minutes: 19, manhattan_arrival_station: 'Lexington Av', manhattan_commute_summary: 'walk 5, wait 4, train 10', commute_minutes: 29 });
    assert.equal(assessPreferences(row, preferences).matches, true);
    assert.equal(assessPreferences({ ...row, commute_minutes: 31 }, preferences).matches, false);
    assert.equal(assessPreferences({ ...row, manhattan_commute_minutes: 21, commute_minutes: 10 }, preferences).matches, false);
    assert.match(assessPreferences({ ...row, bathrooms: null }, preferences).reasons.join(' '), /Bathroom count is unknown/);
});
test('preview has no side effects; bounded reevaluation preserves application state and notification receipts', async () => {
    for (const row of [listing({ id: 'a' }), listing({ id: 'b', status: 'applied' }), listing({ id: 'passed', status: 'passed' }), listing({ id: 'c' })]) await saveListing(row);
    const current = await service.get();
    const preview = await service.preview({ preferences: { ...current, budgets: { ...current.budgets, studioOneBedroom: { ...current.budgets.studioOneBedroom, maxRent: 2500 } } } });
    assert.equal(preview.matching, 0); assert.equal((await service.get()).revision, 1);
    const saved = await service.update({ ...current, includedAreaCommute: { ...current.includedAreaCommute, maxMinutes: 25 } });
    assert.equal((await service.annotate((await repository.listListings()).rows)).filter(row => row.score_outdated).length, 4);
    assert.equal((await service.queueOutdated({ limit: 2 })).queued, 2);
    const rows = (await repository.listListings()).rows;
    assert.equal(rows.filter(row => row.evaluation_status === 'pending').length, 2);
    assert.equal(rows.find(row => row.id === 'b').status, 'applied'); assert.equal(rows.find(row => row.id === 'passed').evaluation_status, 'completed');
    assert.ok(rows.every(row => row.is_notified && row.suitability_score === 90));
    await service.recordEvaluation('c', saved.revision);
    await service.recordEvaluation('c', saved.revision - 1);
    assert.equal((await store.get('evaluation_preferences', 'c')).data.revision, saved.revision, 'late metadata cannot overwrite a newer score revision');
    assert.equal((await service.annotate([rows.find(row => row.id === 'c')]))[0].score_outdated, false);
});
test('preferences API guards writes and preview and exposes validation/conflict outcomes', async () => {
    const routes = [], guard = () => {};
    const app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (route, ...handlers) => routes.push({ method, route, handlers })]));
    installPreferencesApi(app, { service, requireOwner: guard });
    assert.equal(routes.length, 3); assert.ok(routes.filter(route => route.method !== 'get').every(route => route.handlers[0] === guard));
    assert.equal(routes.find(route => route.method === 'get').handlers.length, 1);
    const update = routes.find(route => route.method === 'put').handlers[1];
    let status = 200, body;
    const response = { status(value) { status = value; return this; }, json(value) { body = value; } };
    await update({ body: {} }, response); assert.equal(status, 400);
    const initial = await service.get(); await service.update(initial);
    await update({ body: initial }, response); assert.equal(status, 409); assert.match(body.error, /changed/);
    assert.throws(() => installPreferencesApi(app, { service }), /owner authentication/);
});
test('scorer holds one settings revision per attempt and never clears a newer rent snapshot', async () => {
    const { runWorker } = require('../src/evaluation_worker');
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fixture';
    try {
        await saveListing(listing({ status: 'applied' }));
        const initial = await service.get();
        const revision2 = await service.update({ ...initial, includedAreaCommute: { ...initial.includedAreaCommute, maxMinutes: 25 } });
        await store.put('listing_insights', 'a', { snapshot_id: 'old', assessment_outdated: true });
        let clock = Date.now();
        const valid = { suitability_score: 90, true_gross_rent: 2600, is_fee: false, fee_estimate: 'None',
            rent_terms: { concessions_mentioned: false, lease_months: null, free_months: 0, rent_credit: 0 },
            location_area: 'Manhattan', neighborhood: 'LES', is_preferred_neighborhood: true,
            commute_minutes: 15, commute_summary: '15 minutes', pros: [], red_flags: [] };
        const options = { db, store, now: () => clock, limit: 1, sleep: async ms => { clock += ms; },
            healthCheck: async () => null, log() {},
            evaluate: async (_listing, _description, { preferences }) => { assert.equal(preferences.revision, 2); return valid; },
            describe: async () => {
                await service.update({ ...revision2, budgets: { ...revision2.budgets, studioOneBedroom: { ...revision2.budgets.studioOneBedroom, maxRent: 2500 } } });
                await store.put('listing_insights', 'a', { snapshot_id: 'new', assessment_outdated: true });
                return 'A complete description of a one bedroom apartment.';
            } };
        assert.equal((await runWorker(options)).completed, 1);
        assert.equal((await store.get('evaluation_preferences', 'a')).data.revision, 2);
        assert.equal((await store.get('listing_insights', 'a')).data.assessment_outdated, true);
        let saved = (await repository.getListing('a')).rows[0];
        assert.equal(saved.suitability_score, 90, 'new budget is used on the next attempt');
        assert.equal((await service.annotate([saved]))[0].score_outdated, true);
        assert.equal((await runWorker({ ...options, describe: async () => 'Same apartment with its updated rent terms.', evaluate: async () => valid })).completed, 1);
        assert.equal((await store.get('evaluation_preferences', 'a')).data.revision, 3);
        assert.equal((await store.get('listing_insights', 'a')).data.assessment_outdated, false);
        saved = (await repository.getListing('a')).rows[0];
        assert.equal(saved.suitability_score, 40); assert.equal(saved.status, 'applied'); assert.equal(saved.is_notified, 1);
    } finally {
        if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
    }
});

test('queued retained scores including zero remain outdated while never-scored rows stay unknown', async () => {
    const current = await service.get();
    const preferences = await service.update({ ...current, includedAreaCommute: { ...current.includedAreaCommute, maxMinutes: 25 } });
    const examples = [
        { id: 'zero', suitability_score: 0 },
        { id: 'positive', suitability_score: 90 },
        { id: 'receipt', suitability_score: null },
        { id: 'evaluated', suitability_score: null, is_evaluated: true },
        { id: 'unknown', suitability_score: null },
        { id: 'missing' },
        { id: 'invalid', suitability_score: NaN },
        { id: 'empty', suitability_score: '' },
        { id: 'boolean', suitability_score: false },
        { id: 'infinite', suitability_score: Infinity }
    ].map(row => ({ is_evaluated: false, evaluation_status: 'pending', ...row }));
    await service.recordEvaluation('receipt', 1);
    const annotated = await service.annotate(examples, preferences);
    assert.deepEqual(annotated.map(row => row.score_outdated), [true, true, true, true, false, false, false, false, false, false]);
    assert.deepEqual(annotated.map(row => row.score_preferences_revision), [1, 1, 1, 1, null, null, null, null, null, null]);
    assert.equal(annotated.find(row => row.id === 'zero').suitability_score, 0);
    assert.equal(annotated.find(row => row.id === 'unknown').suitability_score, null);
    assert.equal(assessPreferences(examples[0], preferences).scoreOutdated, true);
    assert.equal(assessPreferences(examples[4], preferences).scoreOutdated, false);
    await service.recordEvaluation('zero', preferences.revision);
    assert.equal((await service.annotate([examples[0]], preferences))[0].score_outdated, false);
});
