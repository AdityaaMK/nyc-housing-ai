const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createFeatureStore } = require('../src/feature_store');
const { createApplicationService, seedApplication } = require('../src/applications');
const { createApplicationReminders, OVERDUE_WINDOW } = require('../src/application_reminders');
const { createProductEventBridge } = require('../src/product_events');
const { openState, readStatus, resolveDelivery } = require('../src/telegram_state');
const { notificationCycle } = require('../src/telegram_worker');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-application-reminders-'));
    const databasePath = path.join(directory, 'features.sqlite');
    const statePath = path.join(directory, 'telegram.sqlite');
    let db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE feature_records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,id))');
    const adapter = { backend: 'sqlite', async query(sql, params = []) {
        const values = [], converted = sql.replace(/\$(\d+)/g, (_, i) => { values.push(params[Number(i) - 1]); return '?'; });
        const statement = db.prepare(converted);
        if (/^SELECT/.test(converted) || /RETURNING/.test(converted)) { const rows = statement.all(...values); return { rows, rowCount: rows.length }; }
        return { rows: [], rowCount: Number(statement.run(...values).changes) };
    } };
    let at = Date.parse('2026-10-17T15:00:00Z');
    const listings = new Map([['apartment', { id: 'apartment', title: '<Sunny & bright>', status: 'inbox' }]]);
    const repository = { getListing: async id => ({ rows: listings.has(id) ? [listings.get(id)] : [] }),
        pendingNotifications: async () => ({ rows: [] }), markNotified: async () => { throw new Error('Application reminders do not mark listing alerts delivered'); } };
    const store = createFeatureStore(adapter, () => at);
    const applications = createApplicationService({ store, repository, now: () => at });
    const reminders = createApplicationReminders({ store, applications, repository, now: () => at });
    const bridge = createProductEventBridge({ store, repository, applicationReminders: reminders,
        preferences: { get: async () => ({}) }, tours: { queueDueReminders: async () => {} }, enrichListings: async rows => rows }, () => at);
    let state = openState(statePath, 'fixture');
    const requests = [];
    let send = async payload => { requests.push(payload); return { message_id: requests.length }; };
    t.after(() => { state.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { store, applications, reminders, bridge, repository, requests, listings, statePath,
        get state() { return state; }, now: () => at, advance: value => { at += value; },
        setSend: value => { send = value; },
        reopen() { state.close(); db.close(); db = new DatabaseSync(databasePath); state = openState(statePath, 'fixture'); },
        acknowledge(id, messageId) { state.close(); resolveDelivery(statePath, id, messageId); state = openState(statePath, 'fixture'); },
        cycle: () => notificationCycle({ state, repository, api: { sendMessage: (...args) => send(...args) }, chatId: 'fixture-chat',
            now: () => at, wait: async () => {}, productBridge: bridge }),
        events: () => store.list('events'),
        async save(changes = {}) {
            const old = await applications.get('apartment');
            return applications.update('apartment', { revision: old.revision, application: { ...seedApplication(),
                deadlines: [{ id: 'submit', type: 'application', label: 'Submit <application> & documents',
                    dueAt: new Date(at + 60 * 60000).toISOString(), completed: false, reminderMinutes: [1440, 60] }],
                ...(old.revision ? old.application : {}), ...changes } });
        },
        async deadline(changes) {
            const view = await applications.get('apartment');
            return this.save({ deadlines: [{ ...view.application.deadlines[0], ...changes }] });
        }
    };
}

test('application reminders persist across full storage restart and notes/checklist edits do not duplicate alerts', async t => {
    const f = fixture(t); await f.save();
    await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.equal((await f.events()).length, 1);
    assert.match(f.requests[0].text, /Upcoming application deadline/);
    assert.match(f.requests[0].text, /&lt;Sunny &amp; bright&gt;/);
    assert.match(f.requests[0].text, /Submit &lt;application&gt; &amp; documents/);
    assert.match(f.requests[0].text, /New York/);
    f.reopen();
    await f.save({ notes: 'New note', documents: [{ id: 'income', label: 'Pay stubs', status: 'ready', required: false, note: '' }] });
    await f.cycle(); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.equal((await f.events()).length, 1);
    assert.deepEqual(f.state.status().map(row => ({ ...row })), [{ status: 'done', count: 1 }]);
});

test('event handoff recovers after shared acknowledgement fails without replaying the journal delivery', async t => {
    const f = fixture(t); await f.save();
    const put = f.store.put; let failed = false;
    f.store.put = async (...args) => {
        if (args[0] === 'events' && !failed) { failed = true; throw new Error('interrupted handoff'); }
        return put(...args);
    };
    await assert.rejects(f.bridge.importInto(f.state), /interrupted handoff/);
    assert.equal(f.state.ready(f.now()).length, 1);
    assert.equal((await f.events())[0].data.status, 'pending');
    f.store.put = put; f.reopen(); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.equal((await f.events())[0].data.status, 'transferred');
    f.reopen(); await f.cycle(); assert.equal(f.requests.length, 1);
});

test('uncertain application reminders remain quarantined across restart and receipt repair never sends again', async t => {
    const f = fixture(t); await f.save(); let attempts = 0;
    f.setSend(async () => { attempts++; throw new Error('timeout with secret response'); });
    await f.cycle();
    assert.equal(attempts, 1);
    const eventId = 'event:' + (await f.events())[0].id;
    assert.deepEqual(readStatus(f.statePath).needsReview.map(row => row.id), [eventId]);
    assert.doesNotMatch(JSON.stringify(readStatus(f.statePath)), /secret response/);
    f.reopen(); await f.save({ notes: 'Still waiting' }); await f.cycle(); assert.equal(attempts, 1);
    f.acknowledge(eventId, 123); await f.cycle();
    assert.equal(attempts, 1);
    assert.equal(f.state.status()[0].status, 'done');
});

test('a crash during application reminder dispatch is quarantined, and a saved receipt finishes without resend', async t => {
    const f = fixture(t); await f.save(); await f.bridge.importInto(f.state);
    const [delivery] = f.state.ready(f.now());
    f.state.preparing(delivery.id, []); f.reopen(); await f.cycle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.status()[0].status, 'uncertain');
    f.acknowledge(delivery.id, 456);
    f.reopen(); await f.cycle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.status()[0].status, 'done');
});

