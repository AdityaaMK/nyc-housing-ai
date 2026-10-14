const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
process.env.MAIL_BACKEND = 'gmail-api';
process.env.DB_BACKEND = 'sqlite';
process.env.GMAIL_USER = 'tenant@example.test';
const tours = new Map();
let failSave = false;
require.cache[require.resolve('../src/repository')] = { exports: { repository: {
    async saveTour(tour) { if (failSave) throw new Error('save failed'); if (!tours.has(tour.id)) tours.set(tour.id, tour); }
} } };
const { checkInboundReplies } = require('../src/inbound_listener');
const analysis = { is_tour_invitation: true, proposed_datetime: '2026-10-20T17:30:00-04:00',
    listing_address: '1 Main St #2', broker_name: 'Broker', human_readable_time: 'Tuesday, 5:30 PM', summary: 'Tour invitation' };
test('stable Gmail IDs survive repeated polling; save/notification/read failures preserve unread mail and tour identity', async () => {
    let unread = true, closed = 0, alertAttempts = 0, readAttempts = 0;
    let failNotification = true, failRead = false;
    const identity = 'tenant@example.test:gmail:stable-id';
    const connect = async () => ({
        identity: () => identity,
        listUnread: async since => { assert.ok(Math.abs(Date.now() - since.getTime() - 2 * 86400000) < 1000); return unread ? ['stable-id'] : []; },
        getMessage: async id => ({ id, subject: 'Apartment tour', from: 'Broker <broker@example.test>', fromAddress: 'broker@example.test', body: 'Tour Tuesday', receivedAt: '2026-10-12T16:00:00Z' }),
        markRead: async () => { readAttempts++; if (failRead) throw new Error('read-label failure'); unread = false; },
        close: async () => { closed++; }
    });
    const api = { sendMessage: async () => { alertAttempts++; if (failNotification) throw new Error('notification failed'); } };
    const deps = { connect, analyze: async () => analysis };
    failSave = true;
    await assert.rejects(checkInboundReplies(api, 'fixture', deps), /save failed/);
    assert.equal(alertAttempts, 0); assert.equal(readAttempts, 0); assert.equal(tours.size, 0);
    failSave = false;
    await assert.rejects(checkInboundReplies(api, 'fixture', deps), /notification failed/);
    assert.equal(tours.size, 1); assert.equal(unread, true); assert.equal(readAttempts, 0);
    failNotification = false; failRead = true;
    await assert.rejects(checkInboundReplies(api, 'fixture', deps), /read-label failure/);
    assert.equal(unread, true); assert.equal(tours.size, 1);
    failRead = false;
    await checkInboundReplies(api, 'fixture', deps);
    assert.equal(unread, false); assert.equal(tours.size, 1);
    const id = createHash('md5').update(identity).digest('hex').slice(0, 12);
    assert.equal(tours.get(id).broker_email, 'broker@example.test');
    await checkInboundReplies(api, 'fixture', deps);
    assert.equal(alertAttempts, 3); assert.equal(readAttempts, 2); assert.equal(closed, 5);
});
test('existing IMAP tour IDs are retained when polling that transport', async () => {
    delete process.env.MAIL_BACKEND;
    process.env.GMAIL_APP_PASSWORD = 'fixture';
    const identity = 'tenant@example.test:123:42';
    const existingId = createHash('md5').update(identity).digest('hex').slice(0, 12);
    tours.set(existingId, { id: existingId, status: 'confirmed', proposed_time: 'original' });
    await checkInboundReplies({ sendMessage: async () => {} }, 'fixture', {
        connect: async () => ({ identity: () => identity, listUnread: async () => [42],
            getMessage: async () => ({ subject: 'Apartment tour', from: 'Broker <broker@example.test>', body: 'Tour invitation' }), markRead: async () => {}, close: async () => {} }),
        analyze: async () => analysis
    });
    assert.deepEqual(tours.get(existingId), { id: existingId, status: 'confirmed', proposed_time: 'original' });
});
