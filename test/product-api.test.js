const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// This file exercises the actual server and shared services, with one disposable
// SQLite database. No worker starts and all external delivery/provider I/O fails.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-product-api-'));
const token = 'fixture-owner-token-product-api-2026';
Object.assign(process.env, {
    DB_BACKEND: 'sqlite', DATABASE_URL: '', SQLITE_PATH: path.join(directory, 'test.sqlite'),
    HOUSING_OWNER_TOKEN: '', TARGET_COMMUTE_ADDRESS: '620 8th Avenue, Manhattan, NY',
    TELEGRAM_STATE_DIR: path.join(directory, 'telegram'), INBOX_STATE_DIR: path.join(directory, 'inbox'),
    MAIL_BACKEND: 'smtp-imap', GMAIL_USER: 'fixture-tenant@example.test', GMAIL_APP_PASSWORD: 'fixture',
    GOOGLE_MAPS_API_KEY: '', GEMINI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
    SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: ''
});
let externalAttempts = 0;
const forbidden = async () => { externalAttempts++; throw new Error('External I/O is forbidden in product API fixtures'); };
const mock = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
mock('dotenv', { config() {} });
mock('../src/https_client', { createHttpsClient: () => ({ request: forbidden, close: async () => {} }),
    httpsClient: { request: forbidden, close: async () => {} }, createDispatcher: () => { throw new Error('Unexpected external dispatcher'); } });
