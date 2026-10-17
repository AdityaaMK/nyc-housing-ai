const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createConversationService } = require('../src/conversations');
const { openInboxState, createInboxBridge } = require('../src/inbox_state');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-conversations-'));
    const file = path.join(directory, 'features.db');
    let database = new DatabaseSync(file);
    database.exec('CREATE TABLE feature_records(collection TEXT,id TEXT,data TEXT,revision INTEGER,updated_at TEXT,PRIMARY KEY(collection,id))');
    const adapter = { backend: 'sqlite', async query(sql, parameters = []) {
        const values = [];
        const query = sql.replace(/\$(\d+)/g, (_match, index) => { values.push(parameters[Number(index) - 1]); return '?'; });
        const rows = database.prepare(query).all(...values);
        return { rows, rowCount: rows.length };
    } };
    const now = () => Date.parse('2026-10-17T12:00:00Z');
    const store = require('../src/feature_store').createFeatureStore(adapter, now);
    const inquiries = ['A', 'B'].map(id => ({ id, status: 'applied', broker_email: 'broker@example.test', applied_at: '2026-10-15T12:00:00Z' }));
    const repository = { getListing: async id => ({ rows: inquiries.filter(row => row.id === id) }), inboxInquiries: async () => ({ rows: inquiries }) };
    let service = createConversationService({ store, repository, now });
    t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const outbound = async (id, options = {}, send = async headers => ({ messageId: headers.messageId, id: 'provider-' + id, threadId: 'thread-' + id })) =>
        service.sendOutgoing({ listingId: id, recipient: 'broker@example.test', sender: 'tenant@example.test', subject: 'Apartment ' + id,
            body: 'Please arrange a viewing.', ...options }, send);
    const inbound = async (id, options = {}) => service.recordInbound('tenant:provider:' + id, { id, subject: 'Re: apartment', body: 'Available tomorrow.',
        fromAddress: 'broker@example.test', receivedAt: '2026-10-16T16:00:00Z', ...options }, inquiries);
    return { directory, now, store, repository, inquiries, outbound, inbound,
        get service() { return service; },
        restart() { database.close(); database = new DatabaseSync(file); service = createConversationService({ store, repository, now }); } };
}

test('same broker handles two apartments: thread and RFC references suppress only the matching inquiry', async t => {
    const f = fixture(t);
    const a = await f.outbound('A'); await f.outbound('B');
    const reply = await f.inbound('reply-A', { threadId: 'thread-A' });
    assert.equal(reply.listingId, 'A'); assert.equal(reply.match, 'thread');
    assert.equal(await f.service.followUpStatus('A', 'broker@example.test', Date.parse(f.inquiries[0].applied_at)), 'cancel');
    assert.equal(await f.service.followUpStatus('B', 'broker@example.test', Date.parse(f.inquiries[1].applied_at)), 'ready');
    const reference = await f.inbound('reference-A', { inReplyTo: a.rfcMessageId.toUpperCase() });
    assert.equal(reference.listingId, 'A'); assert.equal(reference.match, 'references');
    const contradictory = await f.inbound('contradiction', { threadId: 'thread-B', references: [a.rfcMessageId] });
    assert.equal(contradictory.listingId, null); assert.equal(contradictory.match, 'ambiguous');
});

test('ambiguous replies stay visible and conservatively block nudges until manually assigned', async t => {
    const f = fixture(t); await f.outbound('A'); await f.outbound('B');
    const reply = await f.inbound('ambiguous');
    assert.equal(reply.listingId, null); assert.deepEqual(reply.candidateListingIds.sort(), ['A', 'B']);
    assert.equal((await f.service.unassigned()).messages.length, 1);
    assert.equal(await f.service.followUpStatus('B', 'broker@example.test', Date.parse(f.inquiries[1].applied_at)), 'cancel');
    const assigned = await f.service.assign(reply.id, { listingId: 'A', expectedRevision: reply.revision });
    assert.equal(assigned.match, 'manual');
    assert.equal(await f.service.followUpStatus('B', 'broker@example.test', Date.parse(f.inquiries[1].applied_at)), 'ready');
    await assert.rejects(f.service.assign(reply.id, { listingId: 'B', expectedRevision: reply.revision }), { status: 409 });
    assert.ok((await f.service.timeline('A')).messages.some(message => message.id === reply.id));
});

