const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openInboxState, readInboxStatus, createInboxBridge } = require('../src/inbox_state');
const { inboxCycle, runInboxWorker } = require('../src/inbox_worker');
const { openState, readStatus } = require('../src/telegram_state');
const { notificationCycle } = require('../src/telegram_worker');
const { tourProposal } = require('../src/inbox_messages');

const analysis = { is_tour_invitation: true, proposed_datetime: '2026-10-20T17:30:00-04:00',
    listing_address: '1 Main St #2', broker_name: 'Broker', human_readable_time: 'Tuesday, 5:30 PM', summary: 'Tour invitation' };
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-worker-test-'));
    const file = path.join(dir, 'inbox.sqlite'), telegramFile = path.join(dir, 'telegram.sqlite');
    let state = openInboxState(file, 'fixture'), telegram = openState(telegramFile, 'fixture');
    let time = Date.parse('2026-10-16T12:00:00Z'), analyses = 0, reads = 0;
    const messages = new Map(), tours = new Map(), inquiries = [], sent = [], scans = [];
    const repository = {
        inboxInquiries: async () => ({ rows: inquiries }),
        saveTour: async tour => { if (!tours.has(tour.id)) tours.set(tour.id, tour); },
        getTour: async id => ({ rows: tours.has(id) ? [tours.get(id)] : [] }),
        getListing: async id => ({ rows: inquiries.filter(row => row.id === id) }),
        pendingNotifications: async () => ({ rows: [] }),
        markNudgeNotified: async id => { inquiries.find(row => row.id === id).nudge_notified = true; },
        markNotified: async () => assert.fail('Inbox events must not change listing notification flags')
    };
    const connection = { user: 'tenant@example.test', identity: id => 'tenant:gmail:' + id,
        listMessages: async since => { scans.push(since.getTime()); return [...messages.keys()]; },
        getMessage: async id => { reads++; return messages.get(id); },
        markRead: async () => assert.fail('Must preserve mailbox read flags'), close: async () => {} };
    const bridge = createInboxBridge(file, 'fixture', () => time);
    const api = { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } };
    t.after(() => { state.close(); telegram.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, file, telegramFile, messages, tours, inquiries, sent, scans, repository, connection, bridge, api,
        get state() { return state; }, get telegram() { return telegram; }, get analyses() { return analyses; }, get reads() { return reads; },
        now: () => time, advance: ms => { time += ms; },
        reopen() { state.close(); state = openInboxState(file, 'fixture'); telegram.close(); telegram = openState(telegramFile, 'fixture'); },
        healthy() { state.set('heartbeat', { at: time, lastCheckAt: time, status: 'running' }); },
        message(id = 'one', data = {}) { messages.set(id, { subject: 'Apartment tour', from: 'Broker <broker@example.test>',
            fromAddress: 'broker@example.test', body: 'Tour Tuesday', receivedAt: new Date(time - 3600000).toISOString(), ...data }); },
        inquiry(id = 'listing', data = {}) { const row = { id, title: '1 Main St', status: 'applied', broker_email: 'broker@example.test',
            applied_at: new Date(time - 2 * 86400000).toISOString(), nudge_notified: false, nudge_count: 0, ...data }; inquiries.push(row); return row; },
        cycle: (options = {}) => inboxCycle({ state, repository, connect: async () => connection,
            analyze: async () => { analyses++; return analysis; }, now: () => time, ...options }),
        deliver: () => notificationCycle({ state: telegram, repository, api, chatId: '123', inboxBridge: bridge, now: () => time, wait: async () => {} })
    };
}

test('tour is saved and queued while Telegram is stopped; repeated scans and restart do not reparse or resend', async t => {
    const f = fixture(t); f.message(); await f.cycle();
    assert.equal(f.sent.length, 0); assert.equal(f.tours.size, 1); assert.equal(f.state.events().length, 1);
    f.reopen(); await f.cycle(); assert.equal(f.analyses, 1); assert.equal(f.reads, 1);
    await f.deliver(); f.reopen(); await f.deliver();
    assert.equal(f.sent.length, 1); assert.equal(f.state.events().length, 0);
    assert.match(f.sent[0].text, /TOUR INVITATION/);
    assert.equal([...f.tours.values()][0].broker_email, 'broker@example.test');
});

test('database failure preserves parsed proposal; restart retries save without repeating AI or dropping on 404', async t => {
    const f = fixture(t); f.message(); const save = f.repository.saveTour;
    f.repository.saveTour = async () => { throw Object.assign(new Error('table unavailable'), { status: 404 }); };
    await f.cycle(); assert.equal(f.state.events().length, 0); assert.equal(f.state.unfinished(), 1);
    f.reopen(); f.advance(60000); f.repository.saveTour = save; await f.cycle();
    assert.equal(f.analyses, 1); assert.equal(f.tours.size, 1); assert.equal(f.state.events().length, 1);
});

