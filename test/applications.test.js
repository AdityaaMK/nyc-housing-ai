const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createFeatureStore } = require('../src/feature_store');
const { createApplicationService, seedApplication } = require('../src/applications');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-applications-'));
    let db, store, timestamp = Date.parse('2026-10-17T16:00:00Z');
    const listings = new Map(Array.from({ length: 5 }, (_, index) => {
        const id = String.fromCharCode(97 + index);
        return [id, { id, id_hash: 'hash-' + id, title: 'Apartment ' + id, price: 2000, status: 'applied',
            url: 'https://example.com/' + id, broker_email: 'private@example.com', evaluation_claim_token: 'secret',
            evaluation_last_error: 'provider secret', true_gross_rent: 9999, neighborhood: 'Chelsea' }];
    }));
    const repository = { async getListing(id) { return { rows: [...listings.values()].filter(listing => listing.id === id || listing.id_hash === id) }; },
        async setListingStatus() { throw new Error('Application tracking must not change listing status.'); },
        async insertListing() { throw new Error('Application tracking must not create listings.'); } };
    const open = () => {
        db = new DatabaseSync(path.join(dir, 'applications.sqlite'));
        db.exec('CREATE TABLE IF NOT EXISTS feature_records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,id))');
        store = createFeatureStore({ backend: 'sqlite', async query(sql, params = []) {
            const values = [];
            const converted = sql.replace(/\$(\d+)/g, (_, i) => { values.push(params[Number(i) - 1]); return '?'; });
            const statement = db.prepare(converted);
            if (/^SELECT/.test(converted) || /RETURNING/.test(converted)) { const rows = statement.all(...values); return { rows, rowCount: rows.length }; }
            return { rows: [], rowCount: Number(statement.run(...values).changes) };
        } }, () => timestamp);
        return createApplicationService({ store, repository, now: () => timestamp });
    };
    const service = open();
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { service, listings, repository, get store() { return store; }, advance: minutes => { timestamp += minutes * 60000; },
        restart() { db.close(); return open(); } };
}
const deadline = overrides => ({ id: 'application_due', type: 'application', label: 'Submit application',
    dueAt: '2026-10-18T12:00:00-04:00', completed: false, reminderMinutes: [60, 1440], ...overrides });
const knownOffer = () => ({ monthlyRent: 3000, leaseMonths: 12, freeMonths: 1, rentCredit: 0, monthlyFees: 50, oneTimeFees: 20,
    refundableDeposit: 3000, upfrontRentMonths: 1, upfrontRentCredit: 0, leaseStart: '2026-11-01', leaseEnd: '2027-10-31',
    source: 'Written offer dated October 17', notes: 'One free month at the end of the lease.', termsConfirmed: true });

test('unsaved seeds are suggestions, unknown terms, and never infer submission from legacy applied status', async t => {
    const f = fixture(t), result = await f.service.get('hash-a');
    assert.equal(result.listingId, 'a');
    assert.equal(result.revision, 0);
    assert.equal(result.application.stage, 'preparing');
    assert.equal(result.application.documents.length, 4);
    assert.ok(result.application.documents.every(item => item.required === false));
    assert.match(result.documentSuggestionsNotice, /suggestions, not verified/);
    assert.equal(result.application.offer.monthlyRent, null);
    assert.equal(result.calculation.totals.upfront_cash.amount, null);
    assert.equal(result.calculation.totals.refundable_deposits.amount, null);
    assert.equal(result.listing.broker_email, undefined);
    assert.equal(result.listing.evaluation_claim_token, undefined);
    assert.equal(result.listing.evaluation_last_error, undefined);
    assert.deepEqual(await f.store.list('applications'), []);
    assert.deepEqual(await f.service.list(), { applications: [] });
    assert.deepEqual(await f.store.list('events'), []);
});