mock('nodemailer', { createTransport: () => ({ sendMail: forbidden }) });
const { initDB, pool } = require('../src/db');
const { featureStore } = require('../src/feature_store');
const { getProductServices } = require('../src/product_services');
const app = require('../src/server');
let server, origin;
const readListing = async id => (await pool.query('SELECT * FROM listings WHERE id=$1', [id])).rows[0];
async function request(url, { method = 'GET', body, owner = true, authorization } = {}) {
    const response = await fetch(origin + url, { method, headers: {
        ...(owner ? { Authorization: 'Bearer ' + token } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const contentType = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers, body: contentType.includes('application/json') ? await response.json() : await response.text() };
}
before(async () => {
    await initDB();
    await pool.query(`INSERT INTO listings (id,title,url,source,price,true_gross_rent,bedrooms,bathrooms,neighborhood,location_area,
        status,is_evaluated,is_notified,suitability_score,evaluation_status,commute_minutes,commute_summary,rent_terms,evaluation_claim_token,evaluation_last_error)
        VALUES ('a','20 West 34th Street','https://www.streeteasy.com/building/fixture-a','streeteasy',2500,2500,1,1,'Lower East Side','Manhattan',
        'applied',true,true,88,'completed',20,'AI estimate', $1,'private-claim-token','private-provider-detail')`,
    [JSON.stringify({ gross_monthly_rent: 2500, concessions_mentioned: false, lease_months: 12, free_months: 0, rent_credit: 0 })]);
    await pool.query(`INSERT INTO listings (id,title,url,source,price,true_gross_rent,bedrooms,bathrooms,neighborhood,location_area,
        status,is_evaluated,is_notified,suitability_score,evaluation_status)
        VALUES ('b','100 West 42nd Street','https://www.streeteasy.com/building/fixture-b','streeteasy',2900,2900,1,1,'Lower East Side','Manhattan',
        'inbox',true,false,80,'completed')`);
    await pool.query(`INSERT INTO tour_schedules (id,listing_address,broker_email,proposed_datetime,proposed_time,status,special_instructions)
        VALUES ('tour-a','20 West 34th Street, Manhattan, NY','broker@example.test','2026-10-20T14:00:00-04:00','October 20 at 2 pm','proposed','Private access notes'),
        ('tour-b','100 West 42nd Street, Manhattan, NY','broker@example.test','2026-10-20T15:00:00-04:00','October 20 at 3 pm','confirmed',null)`);
    await featureStore.create('tour_links', 'tour-a', { listingId: 'a', conversationId: null });
    await featureStore.create('tour_links', 'tour-b', { listingId: 'b', conversationId: null });
    const now = Date.now();
    await featureStore.create('worker_health', 'scraper', { status: 'running', heartbeat_at: now - 120000, last_success_at: now - 120000 });
    await featureStore.create('worker_health', 'scorer', { status: 'running', heartbeat_at: now, last_success_at: now - 1000, error: 'private-provider-secret' });
    await featureStore.create('source_scans', 'fixture-scan', { source: 'streeteasy', feed_url: 'https://www.streeteasy.com/for-rent/manhattan?token=private-feed-token',
        outcome: 'empty', completed_at: now, observation_count: 0 });
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1'); listener.once('listening', () => resolve(listener)); listener.once('error', reject);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end(); fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(externalAttempts, 0, 'Dashboard actions covered here must not contact any external service');
});

test('real API owner session fails closed without configuration, rejects unauthorized reads/writes and permits public views', async () => {
    const unavailable = await request('/api/owner/session', { owner: false });
    assert.deepEqual(unavailable.body, { configured: false, authenticated: false });
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    assert.equal((await request('/api/watchlist/a', { method: 'PUT', body: { saved: true } })).status, 503);
    assert.equal((await request('/api/watchlist')).status, 503);
    process.env.HOUSING_OWNER_TOKEN = token;
    assert.deepEqual((await request('/api/owner/session', { owner: false })).body, { configured: true, authenticated: false });
    assert.deepEqual((await request('/api/owner/session')).body, { configured: true, authenticated: true });
    for (const url of ['/api/watchlist', '/api/compare?ids=a', '/api/listings/a/costs', '/api/listings/a/review', '/api/decisions',
        '/api/listings/a/conversation', '/api/conversations/unassigned', '/api/tours', '/api/schedule', '/api/tours/tour-a/schedule', '/api/tours/tour-a/calendar.ics']) {
        assert.equal((await request(url, { owner: false })).status, 401, url + ' requires owner');
        assert.equal((await request(url, { authorization: 'Bearer wrong-token' })).status, 401, url + ' rejects a wrong token');
    }
    for (const [url, method, body] of [
        ['/api/watchlist/a', 'PUT', { saved: true }], ['/api/listings/a/status', 'POST', { status: 'passed' }],
        ['/api/preferences', 'PUT', {}], ['/api/preferences/preview', 'POST', {}], ['/api/listings/a/costs', 'PUT', {}],
        ['/api/listings/a/review', 'PUT', {}], ['/api/listings/a/decision', 'POST', {}], ['/api/tours/tour-a/schedule', 'PUT', {}],
        ['/api/tours/tour-a/confirm', 'POST', {}], ['/api/itineraries/plan', 'POST', {}], ['/api/listings/a/commute', 'POST', {}],
        ['/api/listings/a/recheck', 'POST', {}], ['/api/conversations/message/assignment', 'PUT', {}]
    ]) assert.equal((await request(url, { owner: false, method, body })).status, 401, method + ' ' + url);
    assert.equal((await readListing('a')).status, 'applied');
    assert.equal(await featureStore.get('watchlist', 'a'), null);
    for (const url of ['/api/listings', '/api/preferences', '/api/health', '/api/stats', '/api/commute/status', '/api/listings/a/insights']) {
        assert.equal((await request(url, { owner: false })).status, 200, url + ' remains readable');
    }
    const listing = (await request('/api/listings', { owner: false })).body.find(row => row.id === 'a');
    assert.equal(listing.evaluation_claim_token, undefined); assert.equal(listing.evaluation_claim_expires_at, undefined);
    assert.equal(listing.evaluation_last_error, 'Evaluation temporarily unavailable.');
    assert.equal(listing.availability, 'unverified');
    const health = (await request('/api/health', { owner: false })).body;
    assert.equal(health.workers.find(worker => worker.name === 'scraper').status, 'stale');
    assert.equal(health.workers.find(worker => worker.name === 'scorer').status, 'degraded');
    assert.equal(health.sources[0].status, 'empty'); assert.equal(health.sources[0].count, 0);
    assert.ok(!JSON.stringify(health).includes('private-')); assert.equal(health.sources[0].feed.includes('?'), false);
});

test('real API stores watchlists, sources cost assumptions and rejects stale revisions without changing pipeline receipts', async () => {
    assert.equal((await request('/api/watchlist/a', { method: 'PUT', body: { saved: 'yes' } })).status, 400);
    const saved = await request('/api/watchlist/a', { method: 'PUT', body: { saved: true } });
    assert.equal(saved.status, 200); assert.equal(saved.body.saved, true);
    assert.equal((await request('/api/watchlist')).body.listings[0].id, 'a');
    assert.equal((await request('/api/listings', { owner: false })).body.find(row => row.id === 'a').saved, undefined, 'public listing reads do not reveal private watchlist choices');
    assert.equal((await readListing('a')).status, 'applied'); assert.equal((await readListing('a')).is_notified, 1);
    const costs = (await request('/api/listings/a/costs')).body;
    assert.equal(costs.revision, 0);
    costs.input.lease_months = 12; costs.input.rent.upfront_rent_months = 1; costs.input.rent.upfront_rent_credit = 0;
    costs.input.items = [{ id: 'deposit', label: 'Refundable security deposit', category: 'deposit', amount: 2500,
        cadence: 'one_time', refundable: true, due_before_move_in: true, evidence: 'assumed', source: 'Owner planning assumption' }];
    const payload = { revision: costs.revision, input: costs.input };
    const updated = await request('/api/listings/a/costs', { method: 'PUT', body: payload });
    assert.equal(updated.status, 200); assert.equal(updated.body.revision, 1);
    assert.equal(updated.body.calculation.totals.upfront_cash.amount, 5000);
    assert.equal(updated.body.calculation.totals.lease_nonrefundable.amount, 30000);
    assert.equal((await request('/api/listings/a/costs', { method: 'PUT', body: payload })).status, 409);
    assert.equal((await request('/api/listings/a/costs', { method: 'PUT', body: { revision: 1, input: { ...costs.input, lease_months: -1 } } })).status, 400);
    const comparison = await request('/api/compare?ids=a,b');
    assert.equal(comparison.status, 200); assert.deepEqual(comparison.body.listings.map(row => row.id), ['a', 'b']);
    assert.equal(comparison.body.listings[0].costs.revision, 1);
    assert.equal(comparison.body.listings[0].commute_summary, 'AI estimate');
    assert.equal((await request('/api/compare?ids=a,b,c,d,e')).status, 400);
    assert.equal((await request('/api/watchlist/missing', { method: 'PUT', body: { saved: true } })).status, 404);
});

test('real preference edits preview eligibility, persist shared revisions, flag old scores and preserve saved listings', async () => {
    const initial = (await request('/api/preferences', { owner: false })).body;
    const draft = structuredClone(initial); draft.budgets.studioOneBedroom.maxRent = 2400;
    const preview = await request('/api/preferences/preview', { method: 'POST', body: { preferences: draft } });
    assert.equal(preview.status, 200); assert.equal(preview.body.matching, 0);
    assert.equal((await request('/api/preferences')).body.revision, initial.revision);
    const invalid = structuredClone(draft); invalid.includedAreas = ['Unsupported region'];
    assert.equal((await request('/api/preferences', { method: 'PUT', body: invalid })).status, 400);
    const updated = await request('/api/preferences', { method: 'PUT', body: draft });
    assert.equal(updated.status, 200); assert.equal(updated.body.revision, initial.revision + 1);
    assert.equal((await request('/api/preferences', { method: 'PUT', body: draft })).status, 409);
    const listings = (await request('/api/listings', { owner: false })).body;
    assert.ok(listings.every(row => row.preferences_match === false && row.score_outdated === true));
    const watch = (await request('/api/watchlist')).body.listings;
    assert.equal(watch.length, 1); assert.equal(watch[0].search_match.matches, false);
    const listing = await readListing('a'); assert.equal(listing.status, 'applied'); assert.equal(listing.is_notified, 1);
});

test('real schedule API validates DST, detects conflicts, exports revised ICS and links completed-tour reviews without sending mail', async () => {
    const initial = (await request('/api/tours/tour-a/schedule')).body;
    assert.equal(initial.revision, 0); assert.equal(initial.listingId, 'a');
    assert.ok(initial.conflicts.some(conflict => conflict.kind === 'insufficient_buffer'));
    assert.equal((await request('/api/tours/tour-a/schedule', { method: 'PUT', body: { expectedRevision: 0, startsAt: '2026-11-01T01:30:00' } })).status, 422);
    const saved = await request('/api/tours/tour-a/schedule', { method: 'PUT', body: { expectedRevision: 0, startsAt: '2026-10-20T14:30:00-04:00', status: 'confirmed', reminderMinutes: [60] } });
    assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
    assert.ok(saved.body.conflicts.some(conflict => conflict.kind === 'overlap'));
    assert.equal((await request('/api/tours/tour-a/schedule', { method: 'PUT', body: { expectedRevision: 0, status: 'cancelled' } })).status, 409);
    assert.equal((await pool.query("SELECT status FROM tour_schedules WHERE id='tour-a'")).rows[0].status, 'proposed');
    const calendar = await request('/api/tours/tour-a/calendar.ics');
    assert.equal(calendar.status, 200); assert.match(calendar.headers.get('content-type'), /text\/calendar/);
    assert.match(calendar.body, /DTSTART:20261020T183000Z/); assert.match(calendar.body, /SEQUENCE:1/);
    const review = { revision: 0, tour_id: 'tour-a', checklist: { daylight: 5 }, notes: 'Bright afternoon living room', strengths: 'Large windows', issues: 'Small closet', rating: 4 };
    assert.equal((await request('/api/listings/a/review', { method: 'PUT', body: review })).status, 409);
    const completed = await request('/api/tours/tour-a/schedule', { method: 'PUT', body: { expectedRevision: 1, status: 'completed' } });
    assert.equal(completed.status, 200);
    const savedReview = await request('/api/listings/a/review', { method: 'PUT', body: review });
    assert.equal(savedReview.status, 200); assert.equal(savedReview.body.review.checklist.noise, null);
    assert.equal((await request('/api/listings/a/review', { method: 'PUT', body: review })).status, 409);
    const compared = (await request('/api/compare?ids=a')).body.listings[0];
    assert.equal(compared.review.review.notes, review.notes); assert.equal(compared.review.review.rating, 4);
    assert.equal(compared.suitability_score, 88); assert.equal(compared.status, 'applied');
    assert.equal((await featureStore.list('events')).length, 0);
    assert.equal((await featureStore.list('conversation_messages')).length, 0);
    const schedules = (await request('/api/schedule')).body;
    assert.equal(schedules.tours.find(tour => tour.id === 'tour-a').status, 'completed');
    assert.equal(schedules.conflicts.length, 0);
});

test('decisions retain reasons and reviews; independently recreated services read the actual persisted state', async () => {
    const decision = await request('/api/listings/a/decision', { method: 'POST', body: { revision: 0, action: 'pass', reason: 'Bedroom cannot fit a desk' } });
    assert.equal(decision.status, 200); assert.equal(decision.body.pipeline_pending, false);
    assert.equal((await readListing('a')).status, 'passed'); assert.equal((await readListing('a')).is_notified, 1);
    const decisions = (await request('/api/decisions')).body;
    assert.equal(decisions.activity[0].reason, 'Bedroom cannot fit a desk');
    assert.equal(decisions.listings[0].review.review.notes, 'Bright afternoon living room');
    const { createProductServices } = require('../src/product_services');
    const restartedServices = createProductServices({ localHealth: false });
    assert.equal((await restartedServices.preferences.get()).budgets.studioOneBedroom.maxRent, 2400);
    assert.equal((await restartedServices.selection.getCosts('a')).revision, 1);
    assert.equal((await restartedServices.tours.getSchedule('tour-a')).status, 'completed');
    assert.equal((await restartedServices.selection.getReview('a')).review.rating, 4);
    assert.equal((await getProductServices().store.list('events')).length, 0);
    assert.equal(externalAttempts, 0);
});
