const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createFeatureStore } = require('../src/feature_store');
const { createProductServices } = require('../src/product_services');
const { createProductEventBridge } = require('../src/product_events');
const { openState, resolveDelivery, readStatus } = require('../src/telegram_state');
const { notificationCycle } = require('../src/telegram_worker');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-product-events-'));
    const db = new DatabaseSync(path.join(directory, 'features.sqlite'));
    db.exec('CREATE TABLE feature_records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,id))');
    const adapter = { backend: 'sqlite', async query(sql, params = []) {
        const values = [], converted = sql.replace(/\$(\d+)/g, (_, i) => { values.push(params[Number(i) - 1]); return '?'; });
        const statement = db.prepare(converted);
        if (/^SELECT/.test(converted) || /RETURNING/.test(converted)) { const rows = statement.all(...values); return { rows, rowCount: rows.length }; }
        return { rows: [], rowCount: Number(statement.run(...values).changes) };
    } };
    let at = Date.parse('2026-10-16T15:00:00Z');
    const listing = { id: 'apartment', source: 'streeteasy', url: 'https://streeteasy.com/building/1-main-street/1a',
        title: 'Sunny <apartment>', price: 3000, true_gross_rent: 3000, effective_monthly_rent: 2500, status: 'inbox',
        bedrooms: 1, bathrooms: 1, location_area: 'Manhattan', neighborhood: 'Lower East Side', suitability_score: 92, is_evaluated: true,
        rent_terms: JSON.stringify({ gross_monthly_rent: 3000, lease_months: 12, free_months: 2, rent_credit: 0, concessions_mentioned: true }),
        evaluation_claim_token: 'private-claim', evaluation_last_error: 'provider-debug-api-key=private-secret' };
    const tours = new Map(), requeued = [];
    const repository = {
        async getListing(id) { return { rows: id === listing.id ? [{ ...listing }] : [] }; },
        async listListings() { return { rows: [{ ...listing }] }; },
        async pendingNotifications() { return { rows: [] }; },
        async updateListingObservation(id, update) { Object.assign(listing, update); return { rowCount: 1 }; },
        async requeueEvaluation(id) { requeued.push(id); return { rowCount: 1 }; },
        async markNotified() { throw new Error('Product alerts must not mutate listing receipts'); },
        async getTour(id) { return { rows: tours.has(id) ? [{ ...tours.get(id) }] : [] }; },
        async listTours() { return { rows: [...tours.values()].map(tour => ({ ...tour })) }; }
    };
    const store = createFeatureStore(adapter, () => at);
    const services = createProductServices({ store, repo: repository, db: adapter, now: () => at, localHealth: false,
        routeService: { lookup() { throw new Error('No automatic route requests'); } } });
    const bridge = createProductEventBridge(services, () => at);
    const statePath = path.join(directory, 'telegram.sqlite');
    let state = openState(statePath, 'fixture-bot-chat-database');
    const requests = [];
    let send = async payload => { requests.push(payload); return { message_id: requests.length }; };
    const reopen = () => { state.close(); state = openState(statePath, 'fixture-bot-chat-database'); };
    t.after(() => { state.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { store, services, bridge, listing, tours, requeued, requests, statePath,
        get state() { return state; }, now: () => at, advance: ms => { at += ms; }, reopen,
        acknowledge(id, messageId) { state.close(); resolveDelivery(statePath, id, messageId); state = openState(statePath, 'fixture-bot-chat-database'); },
        setSend: callback => { send = callback; },
        cycle: () => notificationCycle({ state, repository, api: { sendMessage: (...args) => send(...args) }, chatId: 'fixture-chat',
            now: () => at, wait: async () => {}, productBridge: bridge }),
        async watch() { await services.selection.setWatchlist(listing.id, true); },
        async observe(price, options = {}) {
            await services.insights.observe({ listingId: listing.id, source: listing.source, url: listing.url,
                advertised_rent: price, availability: 'active', price_basis: 'unknown', ...options });
            at += 1000;
        },
        async drop() { await this.watch(); await this.observe(3000); await this.observe(2850); return (await store.list('events'))[0]; },
        async schedule(options = {}) {
            tours.set('tour', { id: 'tour', listing_address: '1 Main Street, Manhattan', status: 'proposed',
                proposed_datetime: new Date(at + 60 * 60000).toISOString() });
            return services.tours.updateSchedule('tour', { expectedRevision: 0, listingId: listing.id, status: 'confirmed', reminderMinutes: [60], ...options });
        }
    };
}

test('shared event to Telegram journal handoff recovers a crash before the shared acknowledgement without duplicate delivery', async t => {
    const f = fixture(t), event = await f.drop(), originalPut = f.store.put;
    let crash = true;
    f.store.put = async (...args) => {
        if (args[0] === 'events' && crash) { crash = false; throw new Error('Crash before shared acknowledgement'); }
        return originalPut(...args);
    };
    await assert.rejects(f.bridge.importInto(f.state), /acknowledgement/);
    assert.equal(f.state.ready(f.now()).length, 1);
    assert.equal((await f.store.get('events', event.id)).data.status, 'pending');
    f.reopen(); f.store.put = originalPut;
    await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].text, /Decrease: \$150/);
    assert.match(f.requests[0].text, /Sunny &lt;apartment&gt;/);
    assert.equal((await f.store.get('events', event.id)).data.status, 'transferred');
    f.reopen(); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.state.status().map(row => ({ ...row })), [{ status: 'done', count: 1 }]);
});