test('canonical record, document edits, stage timestamps, and activity persist through a real database restart', async t => {
    const f = fixture(t), draft = seedApplication();
    draft.notes = 'Confirm pets are accepted';
    const first = await f.service.update('hash-a', { revision: 0, application: draft });
    f.advance(10);
    draft.stage = 'submitted';
    draft.documents[0].status = 'submitted';
    draft.documents[0].required = true;
    draft.deadlines = [deadline()];
    const second = await f.service.update('a', { revision: first.revision, application: draft });
    assert.equal(second.revision, 2);
    assert.equal(second.application.deadlines[0].dueAt, '2026-10-18T16:00:00.000Z');
    assert.deepEqual(second.application.deadlines[0].reminderMinutes, [1440, 60]);
    assert.equal(second.activity.length, 2);
    assert.deepEqual(second.activity[0], first.activity[0]);
    assert.equal(second.activity[1].actor, 'user');
    assert.equal(second.activity[1].fromStage, 'preparing');
    assert.equal(second.activity[1].toStage, 'submitted');
    assert.ok(second.activity[1].changes.some(change => change.field === 'documents.photo_id.status' && change.after === 'submitted'));
    assert.deepEqual(second.stageTimestamps, { preparing: '2026-10-17T16:00:00.000Z', submitted: '2026-10-17T16:10:00.000Z' });
    assert.deepEqual(await f.restart().get('hash-a'), second);
    assert.equal((await f.service.list()).applications.length, 1);
    assert.equal(f.listings.get('a').status, 'applied');
    assert.equal((await f.store.list('events')).length, 0);
});

test('CAS rejects stale and concurrent changes, preserving the winning update and its audit entry', async t => {
    const f = fixture(t), original = seedApplication();
    const contenders = ['First', 'Second'].map(notes => f.service.update('a', { revision: 0, application: { ...original, notes } }));
    const results = await Promise.allSettled(contenders);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    const winner = results.find(result => result.status === 'fulfilled').value;
    assert.deepEqual(await f.service.get('a'), winner);
    await assert.rejects(f.service.update('a', { revision: 0, application: original }), { status: 409 });
    const unchanged = await f.service.update('a', { revision: winner.revision, application: winner.application });
    assert.deepEqual(unchanged, winner);
});

test('offer comparison calculates concessions, fees and upfront cash without double counting prepaid rent or refundable deposits', async t => {
    const f = fixture(t), application = seedApplication();
    application.offer = knownOffer();
    const saved = await f.service.update('a', { revision: 0, application });
    const totals = saved.calculation.totals;
    assert.equal(totals.recurring_monthly.amount, 3050);
    assert.equal(saved.calculation.effective_monthly_rent, 2750);
    assert.equal(totals.effective_monthly.amount, 2800);
    assert.equal(totals.lease_nonrefundable.amount, 33620);
    assert.equal(totals.upfront_cash.amount, 6070);
    assert.equal(totals.refundable_deposits.amount, 3000);
    const comparison = await f.service.compare(['a', 'b']);
    assert.equal(comparison.applications[1].revision, 0);
    assert.equal(comparison.applications[1].calculation.totals.upfront_cash.amount, null);
    assert.equal(comparison.applications[1].application.offer.monthlyRent, null);
    assert.equal(f.listings.get('a').true_gross_rent, 9999);
    assert.deepEqual(await f.store.list('housing_costs'), []);
});

test('explicit zeros remain known while incomplete concessions and costs stay unknown', async t => {
    const f = fixture(t), application = seedApplication();
    application.offer = { ...knownOffer(), freeMonths: 0, monthlyFees: 0, oneTimeFees: 0, refundableDeposit: 0,
        upfrontRentMonths: 0, upfrontRentCredit: 0, source: '', termsConfirmed: false };
    let saved = await f.service.update('a', { revision: 0, application });
    assert.equal(saved.calculation.totals.upfront_cash.amount, 0);
    assert.equal(saved.calculation.totals.refundable_deposits.amount, 0);
    assert.equal(saved.calculation.totals.upfront_cash.evidence, 'includes_assumptions');
    application.offer.freeMonths = null;
    application.offer.monthlyFees = null;
    saved = await f.service.update('a', { revision: saved.revision, application });
    assert.equal(saved.calculation.effective_monthly_rent, null);
    assert.equal(saved.calculation.totals.effective_monthly.amount, null);
    assert.equal(saved.calculation.totals.upfront_cash.amount, null);
    assert.equal(saved.calculation.totals.upfront_cash.known_amount, 0);
});