test('interrupted cross-journal handoff imports once even if source acknowledgement was lost', async t => {
    const f = fixture(t); f.message(); await f.cycle();
    f.telegram.enqueueEvents(f.state.events()); // Crash before inbox.forwarded().
    f.reopen(); await f.deliver(); await f.deliver();
    assert.equal(f.sent.length, 1); assert.equal(readInboxStatus(f.file).alerts.transferred, 1);
});

test('429 and unknown tour send outcomes use the persistent Telegram recovery policy', async t => {
    const f = fixture(t); f.message(); await f.cycle(); const send = f.api.sendMessage;
    f.api.sendMessage = async () => { throw Object.assign(new Error(), { errorCode: 429, retryAfter: 120 }); };
    await f.deliver(); f.reopen(); f.api.sendMessage = send;
    f.advance(119999); await f.deliver(); assert.equal(f.sent.length, 0);
    f.advance(1); await f.deliver(); assert.equal(f.sent.length, 1);
    f.message('two'); await f.cycle();
    f.api.sendMessage = async () => { throw new Error('unknown dispatch outcome'); };
    await f.deliver(); f.reopen(); f.api.sendMessage = send; await f.deliver();
    assert.equal(f.sent.length, 1); assert.equal(readStatus(f.telegramFile).needsReview.length, 1);
});

test('nudge receipt survives database acknowledgement failure without another send', async t => {
    const f = fixture(t); const listing = f.inquiry(); await f.cycle(); f.healthy();
    const mark = f.repository.markNudgeNotified;
    f.repository.markNudgeNotified = async () => { throw new Error('database down'); };
    await assert.rejects(f.deliver()); assert.equal(f.sent.length, 1); assert.equal(listing.nudge_notified, false);
    f.reopen(); f.repository.markNudgeNotified = mark; await f.deliver();
    assert.equal(f.sent.length, 1); assert.equal(listing.nudge_notified, true);
});

test('known broker reply without tour keywords suppresses follow-up; no broker mail is sent', async t => {
    const f = fixture(t); f.inquiry();
    f.message('reply', { subject: 'Re: Hello', body: 'Sorry, already rented.' });
    await f.cycle({ analyze: async () => ({ is_tour_invitation: false }) });
    assert.equal(f.state.events().length, 0); assert.equal(f.tours.size, 0);
    assert.equal(f.state.repliedSince('broker@example.test', f.now() - 86400000), true);
});

test('nudges wait for a fresh inbox check and cancel after a later reply or listing status change', async t => {
    const f = fixture(t); f.inquiry(); await f.cycle();
    await f.deliver(); assert.equal(f.sent.length, 0); // No current heartbeat.
    f.healthy(); f.advance(45001); await f.deliver(); assert.equal(f.sent.length, 0);
    f.message('reply'); await f.cycle({ analyze: async () => ({ is_tour_invitation: false }) }); f.healthy();
    await f.deliver(); assert.equal(f.sent.length, 0);
    assert.equal(f.telegram.status()[0].status, 'cancelled');
    const changed = f.inquiry('other', { broker_email: 'other@example.test' }); await f.cycle(); f.healthy(); changed.status = 'passed';
    await f.deliver(); assert.equal(f.sent.length, 0);
});

test('more than five unanswered inquiries queue once without starving later listings', async t => {
    const f = fixture(t);
    for (let i = 0; i < 12; i++) f.inquiry('listing-' + i);
    f.inquiry('too-recent', { applied_at: new Date(f.now()).toISOString() });
    f.inquiry('before-coverage', { applied_at: new Date(f.now() - 20 * 86400000).toISOString() });
    await f.cycle(); f.reopen(); await f.cycle(); assert.equal(f.state.events().length, 12);
    f.healthy(); for (let i = 0; i < 4; i++) await f.deliver();
    assert.equal(f.sent.length, 12); assert.equal(f.inquiries.filter(row => row.nudge_notified).length, 12);
});

test('message failures do not block other tours and defer nudges until replies are processed', async t => {
    const f = fixture(t); f.inquiry('no-reply', { broker_email: 'elsewhere@example.test' });
    f.message('broken', { body: 'broken' }); f.message('good');
    await f.cycle({ analyze: async (subject, from, body) => body === 'broken' ? null : analysis });
    assert.equal(f.state.unfinished(), 1);
    assert.equal(f.state.events().filter(event => event.kind === 'tour').length, 1);
    f.inquiry('new'); f.reopen(); await f.cycle();
    assert.equal(f.state.events().filter(event => event.kind === 'nudge').length, 0);
});

test('outage catch-up uses last scan and persisted IDs retry beyond the scan window', async t => {
    const f = fixture(t); f.message();
    await f.cycle({ analyze: async () => null }); const first = f.now();
    f.reopen(); f.advance(10 * 86400000); f.connection.listMessages = async since => { f.scans.push(since.getTime()); return []; };
    await f.cycle();
    assert.equal(f.scans[1], first - 86400000); assert.equal(f.tours.size, 1);
});