test('ambiguous Telegram product delivery stays quarantined across restarts and explicit receipt repair never resends', async t => {
    const f = fixture(t), event = await f.drop(); let attempts = 0;
    f.setSend(async () => { attempts++; throw new Error('network timeout with private-secret'); });
    await f.cycle();
    assert.equal(attempts, 1);
    assert.equal(readStatus(f.statePath).needsReview[0].id, 'event:' + event.id);
    assert.doesNotMatch(JSON.stringify(readStatus(f.statePath)), /private-secret/);
    f.reopen(); await f.cycle(); assert.equal(attempts, 1);
    f.acknowledge('event:' + event.id, 888);
    await f.cycle();
    assert.equal(attempts, 1);
    assert.deepEqual(f.state.status().map(row => ({ ...row })), [{ status: 'done', count: 1 }]);
});

test('confirmed product receipt survives a crash before journal completion', async t => {
    const f = fixture(t); await f.drop();
    f.state.finish = () => { throw new Error('Crash after confirmed receipt'); };
    await assert.rejects(f.cycle(), /confirmed receipt/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.ready(f.now())[0].status, 'sent');
    f.reopen(); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.ready(f.now()).length, 0);
});

test('Telegram rate-limit pause for price events persists and retries once after its deadline', async t => {
    const f = fixture(t); await f.drop(); let attempts = 0;
    f.setSend(async payload => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('Rate limited'), { errorCode: 429, retryAfter: 300 });
        f.requests.push(payload); return { message_id: 12 };
    });
    await f.cycle();
    assert.equal(attempts, 1);
    f.reopen(); await f.cycle(); assert.equal(attempts, 1);
    f.advance(300001); await f.cycle();
    assert.equal(attempts, 2); assert.equal(f.requests.length, 1);
});

test('obsolete price snapshots and passed apartments are cancelled immediately before dispatch', async t => {
    const f = fixture(t); await f.drop(); await f.observe(2900);
    await f.cycle(); assert.equal(f.requests.length, 0);
    assert.equal(f.state.status()[0].status, 'cancelled');
    await f.observe(2800); f.listing.status = 'passed';
    await f.cycle(); assert.equal(f.requests.length, 0);
});

test('an unavailable price source cannot alert through an active cross-post; active cross-post alerts link their source', async t => {
    const f = fixture(t); await f.drop();
    const cross = { source: 'renthop', url: 'https://www.renthop.com/listings/main-street/1a/123' };
    await f.observe(3200, cross);
    await f.observe(null, { availability: 'unavailable', evidence: 'explicit_unavailable_detail' });
    assert.equal((await f.services.insights.getInsights(f.listing.id)).availability, 'active');
    await f.cycle(); assert.equal(f.requests.length, 0);
    await f.observe(3100, cross); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].reply_markup.inline_keyboard[0][0].url, cross.url);
});

test('gross-to-net advertising changes with incomplete concessions do not become verified rent-drop alerts', async t => {
    const f = fixture(t); await f.watch();
    await f.observe(3000, { price_basis: 'gross', gross_rent: 3000, gross_verified: true, terms_verified: true,
        rent_terms: { lease_months: 12, concessions_mentioned: false, free_months: 0, rent_credit: 0 } });
    await f.observe(2850, { price_basis: 'net_effective', gross_rent: 3000, gross_verified: true, terms_verified: true,
        rent_terms: { lease_months: null, concessions_mentioned: true, free_months: null, rent_credit: null } });
    assert.equal((await f.store.list('events')).length, 0);
    await f.cycle(); assert.equal(f.requests.length, 0);
});

