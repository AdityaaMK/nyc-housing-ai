const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createFeatureStore } = require('../src/feature_store');
const { createSelectionService } = require('../src/selection_service');
const { installSelectionApi } = require('../src/selection_api');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-selection-'));
    let db;
    const open = () => {
        db = new DatabaseSync(path.join(dir, 'selection.sqlite'));
        db.exec('CREATE TABLE IF NOT EXISTS feature_records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,id))');
        return createFeatureStore({ backend: 'sqlite', async query(sql, params = []) {
            const values = [];
            const converted = sql.replace(/\$(\d+)/g, (_, i) => { values.push(params[Number(i) - 1]); return '?'; });
            const statement = db.prepare(converted);
            if (/^SELECT/.test(converted) || /RETURNING/.test(converted)) { const rows = statement.all(...values); return { rows, rowCount: rows.length }; }
            return { rows: [], rowCount: Number(statement.run(...values).changes) };
        } });
    };
    let store = open();
    const listings = new Map(Array.from({ length: 5 }, (_, index) => {
        const id = String.fromCharCode(97 + index);
        return [id, { id, id_hash: 'hash-' + id, title: id, price: 2500, bedrooms: 1, bathrooms: 1, status: 'inbox',
            neighborhood: 'Lower East Side', location_area: 'Manhattan', suitability_score: 80 - index,
            true_gross_rent: 2500, rent_terms: '{"concessions_mentioned":false,"lease_months":12,"free_months":0,"rent_credit":0}',
            pros: '["Light"]', red_flags: '[]', commute_minutes: 20, commute_summary: 'AI estimate', evaluation_claim_token: 'private' }];
    }));
    const tours = new Map([['tour-a', { id: 'tour-a', status: 'confirmed' }], ['tour-b', { id: 'tour-b', status: 'confirmed' }]]);
    const statusChanges = [];
    const repository = {
        async getListing(id) { return { rows: [...listings.values()].filter(listing => listing.id === id || listing.id_hash === id) }; },
        async getTour(id) { return { rows: tours.has(id) ? [tours.get(id)] : [] }; },
        async setListingStatus(id, status) { statusChanges.push({ id, status }); listings.get(id).status = status; return { rowCount: 1 }; }
    };
    let matches = true;
    const makeService = () => createSelectionService({ store, repository, now: () => new Date('2026-10-16T14:00:00Z'),
        preferenceService: { eligibility: () => ({ matches, reasons: matches ? [] : ['Above updated budget'] }) } });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { store, service: makeService(), listings, tours, repository, statusChanges, setMatches: value => { matches = value; },
        restart() { db.close(); store = open(); return makeService(); } };
}

test('watchlist persists independently from application status, preference changes, and restarts', async t => {
    const f = fixture(t);
    assert.deepEqual(await f.service.setWatchlist('hash-a', true), { id: 'a', saved: true, saved_at: '2026-10-16T14:00:00.000Z' });
    await f.service.setWatchlist('a', true);
    assert.equal((await f.store.get('watchlist', 'a')).revision, 1);
    assert.equal(f.listings.get('a').status, 'inbox');
    assert.equal(f.statusChanges.length, 0);
    f.setMatches(false);
    const restarted = f.restart();
    const result = await restarted.watchlist();
    assert.equal(result.listings.length, 1);
    assert.deepEqual(result.listings[0].search_match, { matches: false, reasons: ['Above updated budget'] });
    assert.equal(result.listings[0].evaluation_claim_token, undefined);
    await restarted.setWatchlist('a', false);
    assert.equal((await restarted.watchlist()).listings.length, 0);
});

test('comparison caps four unique apartments and preserves missing values and evidence', async t => {
    const f = fixture(t);
    f.listings.get('a').bathrooms = null;
    f.listings.get('a').evaluation_last_error = 'provider error with API-key=fixture-secret';
    await assert.rejects(f.service.comparison(['a', 'b', 'c', 'd', 'e']), /four/);
    await assert.rejects(f.service.comparison(['a', 'hash-a']), /different/);
    await assert.rejects(f.service.comparison(['missing']), { status: 404 });
    const { listings } = await f.service.comparison(['b', 'a']);
    assert.equal(listings[1].bathrooms, null);
    assert.equal(listings[1].evaluation_last_error, 'Evaluation temporarily unavailable.');
    assert.equal(listings[1].commute_summary, 'AI estimate');
    assert.equal(listings[1].costs.input.rent.evidence, 'assumed');
    assert.equal(listings[1].review.review, null);
    assert.equal(listings[0].id, 'b');
});