test('inbound identity and linked tour survive restarts and manual reassignment updates tour ownership', async t => {
    const f = fixture(t); await f.outbound('A');
    const reply = await f.inbound('tour', { threadId: 'thread-A' });
    await f.service.linkTour(reply.id, 'tour-1'); f.restart();
    const repeated = await f.inbound('tour', { body: 'Changed server representation' });
    assert.equal(repeated.tourId, 'tour-1'); assert.equal(repeated.summary, 'Available tomorrow.');
    await f.service.assign(reply.id, { listingId: 'B', expectedRevision: repeated.revision });
    assert.deepEqual((await f.store.get('tour_links', 'tour-1')).data, { listingId: 'B', conversationId: reply.id });
    assert.equal((await f.store.list('conversation_messages')).filter(row => row.data.direction === 'inbound').length, 1);
});

test('accepted outgoing mail has durable receipts: retries reconcile without a second send', async t => {
    const f = fixture(t); let sends = 0;
    const send = async headers => { sends++; return { id: 'provider-receipt', threadId: 'thread-A', messageId: headers.messageId }; };
    const first = await f.outbound('A', {}, send); f.restart();
    const repeated = await f.outbound('A', {}, send);
    assert.equal(sends, 1); assert.equal(repeated.alreadySent, true); assert.equal(repeated.providerMessageId, 'provider-receipt');
    assert.equal(repeated.rfcMessageId, first.rfcMessageId);
    assert.equal((await f.service.timeline('A')).messages[0].outcome, 'sent');
});

test('uncertain send and lost receipt writes prevent replay after process restart', async t => {
    const f = fixture(t); let sends = 0;
    const send = async () => { sends++; throw new Error('Connection closed after submission'); };
    await assert.rejects(f.outbound('A', {}, send), /uncertain/); f.restart();
    await assert.rejects(f.outbound('A', {}, send), /uncertain/); assert.equal(sends, 1);
    assert.equal((await f.service.timeline('A')).messages[0].outcome, 'uncertain');
    const put = f.store.put;
    f.store.put = async () => { throw new Error('receipt storage unavailable'); };
    await assert.rejects(f.outbound('B', {}, async () => { sends++; return { id: 'accepted' }; }), /storage unavailable/);
    f.store.put = put; f.restart();
    await assert.rejects(f.outbound('B'), /uncertain/);
    assert.equal(sends, 2);
});

test('concurrent clicks claim a single outbound dispatch', async t => {
    const f = fixture(t); let sends = 0;
    const send = async () => { sends++; return { id: 'one' }; };
    const results = await Promise.allSettled([f.outbound('A', {}, send), f.outbound('A', {}, send)]);
    assert.equal(sends, 1); assert.ok(results.some(result => result.status === 'fulfilled'));
});

test('inbox bridge respects exact listing replies and later manual assignment after journal restart', async t => {
    const f = fixture(t); await f.outbound('A'); await f.outbound('B'); await f.inbound('one', { threadId: 'thread-A' });
    const file = path.join(f.directory, 'inbox.db');
    let state = openInboxState(file, 'fixture');
    state.syncConversationReplies(await f.service.inboundReplies());
    state.set('heartbeat', { at: f.now(), lastCheckAt: f.now(), status: 'running' }); state.close();
    const bridge = createInboxBridge(file, 'fixture', f.now);
    const reference = listingId => ({ listingId, sender: 'broker@example.test', appliedAt: Date.parse(f.inquiries[0].applied_at) });
    assert.equal(bridge.nudgeStatus(reference('A')), 'cancel'); assert.equal(bridge.nudgeStatus(reference('B')), 'ready');
    const reply = await f.inbound('ambiguous');
    state = openInboxState(file, 'fixture'); state.syncConversationReplies(await f.service.inboundReplies()); state.close();
    assert.equal(bridge.nudgeStatus(reference('B')), 'cancel');
    await f.service.assign(reply.id, { listingId: 'A', expectedRevision: reply.revision });
    state = openInboxState(file, 'fixture'); state.syncConversationReplies(await f.service.inboundReplies()); state.close();
    assert.equal(bridge.nudgeStatus(reference('B')), 'ready');
});