test('deadlines require valid explicit New York/UTC times, IDs and bounded reminder intervals', async t => {
    const f = fixture(t);
    for (const override of [
        { dueAt: '2026-03-08T02:30:00-05:00' }, { dueAt: '2026-10-18T12:00:00' },
        { dueAt: '2026-02-30T12:00:00Z' }, { dueAt: '2026-10-18T12:00:00+02:00' },
        { id: '../unsafe' }, { type: 'payment_sent' }, { completed: 'true' }, { reminderMinutes: [0] },
        { reminderMinutes: [10081] }, { reminderMinutes: [1, 2, 3, 4, 5] }
    ]) {
        const application = seedApplication(); application.deadlines = [deadline(override)];
        await assert.rejects(f.service.update('a', { revision: 0, application }), { status: 400 });
    }
    const application = seedApplication(); application.deadlines = [deadline({ dueAt: '2026-11-01T01:30:00-04:00' })];
    const saved = await f.service.update('a', { revision: 0, application });
    assert.equal(saved.application.deadlines[0].dueAt, '2026-11-01T05:30:00.000Z');
    application.deadlines[0].dueAt = '2026-11-01T01:30:00-05:00';
    const later = await f.service.update('a', { revision: saved.revision, application });
    assert.equal(later.application.deadlines[0].dueAt, '2026-11-01T06:30:00.000Z');
});

test('complete-input validation rejects malformed documents, dates, numbers, and unsupported mutations', async t => {
    const f = fixture(t);
    const mutations = [
        app => { app.unknown = true; }, app => { delete app.notes; }, app => { app.documents[0].required = 1; },
        app => { app.documents[0].status = 'uploaded'; }, app => { app.documents.push({ ...app.documents[0] }); },
        app => { app.documents[0].file = 'sensitive-data'; }, app => { app.stage = 'automatic_submission'; },
        app => { app.offer.monthlyRent = -1; }, app => { app.offer.monthlyRent = '3000'; },
        app => { app.offer = { ...knownOffer(), monthlyRent: 0.50, freeMonths: 0, rentCredit: 0 }; },
        app => { app.offer.monthlyRent = 3000.001; }, app => { app.offer.leaseMonths = 12.5; },
        app => { app.offer.leaseStart = '2026-02-30'; }, app => { app.offer.leaseStart = '2026-10-17'; app.offer.leaseEnd = '2026-10-16'; },
        app => { app.offer.termsConfirmed = true; }, app => { app.offer = { ...knownOffer(), freeMonths: 12 }; },
        app => { app.offer = { ...knownOffer(), upfrontRentCredit: 3100 }; },
        app => { app.deadlines = [deadline(), deadline()]; }
    ];
    for (const mutate of mutations) {
        const application = seedApplication(); mutate(application);
        await assert.rejects(f.service.update('a', { revision: 0, application }), { status: 400 });
    }
    await assert.rejects(f.service.update('a', { application: seedApplication() }), { status: 400 });
    await assert.rejects(f.service.update('a', { revision: 0, application: seedApplication(), activity: [] }), { status: 400 });
    assert.equal((await f.store.list('applications')).length, 0);
});