test('queued reminders recheck schedule, label and completion immediately before sending', async t => {
    const f = fixture(t); await f.save(); await f.bridge.importInto(f.state);
    const original = (await f.events())[0];
    await f.deadline({ dueAt: new Date(f.now() + 3 * 60 * 60000).toISOString(), reminderMinutes: [60] });
    await f.cycle();
    assert.equal(f.requests.length, 0);
    assert.equal(await f.reminders.isReminderCurrent(original.data.reference), false);
    f.advance(2 * 60 * 60000); await f.bridge.importInto(f.state);
    await f.deadline({ label: '<Updated deadline>' }); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].text, /&lt;Updated deadline&gt;/);
    await f.deadline({ dueAt: new Date(f.now() + 30 * 60000).toISOString() }); await f.bridge.importInto(f.state);
    await f.deadline({ completed: true }); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.status().find(row => row.status === 'cancelled').count, 2);
});

test('submission stops application due reminders while deposit and follow-up deadlines continue without broker outreach', async t => {
    const f = fixture(t); await f.save(); await f.bridge.importInto(f.state);
    await f.save({ stage: 'submitted' }); await f.cycle();
    assert.equal(f.requests.length, 0);
    await f.save({ deadlines: [
        { id: 'deposit', type: 'deposit', label: 'Deposit', dueAt: new Date(f.now() + 30 * 60000).toISOString(), completed: false, reminderMinutes: [60] },
        { id: 'reply', type: 'follow_up', label: 'Follow up with broker', dueAt: new Date(f.now() + 30 * 60000).toISOString(), completed: false, reminderMinutes: [60] }
    ] });
    await f.cycle();
    assert.equal(f.requests.length, 2);
    assert.match(f.requests.find(request => /Follow up with broker/.test(request.text)).text, /Review the conversation before contacting the broker/);
    // The only transport supplied to the worker is Telegram; no email operation is requested.
    assert.equal(f.state.status().find(row => row.status === 'done').count, 2);
});