test('cost edits use revision checks and remain attached to the canonical listing after restart', async t => {
    const f = fixture(t), original = await f.service.getCosts('a');
    original.input.rent.upfront_rent_months = 1;
    const updated = await f.service.updateCosts('hash-a', { revision: 0, input: original.input });
    assert.equal(updated.revision, 1);
    assert.equal(updated.calculation.totals.upfront_cash.amount, 2500);
    await assert.rejects(f.service.updateCosts('a', { revision: 0, input: original.input }), { status: 409 });
    await assert.rejects(f.service.updateCosts('a', { revision: 1, input: { ...original.input, lease_months: -1 } }), { status: 400 });
    assert.equal((await f.restart().getCosts('a')).revision, 1);
});

test('reviews require real completed tour linked to this apartment and leave AI facts intact', async t => {
    const f = fixture(t), review = { revision: 0, tour_id: 'tour-a', checklist: { noise: 4 }, notes: 'Quiet at 10 am', strengths: 'Daylight', issues: 'Small closet', rating: 4 };
    await assert.rejects(f.service.updateReview('a', review), { code: 'tour_not_completed' });
    await f.store.put('tour_schedule', 'tour-a', { listingId: 'b', status: 'completed' }, { expectedRevision: 0 });
    await assert.rejects(f.service.updateReview('a', review), { code: 'tour_not_completed' });
    await f.store.put('tour_schedule', 'tour-a', { listingId: 'a', status: 'completed' }, { expectedRevision: 1 });
    await assert.rejects(f.service.updateReview('a', { ...review, checklist: { noise: 0 } }), { status: 400 });
    const result = await f.service.updateReview('a', review);
    assert.equal(result.review.checklist.noise, 4);
    assert.equal(result.review.checklist.daylight, null);
    assert.equal(f.listings.get('a').suitability_score, 80);
    assert.equal(f.listings.get('a').status, 'inbox');
    assert.equal(f.statusChanges.length, 0);
    assert.equal((await f.restart().comparison(['a'])).listings[0].review.review.notes, 'Quiet at 10 am');
});

test('decisions keep complete reasons and history; pass preserves notes and never generates mail events', async t => {
    const f = fixture(t);
    const first = await f.service.decide('a', { revision: 0, action: 'request_information', reason: 'Ask about pet policy' });
    assert.equal(f.listings.get('a').status, 'inbox');
    const second = await f.service.decide('a', { revision: first.revision, action: 'apply', reason: 'Prepare application' });
    assert.equal(f.listings.get('a').status, 'inbox');
    await f.service.decide('a', { revision: second.revision, action: 'pass', reason: 'Too little storage' });
    assert.equal(f.listings.get('a').status, 'passed');
    const result = await f.restart().decisions();
    assert.equal(result.activity.length, 3);
    assert.equal(result.listings[0].decision.reason, 'Too little storage');
    assert.equal(result.listings[0].decision.pipeline_pending, false);
    assert.equal((await f.store.list('events')).length, 0);
    await assert.rejects(f.service.decide('a', { revision: 0, action: 'pass', reason: '' }), { status: 400 });
});

test('a recorded pass is recoverable if the status write fails', async t => {
    const f = fixture(t), original = f.repository.setListingStatus;
    f.repository.setListingStatus = async () => { throw new Error('Transient database outage'); };
    const result = await f.service.decide('a', { revision: 0, action: 'pass', reason: 'No elevator' });
    assert.equal(result.pipeline_pending, true);
    assert.equal(f.listings.get('a').status, 'inbox');
    f.repository.setListingStatus = original;
    const restarted = f.restart();
    assert.equal((await restarted.decisions()).listings[0].decision.pipeline_pending, false);
    assert.equal(f.listings.get('a').status, 'passed');
});

test('shortlist action saves selection without applying; missing and invalid watch mutations fail', async t => {
    const f = fixture(t);
    await f.service.decide('a', { revision: 0, action: 'shortlist', reason: 'Top candidate' });
    assert.equal((await f.service.watchlist()).listings[0].id, 'a');
    assert.equal(f.listings.get('a').status, 'inbox');
    await assert.rejects(f.service.setWatchlist('missing', true), { status: 404 });
    await assert.rejects(f.service.setWatchlist('a', 'true'), { status: 400 });
    await assert.rejects(f.service.decide('a', { revision: 1, action: 'email', reason: 'Send now' }), { status: 400 });
});