test('conversation endpoints enforce owner checks and optimistic assignment revisions', async t => {
    const f = fixture(t); const reply = await f.inbound('unassigned');
    const app = require('express')(); app.use(require('express').json());
    require('../src/conversations_api').installConversationsApi(app, { service: f.service,
        requireOwner: (req, res, next) => req.headers.authorization === 'Bearer fixture' ? next() : res.status(401).json({ error: 'Unauthorized' }) });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url + '/api/conversations/unassigned')).status, 401);
    const assigned = await fetch(url + `/api/conversations/${reply.id}/assignment`, { method: 'PUT',
        headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId: 'A', expectedRevision: reply.revision }) });
    assert.equal(assigned.status, 200); assert.equal((await assigned.json()).listingId, 'A');
    const invalid = await fetch(url + `/api/conversations/${reply.id}/assignment`, { method: 'PUT',
        headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId: 'B' }) });
    assert.equal(invalid.status, 400);
});

test('real inbox cycle links the parsed tour and queues a follow-up only for the unanswered apartment', async t => {
    const f = fixture(t); await f.outbound('A'); await f.outbound('B');
    const file = path.join(f.directory, 'cycle.db'); let state = openInboxState(file, 'fixture');
    let analyses = 0; const tours = new Map();
    const repository = { ...f.repository, saveTour: async tour => { tours.set(tour.id, tour); } };
    const connection = { user: 'tenant@example.test', identity: id => 'fixture:' + id,
        listMessages: async () => ['reply'], close: async () => {}, getMessage: async () => ({ id: 'reply', threadId: 'thread-A',
            subject: 'Re: Apartment A', fromAddress: 'broker@example.test', body: 'Tour tomorrow', receivedAt: '2026-10-16T16:00:00Z' }) };
    const cycle = () => require('../src/inbox_worker').inboxCycle({ state, repository, conversations: f.service,
        connect: async () => connection, now: f.now, analyze: async () => { analyses++; return { is_tour_invitation: true,
            listing_address: '1 Main St', proposed_datetime: '2026-10-20T10:00:00-04:00' }; } });
    try {
        await cycle(); const events = state.events();
        assert.deepEqual(events.filter(event => event.kind === 'nudge').map(event => event.reference.listingId), ['B']);
        const tour = [...tours.values()][0]; const link = await f.store.get('tour_links', tour.id);
        assert.equal(link.data.listingId, 'A');
        state.close(); state = openInboxState(file, 'fixture'); f.restart(); await cycle();
        assert.equal(analyses, 1); assert.equal(tours.size, 1);
        assert.equal((await f.service.timeline('A')).messages.find(message => message.direction === 'inbound').tourId, tour.id);
    } finally { state.close(); }
});

test('Gmail adapter preserves provider thread IDs and RFC reply headers', async () => {
    const { createGmailClient, MODIFY_SCOPE } = require('../src/gmail_api');
    const raw = 'From: Broker <broker@example.test>\r\nSubject: Apartment A\r\nMessage-ID: <reply@example.test>\r\nIn-Reply-To: <inquiry@example.test>\r\nReferences: <older@example.test> <inquiry@example.test>\r\n\r\nAvailable tomorrow.';
    const gmail = createGmailClient({ env: { GMAIL_USER: 'tenant@example.test', GMAIL_CLIENT_ID: 'fixture',
        GMAIL_CLIENT_SECRET: 'fixture', GMAIL_REFRESH_TOKEN: 'fixture' }, client: { request: async url => ({ data:
            url.includes('oauth2') ? { access_token: 'fixture', expires_in: 3600, scope: MODIFY_SCOPE } :
            url.endsWith('/profile') ? { emailAddress: 'tenant@example.test' } : { raw: Buffer.from(raw).toString('base64url'), threadId: 'thread-A' }
        }) } });
    const message = await gmail.getMessage('message-A');
    assert.equal(message.threadId, 'thread-A'); assert.equal(message.rfcMessageId, '<reply@example.test>');
    assert.equal(message.inReplyTo, '<inquiry@example.test>'); assert.deepEqual(message.references, ['<older@example.test>', '<inquiry@example.test>']);
});