test('closed applications, passed or deleted listings and removed deadlines cancel queued reminders', async t => {
    for (const mutation of ['rejected', 'withdrawn', 'lease_signed', 'passed', 'deleted', 'removed']) {
        await t.test(mutation, async subtest => {
            const f = fixture(subtest); await f.save(); await f.bridge.importInto(f.state);
            if (mutation === 'passed') f.listings.get('apartment').status = 'passed';
            else if (mutation === 'deleted') f.listings.delete('apartment');
            else if (mutation === 'removed') await f.save({ deadlines: [] });
            else await f.save({ stage: mutation });
            await f.cycle();
            assert.equal(f.requests.length, 0);
            assert.equal(f.state.status()[0].status, 'cancelled');
        });
    }
});

test('downtime collapses earlier intervals into one current reminder and one overdue notice expires after 24 hours', async t => {
    const f = fixture(t); await f.save();
    await f.deadline({ dueAt: new Date(f.now() + 15 * 60000).toISOString(), reminderMinutes: [10080, 1440, 60, 30] });
    await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.equal((await f.events())[0].data.reference.minutesBefore, 30);
    f.advance(15 * 60000); await f.cycle();
    assert.equal(f.requests.length, 2);
    assert.match(f.requests[1].text, /deadline overdue/);
    f.reopen(); f.advance(60 * 60000); await f.cycle(); assert.equal(f.requests.length, 2);
    f.advance(OVERDUE_WINDOW); await f.cycle(); assert.equal(f.requests.length, 2);
    const overdue = (await f.events()).find(row => row.data.reference.phase === 'overdue');
    assert.equal(await f.reminders.isReminderCurrent(overdue.data.reference), false);
});

test('late upcoming messages are cancelled when overdue, old deadlines stay quiet, and empty intervals disable all notices', async t => {
    const f = fixture(t); await f.save(); await f.bridge.importInto(f.state);
    f.advance(60 * 60000); await f.cycle();
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].text, /deadline overdue/);
    assert.equal(f.state.status().find(row => row.status === 'cancelled').count, 1);
    await f.save({ deadlines: [
        { id: 'old', type: 'other', label: 'Old task', dueAt: new Date(f.now() - OVERDUE_WINDOW).toISOString(), completed: false, reminderMinutes: [60] },
        { id: 'disabled', type: 'other', label: 'Disabled task', dueAt: new Date(f.now() - 60000).toISOString(), completed: false, reminderMinutes: [] }
    ] });
    await f.cycle(); assert.equal(f.requests.length, 1);
    assert.equal((await f.events()).length, 2);
});

test('rate-limit retry rechecks the current deadline and disabled reminders are cancelled', async t => {
    const f = fixture(t); await f.save(); let attempts = 0;
    f.setSend(async () => { attempts++; throw Object.assign(new Error('rate limit'), { errorCode: 429, retryAfter: 60 }); });
    await f.cycle(); assert.equal(attempts, 1);
    f.reopen(); await f.deadline({ reminderMinutes: [] }); f.advance(60000); await f.cycle();
    assert.equal(attempts, 1);
    assert.equal(f.state.status()[0].status, 'cancelled');
});