test('tour reminder revisions invalidate queued messages and a delivered reminder is not replayed after restart', async t => {
    const f = fixture(t), original = await f.schedule();
    await f.bridge.importInto(f.state);
    assert.equal(f.state.ready(f.now()).length, 1);
    const moved = await f.services.tours.updateSchedule('tour', { expectedRevision: original.revision,
        startsAt: new Date(f.now() + 120 * 60000).toISOString() });
    await f.cycle(); assert.equal(f.requests.length, 0);
    f.advance(60 * 60000); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].text, /Upcoming apartment tour/);
    f.reopen(); await f.cycle(); assert.equal(f.requests.length, 1);
    await f.services.tours.updateSchedule('tour', { expectedRevision: moved.revision, status: 'cancelled' });
    await f.cycle(); assert.equal(f.requests.length, 1);
});

test('current price eligibility ignores stale AI rent terms and comparison responses redact worker secrets', async t => {
    const f = fixture(t);
    // The prior AI estimate says $2,500, but the newly observed asking rents are
    // outside the one-bedroom budget. No stale estimate may requalify the alert.
    await f.observe(3100); await f.observe(2900);
    assert.equal((await f.store.list('events')).length, 0);
    const comparison = await f.services.selection.comparison([f.listing.id]);
    assert.doesNotMatch(JSON.stringify(comparison), /private-claim|private-secret/);
    assert.equal(comparison.listings[0].freshness.assessment_outdated, true);
    const enriched = await f.services.enrichListings([{ ...f.listing }]);
    assert.equal(require('../src/telegram_messages').eligibleForAlert(enriched[0]), false);
});

test('selection costs and budget matching use fresh observed terms while preserving user estimates after another change', async t => {
    const f = fixture(t);
    const verified = price => ({ gross_rent: price, gross_verified: true, terms_verified: true, price_basis: 'gross',
        rent_terms: { lease_months: 12, concessions_mentioned: false, free_months: 0, rent_credit: 0 } });
    await f.observe(3000, verified(3000)); await f.observe(3500, verified(3500));
    let costs = await f.services.selection.getCosts(f.listing.id);
    assert.equal(costs.input.rent.gross_monthly, 3500);
    assert.equal(costs.input.rent.evidence, 'confirmed');
    assert.equal(costs.calculation.lease_rent, 42000);
    assert.equal(costs.assumption_freshness.status, 'current');
    assert.match(costs.input.rent.source, /streeteasy/);
    let compared = (await f.services.selection.comparison([f.listing.id])).listings[0];
    assert.equal(compared.search_match.matches, false);
    assert.equal(compared.true_gross_rent, 3500);
    assert.equal(compared.effective_monthly_rent, 3500);
    assert.equal(compared.suitability_score, 92);
    costs.input.rent.gross_monthly = 3400;
    costs.input.rent.evidence = 'assumed'; costs.input.rent.source = 'Possible negotiated rent';
    await f.services.selection.updateCosts(f.listing.id, { revision: costs.revision, input: costs.input });
    await f.observe(3700, verified(3700));
    costs = await f.services.selection.getCosts(f.listing.id);
    assert.equal(costs.input.rent.gross_monthly, 3400);
    assert.equal(costs.assumption_freshness.status, 'needs_review');
    assert.equal(costs.assumption_freshness.input_source, 'user');
    assert.match(costs.assumption_freshness.reason, /preserved/);
    compared = (await f.services.selection.comparison([f.listing.id])).listings[0];
    assert.equal(compared.true_gross_rent, 3700);
    assert.equal(compared.costs.input.rent.gross_monthly, 3400);
});

test('changed asking rent without fresh lease evidence makes seeded costs unknown instead of recycling old AI concessions', async t => {
    const f = fixture(t); await f.observe(3000); await f.observe(4000);
    const costs = await f.services.selection.getCosts(f.listing.id);
    assert.equal(costs.input.rent.gross_monthly, null);
    assert.equal(costs.input.rent.free_months, null);
    assert.equal(costs.calculation.totals.lease_nonrefundable.amount, null);
    assert.equal(costs.assumption_freshness.status, 'unverified');
    const compared = (await f.services.selection.comparison([f.listing.id])).listings[0];
    assert.equal(compared.price, 4000);
    assert.equal(compared.true_gross_rent, null);
    assert.equal(compared.effective_monthly_rent, null);
    assert.equal(compared.search_match.matches, false);
});