function tourFixture(f) {
    const tour = { id: 'showing', listing_address: 'Old address', proposed_time: 'Original time',
        proposed_datetime: '2026-10-20T14:00:00Z', status: 'proposed', broker_email: 'broker@example.test' };
    const repository = { ...f.repository, getTour: async id => ({ rows: id === tour.id ? [tour] : [] }),
        listTours: async () => ({ rows: [tour] }), confirmTour: async () => { tour.status = 'confirmed'; } };
    const planner = require('../src/tour_planner').createTourPlanner({ store: f.store, repository, now: f.now });
    return { tour, repository, planner };
}

test('explicit tour confirmation sends the rescheduled time once and retains the conversation identity', async t => {
    const f = fixture(t); const { tour, repository, planner } = tourFixture(f);
    const incoming = await f.inbound('showing', { references: ['<original@example.test>'] });
    const schedule = await planner.updateSchedule(tour.id, { expectedRevision: 0, listingId: 'A', conversationId: incoming.id,
        startsAt: '2026-10-21T15:00:00-04:00', address: 'New address', status: 'proposed' });
    const emails = [];
    const send = options => f.service.sendOutgoing({ ...options, recipient: options.to, sender: 'tenant@example.test' },
        async headers => { emails.push({ ...options, ...headers }); return { id: 'confirmation' }; });
    const confirm = require('../src/inbound_listener').confirmTourBooking;
    const result = await confirm(tour.id, { store: f.store, repository, planner, send, now: f.now, expectedRevision: schedule.revision });
    assert.equal(result.success, true); assert.equal(emails.length, 1);
    assert.match(emails[0].body, /October 21, 2026 at 3:00 PM/); assert.match(emails[0].body, /New address/);
    assert.doesNotMatch(emails[0].body, /Original time/); assert.equal(emails[0].listingId, 'A');
    assert.equal((await planner.getSchedule(tour.id)).status, 'confirmed');
    await confirm(tour.id, { store: f.store, repository, planner, send, now: f.now }); assert.equal(emails.length, 1);
});

test('changed or cancelled schedules cannot silently confirm; an in-flight reschedule preserves the newer revision', async t => {
    const f = fixture(t); const { tour, repository, planner } = tourFixture(f);
    const confirm = require('../src/inbound_listener').confirmTourBooking;
    const cancelled = await planner.updateSchedule(tour.id, { expectedRevision: 0, status: 'cancelled' });
    const noSend = async () => assert.fail('Inactive or stale schedules must not send');
    assert.equal((await confirm(tour.id, { store: f.store, repository, planner, send: noSend, now: f.now })).success, false);
    const active = await planner.updateSchedule(tour.id, { expectedRevision: cancelled.revision, status: 'proposed' });
    assert.equal((await confirm(tour.id, { store: f.store, repository, planner, send: noSend, now: f.now, expectedRevision: cancelled.revision })).success, false);
    const result = await confirm(tour.id, { store: f.store, repository, planner, now: f.now, send: async () => {
        await planner.updateSchedule(tour.id, { expectedRevision: active.revision, startsAt: '2026-10-22T15:00:00-04:00' });
        return { id: 'email-accepted' };
    } });
    assert.equal(result.success, false); assert.equal(result.emailSent, true);
    const latest = await planner.getSchedule(tour.id); assert.equal(latest.status, 'proposed'); assert.equal(latest.startsAt, '2026-10-22T19:00:00.000Z');
});