test('correcting a completion, closed stage or passed status rearms an unsent cancelled reminder with its original identity', async t => {
    for (const reason of ['completion', 'closed_stage', 'passed']) await t.test(reason, async subtest => {
        const f = fixture(subtest); await f.save(); await f.bridge.importInto(f.state);
        const id = (await f.events())[0].id;
        if (reason === 'completion') await f.deadline({ completed: true });
        else if (reason === 'closed_stage') await f.save({ stage: 'withdrawn' });
        else f.listings.get('apartment').status = 'passed';
        await f.cycle();
        assert.equal(f.requests.length, 0);
        assert.deepEqual(f.state.cancelledApplicationEvents(), ['event:' + id]);
        f.reopen();
        if (reason === 'completion') await f.deadline({ completed: false });
        else if (reason === 'closed_stage') await f.save({ stage: 'preparing' });
        else f.listings.get('apartment').status = 'inbox';
        await f.cycle();
        assert.equal(f.requests.length, 1);
        assert.equal((await f.events()).length, 1);
        assert.equal((await f.events())[0].id, id);
        assert.equal(f.state.status()[0].status, 'done');
        f.reopen(); await f.cycle(); assert.equal(f.requests.length, 1);
    });
});

test('completion corrections never rearm delivered, uncertain or failed application reminders', async t => {
    for (const outcome of ['done', 'uncertain', 'failed']) await t.test(outcome, async subtest => {
        const f = fixture(subtest); await f.save(); let attempts = 0;
        f.setSend(async payload => {
            attempts++;
            if (outcome === 'uncertain') throw new Error('ambiguous transport outcome');
            if (outcome === 'failed') throw Object.assign(new Error('known Telegram rejection'), { errorCode: 400 });
            f.requests.push(payload); return { message_id: 100 };
        });
        await f.cycle();
        const id = 'event:' + (await f.events())[0].id;
        assert.equal(f.state.status()[0].status, outcome);
        assert.equal(f.state.rearmApplicationEvent(id), false);
        await f.deadline({ completed: true }); await f.cycle();
        f.reopen(); await f.deadline({ completed: false }); await f.cycle();
        assert.equal(attempts, 1);
        assert.equal(f.state.status()[0].status, outcome);
        assert.deepEqual(f.state.cancelledApplicationEvents(), []);
    });
});

test('journal rearm guards exclude sent receipts, cancelled rows with receipts and other event kinds', async t => {
    const f = fixture(t); await f.save(); await f.bridge.importInto(f.state);
    const id = 'event:' + (await f.events())[0].id;
    f.state.sent(id, 123);
    assert.equal(f.state.rearmApplicationEvent(id), false);
    f.state.finish(id, 'cancelled');
    assert.equal(f.state.rearmApplicationEvent(id), false);
    assert.deepEqual(f.state.cancelledApplicationEvents(), []);
    f.state.enqueueEvents([{ id: 'other', kind: 'tour_reminder', reference: {}, payload: {}, created_at: f.now() }]);
    f.state.finish('event:other', 'cancelled');
    assert.equal(f.state.rearmApplicationEvent('event:other'), false);
    assert.deepEqual(f.state.cancelledApplicationEvents(), []);
});

test('reminder formatting bounds untrusted text and missing bridge support waits without losing queued work', async t => {
    const f = fixture(t); await f.save(); f.listings.get('apartment').title = '<&>'.repeat(10000);
    await f.deadline({ label: '<&>'.repeat(40) }); await f.bridge.importInto(f.state);
    const [event] = await f.events();
    const prepared = await f.reminders.prepare(event.data.reference);
    assert.ok(prepared.payload.text.length < 4096);
    assert.doesNotMatch(prepared.payload.text, /<&>/);
    await notificationCycle({ state: f.state, repository: f.repository, api: { sendMessage() { throw new Error('Unsupported event must wait'); } },
        chatId: 'fixture-chat', now: f.now, wait: async () => {} });
    assert.equal(f.state.ready(f.now())[0].status, 'pending');
    const unsupported = createProductEventBridge({ store: f.store, repository: f.repository });
    assert.equal((await unsupported.prepare({ kind: 'application_reminder', reference: event.data.reference })).status, 'wait');
});
