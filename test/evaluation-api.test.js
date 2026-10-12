const { test } = require('node:test');
const assert = require('node:assert/strict');
const rows = ['pending', 'processing', 'completed', 'retry_wait', 'failed'].map((state, i) => ({
    id: String(i), title: 'Fixture', status: 'inbox', evaluation_status: state,
    evaluation_attempts: i === 4 ? 3 : 1, suitability_score: state === 'completed' ? 0 : null,
    evaluation_claim_token: 'private-token', evaluation_claim_expires_at: 'private-expiry',
    evaluation_last_error: i === 4 ? 'private provider error with credentials' : null,
    evaluation_next_at: state === 'retry_wait' ? '2026-10-12T20:01:00Z' : null,
    evaluation_completed_at: state === 'completed' ? '2026-10-12T20:00:00Z' : null
}));
require.cache[require.resolve('../src/db')] = { exports: { initDB() {}, pool: { async query(sql) {
    return { rows: sql.includes('tour_schedules') ? [{ count: 0 }] : rows };
} } } };
require.cache[require.resolve('../src/inbound_listener')] = { exports: { confirmTourBooking() {}, generateGoogleCalendarUrl() {} } };
const app = require('../src/server');
async function get(route) {
    let body;
    await app.router.stack.find(l => l.route?.path === route).route.stack[0].handle({}, {
        json(value) { body = value; }, status() { throw new Error('API failure'); }
    });
    return body;
}
test('listing responses expose progress and zero scores, exclude lease secrets and sanitize errors', async () => {
    const data = await get('/api/listings');
    assert.equal(data[2].suitability_score, 0);
    for (const l of data) {
        assert.equal(l.evaluation_claim_token, undefined); assert.equal(l.evaluation_claim_expires_at, undefined);
        assert.equal(typeof l.evaluation_attempts, 'number');
    }
    assert.ok(data[2].evaluation_completed_at); assert.ok(data[3].evaluation_next_at);
    assert.equal(data[4].evaluation_last_error, 'Evaluation temporarily unavailable.');
    assert.ok(!JSON.stringify(data).includes('private-'));
});
test('stats include all five evaluation states', async () => {
    const data = await get('/api/stats');
    assert.deepEqual(data.evaluation, { pending: 1, processing: 1, completed: 1, retry_wait: 1, failed: 1 });
    assert.equal(data.total, 5);
});