test('all explicit stages and corrections remain user records without triggering sends, listing changes, or payments', async t => {
    const f = fixture(t);
    let current = await f.service.get('a');
    for (const stage of ['preparing', 'submitted', 'approved', 'rejected', 'withdrawn', 'preparing', 'lease_signed']) {
        f.advance(1);
        current = await f.service.update('a', { revision: current.revision, application: { ...current.application, stage } });
    }
    assert.equal(current.activity.length, 7);
    assert.equal(current.activity[5].fromStage, 'withdrawn');
    assert.equal(current.activity[5].toStage, 'preparing');
    assert.equal(current.stageTimestamps.preparing, '2026-10-17T16:06:00.000Z');
    assert.equal(current.activity[0].at, '2026-10-17T16:01:00.000Z');
    assert.equal(f.listings.get('a').status, 'applied');
    assert.equal((await f.store.list('events')).length, 0);
    assert.equal((await f.store.list('conversation_messages')).length, 0);
});

test('comparison enforces canonical distinctness and limits; unsafe listing URLs and private fields are omitted', async t => {
    const f = fixture(t);
    f.listings.get('a').url = 'javascript:alert(1)';
    await assert.rejects(f.service.compare([]), { status: 400 });
    await assert.rejects(f.service.compare(['a', 'b', 'c', 'd', 'e']), { status: 400 });
    await assert.rejects(f.service.compare(['a', 'hash-a']), { status: 400 });
    await assert.rejects(f.service.get('missing'), { status: 404 });
    assert.equal((await f.service.get('a')).listing.url, null);
    const compare = await f.service.compare(['d', 'b', 'a', 'c']);
    assert.deepEqual(compare.applications.map(row => row.listingId), ['d', 'b', 'a', 'c']);
    assert.equal(compare.applications[2].listing.broker_email, undefined);
});

test('a failed atomic persistence leaves both application and its history unchanged', async t => {
    const f = fixture(t), first = await f.service.update('a', { revision: 0, application: seedApplication() });
    const originalPut = f.store.put;
    f.store.put = async () => { throw new Error('Fixture storage unavailable'); };
    await assert.rejects(f.service.update('a', { revision: first.revision, application: { ...first.application, stage: 'submitted' } }), /Fixture storage/);
    f.store.put = originalPut;
    assert.deepEqual(await f.service.get('a'), first);
});

test('related broker replies and decisions are linked readonly excerpts, excluding other listings and private provider fields', async t => {
    const f = fixture(t);
    const first = await f.service.update('a', { revision: 0, application: seedApplication() });
    const message = { listingId: 'a', direction: 'inbound', at: '2026-10-17T17:00:00Z', summary: '<b>Please confirm</b> your move-in date.',
        body: 'Raw body must not escape', sender: 'private@example.com', threadId: 'private-provider-token', receipt: { token: 'private' } };
    await f.store.create('conversation_messages', 'reply-a', message);
    await f.store.create('conversation_messages', 'outbound-a', { ...message, direction: 'outbound' });
    await f.store.create('conversation_messages', 'reply-b', { ...message, listingId: 'b' });
    await f.store.create('conversation_messages', 'ambiguous', { ...message, listingId: null, candidateListingIds: ['a', 'b'] });
    const decision = { id: 'choose-a', listing_id: 'a', action: 'apply', reason: 'Prepare documents', created_at: '2026-10-17T16:30:00Z' };
    await f.store.create('decisions', 'a', { history: [decision], pipeline_pending: true });
    await f.store.create('decisions', 'b', { history: [{ ...decision, id: 'choose-b', listing_id: 'b' }] });
    const result = await f.service.get('hash-a');
    assert.deepEqual(result.relatedActivity, [
        { id: 'decision:choose-a', at: '2026-10-17T16:30:00.000Z', type: 'decision', action: 'apply', summary: 'Prepare documents' },
        { id: 'broker_reply:reply-a', at: '2026-10-17T17:00:00.000Z', type: 'broker_reply', summary: 'Please confirm your move-in date.' }
    ]);
    assert.deepEqual(result.activity, first.activity);
    assert.equal(result.revision, first.revision);
    assert.deepEqual((await f.service.list()).applications[0].relatedActivity, result.relatedActivity);
    assert.equal((await f.store.get('decisions', 'a')).data.pipeline_pending, true);
    assert.equal((await f.store.list('events')).length, 0);
    assert.equal((await f.store.list('conversation_messages')).length, 4);
});