test('final shortlist ranks active saved reviews first and archives passed or unsaved decisions without losing history', async t => {
    const f = fixture(t);
    for (const [id, rating] of [['a', 5], ['b', 3]]) {
        await f.service.setWatchlist(id, true);
        await f.store.put('tour_schedule', 'tour-' + id, { listingId: id, status: 'completed' }, { expectedRevision: 0 });
        await f.service.updateReview(id, { revision: 0, tour_id: 'tour-' + id, checklist: {}, rating });
    }
    await f.service.decide('a', { revision: 0, action: 'pass', reason: 'Excellent apartment but landlord declined the pet' });
    await f.service.decide('c', { revision: 0, action: 'request_information', reason: 'Still researching; not shortlisted yet' });
    await f.service.setWatchlist('d', true);
    const result = await f.service.decisions();
    assert.deepEqual(result.listings.filter(listing => listing.activeCandidate).map(listing => listing.id), ['b', 'd']);
    assert.deepEqual(result.listings.slice(0, 2).map(listing => listing.shortlist_rank), [1, 2]);
    const passed = result.listings.find(listing => listing.id === 'a');
    assert.equal(passed.shortlist_status, 'passed');
    assert.equal(passed.activeCandidate, false);
    assert.equal(passed.shortlist_rank, null);
    assert.equal(passed.review.review.rating, 5);
    assert.equal(passed.selection.saved, true, 'Passing does not silently erase a saved record');
    assert.equal(result.listings.find(listing => listing.id === 'c').shortlist_status, 'unsaved');
    assert.equal(result.listings.find(listing => listing.id === 'd').review.review, null, 'Unrated remains unknown');
    assert.equal(result.activity.length, 2);
    await f.service.setWatchlist('b', false);
    // A saved-only entry without a decision can leave the shortlist; its review
    // remains available on the apartment and comparison even when not shortlisted.
    assert.equal((await f.service.comparison(['b'])).listings[0].review.review.rating, 3);
});

test('selection endpoints protect notes and mutations with owner middleware and safe errors', async () => {
    const routes = [];
    const app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (path, ...handlers) => routes.push({ method, path, handlers })]));
    const owner = () => {};
    installSelectionApi(app, { service: { watchlist() { throw new Error('secret connection string'); } }, requireOwner: owner });
    assert.equal(routes.length, 9);
    assert.ok(routes.every(route => route.handlers[0] === owner));
    const response = { code: 200, set() {}, status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
    await routes[0].handlers[1]({}, response);
    assert.equal(response.code, 500);
    assert.equal(response.body.error, 'Selection operation failed.');
});

test('HTTP selection API persists authenticated choices and rejects stale cost/review writes', async t => {
    const f = fixture(t), express = require('express'), app = express(); app.use(express.json());
    const token = 'fixture-owner-selection-token-2026';
    const { requireOwner } = require('../src/owner_auth').createOwnerAuth({ HOUSING_OWNER_TOKEN: token });
    installSelectionApi(app, { service: f.service, requireOwner });
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1');
        listener.once('listening', () => resolve(listener)); listener.once('error', reject);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = async (pathname, method = 'GET', body) => {
        const response = await fetch(origin + pathname, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() };
    };
    assert.equal((await fetch(origin + '/api/listings/a/review')).status, 401);
    assert.equal((await fetch(origin + '/api/watchlist/a', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"saved":true}' })).status, 401);
    assert.equal((await request('/api/watchlist/a', 'PUT', { saved: 'yes' })).status, 400);
    assert.equal((await request('/api/watchlist/a', 'PUT', { saved: true })).status, 200);
    assert.equal((await request('/api/watchlist')).body.listings[0].selection.saved, true);
    const costs = (await request('/api/listings/a/costs')).body;
    costs.input.rent.upfront_rent_months = 1;
    const body = { revision: costs.revision, input: costs.input };
    const saved = await request('/api/listings/a/costs', 'PUT', body);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.calculation.totals.upfront_cash.amount, 2500);
    assert.equal((await request('/api/listings/a/costs', 'PUT', body)).status, 409);
    assert.equal((await request('/api/compare?ids=a,b,c,d,e')).status, 400);
    await f.store.put('tour_schedule', 'tour-a', { listingId: 'a', status: 'completed' }, { expectedRevision: 0 });
    const review = { revision: 0, tour_id: 'tour-a', checklist: { daylight: 5 }, notes: 'Direct afternoon light', rating: null };
    assert.equal((await request('/api/listings/a/review', 'PUT', review)).status, 200);
    assert.equal((await request('/api/listings/a/review', 'PUT', review)).status, 409);
    const comparison = (await request('/api/compare?ids=a')).body.listings[0];
    assert.equal(comparison.review.review.checklist.noise, null);
    assert.equal(comparison.review.review.notes, 'Direct afternoon light');
    const decision = await request('/api/listings/a/decision', 'POST', { revision: 0, action: 'pass', reason: 'Does not fit desk' });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.pipeline_pending, false);
    const decisions = (await request('/api/decisions')).body;
    assert.equal(decisions.activity[0].reason, 'Does not fit desk');
    assert.equal(decisions.listings[0].status, 'passed');
});