test('failed first scan retains its original catch-up boundary across a long outage', async t => {
    const f = fixture(t); const started = f.now();
    f.connection.listMessages = async () => { throw new Error('mailbox unavailable'); };
    await assert.rejects(f.cycle()); f.reopen(); f.advance(10 * 86400000);
    f.connection.listMessages = async since => { assert.equal(since.getTime(), started - 7 * 86400000); return []; };
    await f.cycle();
});

test('tour alerts queued while Telegram was stopped cancel once confirmed or in the past', async t => {
    const f = fixture(t); f.message(); f.message('other'); await f.cycle();
    const [confirmed, expired] = [...f.tours.values()];
    confirmed.status = 'confirmed'; expired.proposed_datetime = new Date(f.now() - 60000).toISOString();
    await f.deliver(); assert.equal(f.sent.length, 0);
    assert.deepEqual(f.telegram.status().map(row => ({ ...row })), [{ status: 'cancelled', count: 2 }]);
});

test('existing Telegram journal upgrades retain delivery receipts and polling checkpoints', t => {
    const { DatabaseSync } = require('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-upgrade-'));
    const file = path.join(dir, 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO meta VALUES ('identity','"fixture"'),('offset','42');
        CREATE TABLE deliveries (id TEXT PRIMARY KEY,listing_ids TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,message_id INTEGER,error TEXT,created_at INTEGER NOT NULL);
        INSERT INTO deliveries VALUES ('old','["listing"]','sent',1,0,123,NULL,100);`);
    old.close();
    const state = openState(file, 'fixture');
    t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    assert.equal(state.get('offset'), 42); const [delivery] = state.ready(100);
    assert.equal(delivery.kind, 'listing'); assert.equal(delivery.status, 'sent'); assert.equal(delivery.message_id, 123);
    state.enqueueEvents([{ id: 'new', kind: 'tour', reference: { tourId: 'tour' }, payload: { text: 'Tour' }, created_at: 100 }]);
    assert.equal(state.ready(100).length, 2);
});

test('marketing stays unread and ignored across restarts; vanished messages do not stay pending', async t => {
    const f = fixture(t); f.message('newsletter', { from: 'no-reply@marketing.test' });
    await f.cycle(); f.reopen(); await f.cycle(); assert.equal(f.reads, 1); assert.equal(f.analyses, 0);
    f.message('deleted'); f.connection.getMessage = async () => { throw Object.assign(new Error(), { status: 404 }); };
    await f.cycle(); assert.equal(f.state.unfinished(), 0); assert.equal(f.tours.size, 0);
});

test('worker retries mailbox outages, persists retry deadlines, and reports successful checks', async t => {
    const f = fixture(t); const controller = new AbortController(); let attempts = 0;
    await runInboxWorker({ state: f.state, repository: f.repository, now: f.now, signal: controller.signal,
        connect: async () => { if (++attempts === 1) throw new Error('network unavailable'); return f.connection; },
        analyze: async () => analysis, log: () => {},
        wait: async ms => { if (attempts === 1) { assert.ok(f.state.get('retry_at') > f.now()); f.advance(ms); } else controller.abort(); } });
    assert.equal(attempts, 2); assert.equal(f.state.get('heartbeat').error, null);
    assert.equal(f.state.get('heartbeat').status, 'stopping'); assert.ok(f.state.get('last_check_at'));
});

test('singleton lock, identity binding and concurrent outbox consumer protect the same journal', t => {
    const f = fixture(t);
    assert.throws(() => openInboxState(f.file, 'fixture'), /locked/);
    assert.throws(() => openInboxState(f.file, 'different', { worker: false }), /different mailbox/);
    const consumer = openInboxState(f.file, 'fixture', { worker: false }); consumer.close();
    f.reopen(); assert.equal(f.state.get('identity'), 'fixture');
});

test('tour message bounds, HTML escaping and ambiguous times are safe for Telegram', () => {
    const enormous = '&'.repeat(10000);
    const proposal = tourProposal('id', { sender: 'actual@example.test', subject: 'Tour' }, {
        ...analysis, broker_email: 'invented@example.test', proposed_datetime: '2026-10-20T17:30:00',
        listing_address: enormous, broker_name: enormous, special_instructions: enormous, summary: enormous, human_readable_time: enormous });
    assert.ok(proposal.payload.text.length < 4096); assert.match(proposal.payload.text, /&amp;/);
    assert.equal(proposal.tour.proposed_datetime, null); assert.equal(proposal.tour.broker_email, 'actual@example.test');
    assert.equal(proposal.payload.reply_markup.inline_keyboard.length, 1);
});
