const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createListingInsights, classifyScan, rentSnapshot, parseDetail, safeDetailUrl, ingestObservedListing } = require('../src/listing_insights');
function fixture(options = {}) {
    const data = new Map(), events = new Map();
    const copy = value => value && structuredClone(value);
    const key = (collection, id) => `${collection}\0${id}`;
    const store = {
        async get(collection, id) { return copy(data.get(key(collection, id)) || null); },
        async list(collection) { return [...data.entries()].filter(([k]) => k.startsWith(collection + '\0')).map(([, v]) => copy(v)); },
        async create(collection, id, value) { return await this.get(collection, id) || this.put(collection, id, value, { expectedRevision: 0 }); },
        async put(collection, id, value, { expectedRevision }) {
            const prior = data.get(key(collection, id));
            if ((prior?.revision || 0) !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
            const row = { id, data: copy(value), revision: expectedRevision + 1 }; data.set(key(collection, id), row); return copy(row);
        },
        async enqueueEvent(event) { if (!events.has(event.id)) events.set(event.id, copy(event)); }
    };
    const listings = new Map([['apt', { id: 'apt', title: '100 Main St #4', url: 'https://www.renthop.com/listings/main/4/123', source: 'renthop', status: 'inbox', price: 3000 }]]);
    const repository = {
        async getListing(id) { return { rows: listings.has(id) ? [copy(listings.get(id))] : [] }; },
        async listingExists(id) { return this.getListing(id); },
        async listListings() { return { rows: [...listings.values()].map(copy) }; },
        async updateListingObservation(id, value) { Object.assign(listings.get(id), value); },
        async insertListing(value) { listings.set(value.id, { status: 'inbox', ...value }); return { rowCount: 1 }; },
        async recordDuplicate({ newUrl }) { return [...listings.values()].find(listing => listing.url === newUrl) || null; }
    };
    let clock = new Date('2026-10-16T12:00:00Z');
    const config = { store, repository, now: () => clock, isEligible: () => true, ...options };
    return { store, events, listings, repository, config, service: createListingInsights(config), advance(ms) { clock = new Date(clock.getTime() + ms); } };
}
const observation = { listingId: 'apt', source: 'renthop', url: 'https://www.renthop.com/listings/main/4/123', advertised_rent: 3000, availability: 'active' };
test('legacy listings are unverified; repeated observations preserve application state and source identity', async () => {
    const f = fixture(); f.listings.get('apt').status = 'applied';
    assert.equal((await f.service.getInsights('apt')).availability, 'unverified');
    assert.equal((await f.service.getInsights('apt')).last_verified_at, null);
    await f.service.observe(observation); f.advance(3600000);
    const result = await f.service.observe(observation);
    assert.equal(result.availability, 'active'); assert.equal(result.price_history.length, 1);
    assert.equal(result.last_verified_at, '2026-10-16T13:00:00.000Z');
    assert.equal(f.listings.get('apt').status, 'applied'); assert.equal(f.events.size, 0);
});
test('a $150 advertised drop queues one durable event across scans and service restarts', async () => {
    const f = fixture(); await f.service.observe(observation); f.advance(60000);
    const changed = { ...observation, advertised_rent: 2850 };
    const result = await f.service.observe(changed);
    await createListingInsights(f.config).observe(changed);
    assert.equal(f.events.size, 1); assert.equal([...f.events.values()][0].payload.drop, 150);
    assert.equal([...f.events.values()][0].payload.basis, 'advertised');
    assert.equal(result.price_history.length, 2); assert.equal(result.assessment_outdated, true);
    assert.equal(f.listings.get('apt').price, 2850);
});
test('gross-to-net advertisement changes never become gross or advertised drops', async () => {
    const f = fixture();
    await f.service.observe({ ...observation, price_basis: 'gross', gross_rent: 3000, gross_verified: true });
    await f.service.observe({ ...observation, advertised_rent: 2850, price_basis: 'net_effective' });
    assert.equal(f.events.size, 0);
    const latest = (await f.service.getInsights('apt')).price_history.find(row => row.advertised_basis === 'net_effective');
    assert.equal(latest.verified_gross_rent, null); assert.equal(latest.effective_rent, null);
});
test('verified concession arithmetic stays separate; incomplete terms never invent effective rent', async () => {
    const f = fixture();
    const gross = { ...observation, gross_rent: 3000, gross_verified: true, terms_verified: true };
    await f.service.observe({ ...gross, rent_terms: { concessions_mentioned: false, lease_months: 12, free_months: 0, rent_credit: 0 } });
    await f.service.observe({ ...gross, rent_terms: { concessions_mentioned: true, lease_months: 12, free_months: 1, rent_credit: 0 } });
    assert.equal([...f.events.values()][0].payload.drop, 250);
    assert.equal([...f.events.values()][0].payload.basis, 'effective');
    assert.equal(rentSnapshot({ ...gross, rent_terms: { concessions_mentioned: true, lease_months: null, free_months: 1, rent_credit: 0 } }).effective_rent, null);
});
test('blocked or missing feeds do not remove listings; active cross-post explains conflicting evidence', async () => {
    const f = fixture(); await f.service.observe(observation);
    await f.service.observe({ ...observation, source: 'compass', url: 'https://www.compass.com/homedetails/apt/123_lid/', availability: 'unavailable', evidence: 'explicit_unavailable_detail' });
    const result = await f.service.getInsights('apt');
    assert.equal(result.availability, 'active'); assert.equal(result.conflicting_evidence, true);
    await f.service.recordScan({ source: 'renthop', outcome: 'blocked', parsedCount: 0 });
    assert.equal((await f.service.getInsights('apt')).availability, 'active');
    f.advance(4 * 86400000); assert.equal((await f.service.getInsights('apt')).availability, 'unverified');
});
test('unparseable detail preserves known evidence without inventing a new verification time', async () => {
    const f = fixture(); await f.service.observe(observation); f.advance(86400000);
    const result = await f.service.observe({ ...observation, advertised_rent: null, availability: 'unverified', evidence: 'blocked' });
    assert.equal(result.last_verified_at, '2026-10-16T12:00:00.000Z');
    assert.equal(result.sources[0].last_attempt_at, '2026-10-17T12:00:00.000Z');
    const g = fixture(); await g.service.observe({ ...observation, advertised_rent: null, availability: 'unverified' });
    assert.equal((await g.service.getInsights('apt')).last_verified_at, null);
});
test('outbox retry after process interruption recovers the snapshot and never duplicates alerts', async () => {
    const f = fixture(); await f.service.observe(observation);
    const enqueue = f.store.enqueueEvent.bind(f.store); let fail = true;
    f.store.enqueueEvent = async event => { if (fail) throw new Error('simulated persistence outage'); return enqueue(event); };
    await assert.rejects(f.service.observe({ ...observation, advertised_rent: 2850 }));
    fail = false; await createListingInsights(f.config).observe({ ...observation, advertised_rent: 2850 });
    assert.equal(f.events.size, 1); assert.equal((await f.service.getInsights('apt')).price_history.length, 2);
});
test('passed changes do not replay as historical alerts after the listing returns to inbox', async () => {
    const f = fixture(); await f.service.observe(observation); f.listings.get('apt').status = 'passed';
    await f.service.observe({ ...observation, advertised_rent: 2850 });
    f.listings.get('apt').status = 'inbox'; await f.service.observe({ ...observation, advertised_rent: 2850 });
    assert.equal(f.events.size, 0);
});
test('scan classifications distinguish verified zero, blocked pages, and empty parser failures', () => {
    assert.equal(classifyScan({ html: '<h1>No listings found</h1>' }), 'empty');
    assert.equal(classifyScan({ html: '<html>Search</html>' }), 'parser_failure');
    assert.equal(classifyScan({ html: 'captcha No listings found' }), 'blocked');
    assert.equal(classifyScan({ parsedCount: 2, parseErrors: 1 }), 'partial');
});
test('detail checks require supported URLs and explicit removal evidence', () => {
    for (const url of ['http://www.renthop.com/listings/x', 'https://127.0.0.1/listings/x', 'https://renthop.com.evil.test/listings/x', 'https://x@www.renthop.com/listings/x', 'https://www.renthop.com/search']) assert.throws(() => safeDetailUrl(url));
    assert.equal(safeDetailUrl('https://www.compass.com/listing/100-main-st/123/'), 'https://www.compass.com/listing/100-main-st/123/');
    assert.equal(safeDetailUrl('https://streeteasy.com/rental/1234567'), 'https://streeteasy.com/rental/1234567');
    assert.equal(safeDetailUrl('https://www.renthop.com/listings/main/4/123'), 'https://www.renthop.com/listings/main/4/123');
    assert.equal(parseDetail({ status: 404 }).availability, 'unverified');
    assert.equal(parseDetail({ html: '<h1>This listing is no longer available</h1>' }).availability, 'unavailable');
    assert.equal(parseDetail({ html: '<h1>Captcha</h1>This listing is no longer available' }).availability, 'unverified');
});
test('manual rechecks are rate-limited and a blocked refresh preserves freshness', async () => {
    let calls = 0;
    const f = fixture({ fetchDetail: async () => { calls++; return { html: 'Access denied', status: 403 }; } });
    await f.service.observe(observation); f.advance(60000);
    assert.equal((await f.service.recheck('apt')).availability, 'active');
    await assert.rejects(f.service.recheck('apt'), error => error.status === 429);
    assert.equal(calls, 1);
});
test('already known listings outside current feed budget still get fresh observations', async () => {
    const f = fixture();
    const result = await ingestObservedListing({ listing: { ...f.listings.get('apt'), price: 2800 }, matchesFeed: false, insights: f.service, repository: f.repository });
    assert.deepEqual(result, { inserted: false, observed: true }); assert.equal(f.listings.get('apt').price, 2800);
    assert.equal((await f.service.getInsights('apt')).availability, 'active');
});
test('detail descriptions extract explicit gross rent and concessions without treating net rent as gross', async () => {
    const detail = parseDetail({ html: '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Apartment', price: 2750,
        description: 'Gross rent $3000, one month free on a 12-month lease. Advertised net-effective rent $2750.' }) + '</script>' });
    const snapshot = rentSnapshot(detail);
    assert.equal(snapshot.verified_gross_rent, 3000); assert.equal(snapshot.effective_rent, 2750); assert.equal(snapshot.advertised_basis, 'net_effective');
    const netOnly = parseDetail({ html: '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Apartment', price: 2750, description: 'Net effective $2750 with concessions.' }) + '</script>' });
    assert.equal(rentSnapshot(netOnly).verified_gross_rent, null); assert.equal(rentSnapshot(netOnly).effective_rent, null);
});
test('lightweight repeat feed preserves verified detail terms and avoids endless reevaluations', async () => {
    let requeues = 0;
    const f = fixture({ onTermsChanged: async () => { requeues++; } });
    await f.service.observe(observation);
    await f.service.observe({ ...observation, gross_rent: 3000, gross_verified: true, terms_verified: true,
        rent_terms: { concessions_mentioned: true, lease_months: 12, free_months: 1, rent_credit: 0 } });
    await f.service.observe(observation); await f.service.observe(observation);
    const result = await f.service.getInsights('apt');
    assert.equal(result.price_history.length, 2); assert.equal(requeues, 1);
    assert.equal(result.sources[0].current_snapshot.effective_rent, 2750);
});
test('known cross-post identity survives missing unit/address on later feed cards', async () => {
    const f = fixture();
    const cross = { ...observation, source: 'compass', url: 'https://www.compass.com/listing/main/123/' };
    await f.service.observe(cross);
    const result = await ingestObservedListing({ listing: { id: 'compass_123', source: cross.source, url: cross.url, price: 3000,
        title: 'Rental apartment', normalized_address: null }, repository: f.repository, insights: f.service });
    assert.equal(result.inserted, false); assert.equal(f.listings.size, 1);
    assert.equal((await f.service.getInsights('apt')).sources.filter(row => row.url === cross.url).length, 1);
});
test('watchlisted price drops remain eligible outside preferences; unavailable apartments never alert', async () => {
    const f = fixture({ isEligible: () => false });
    await f.store.create('watchlist', 'apt', { saved: true });
    await f.service.observe(observation);
    await f.service.observe({ ...observation, advertised_rent: 2850 });
    assert.equal(f.events.size, 1);
    await f.service.observe({ ...observation, advertised_rent: 2800, availability: 'unavailable', evidence: 'explicit_unavailable_detail' });
    assert.equal((await f.service.getInsights('apt')).availability, 'unavailable');
    assert.equal(f.events.size, 1);
});
test('a removed cross-post cannot establish that the never-verified primary listing is unavailable', async () => {
    const f = fixture();
    const result = await f.service.observe({ ...observation, source: 'compass', url: 'https://www.compass.com/listing/apt/123/', availability: 'unavailable', evidence: 'explicit_unavailable_detail' });
    assert.equal(result.availability, 'unverified');
    assert.equal(result.sources.find(source => source.url === observation.url).observed_at, null);
});
test('background refresh includes contacted listings, respects the three-listing cap, and skips passed watchlist entries', async () => {
    const fetched = [];
    const f = fixture({ fetchDetail: async url => { fetched.push(url); return { html: '<h1>Access denied</h1>', status: 403 }; } });
    const original = f.listings.get('apt'); original.status = 'contacted';
    for (let index = 0; index < 4; index++) f.listings.set(`contacted-${index}`, { ...original, id: `contacted-${index}`, url: `https://www.renthop.com/listings/main/4/${index}` });
    f.listings.set('passed', { ...original, id: 'passed', status: 'passed', url: 'https://www.renthop.com/listings/main/4/passed' });
    await f.store.create('watchlist', 'passed', { saved: true });
    assert.deepEqual(await f.service.recheckTracked({ limit: 20 }), { checked: 3 });
    assert.equal(fetched.length, 3); assert.ok(fetched.includes(original.url));
    assert.equal(fetched.some(url => url.includes('/passed')), false);
    assert.equal((await f.store.get('listing_rechecks', 'apt')).data.outcome, 'complete');
});
test('manual refresh verifies legacy cross-posts despite an unavailable primary and retains the three-URL cap', async () => {
    const active = 'https://www.compass.com/listing/active/123/';
    const other = 'https://streeteasy.com/rental/456';
    const extra = 'https://www.renthop.com/listings/main/4/789';
    const fetched = [];
    const f = fixture({ fetchDetail: async url => {
        fetched.push(url);
        return { html: url === active ? '<script type="application/ld+json">{"@type":"Apartment","price":3000}</script>' : '<h1>This listing is no longer available</h1>', status: 200 };
    } });
    f.listings.get('apt').cross_posted_sources = JSON.stringify([null, { source: 'private', url: 'https://127.0.0.1/listings/private' },
        { source: 'compass', url: active }, { source: 'streeteasy', url: other }, { source: 'renthop', url: extra }]);
    const result = await f.service.recheck('apt');
    assert.deepEqual(fetched, [observation.url, active, other]);
    assert.equal(result.availability, 'active'); assert.equal(result.conflicting_evidence, true);
    assert.equal(result.sources.find(source => source.url === active).availability, 'active');
    assert.ok(result.sources.find(source => source.url === active).observed_at);
    assert.equal(result.sources.find(source => source.url === extra).observed_at, null);
});
