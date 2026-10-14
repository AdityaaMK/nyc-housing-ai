const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installCommuteApi } = require('../src/commute_api');
const { CommuteError } = require('../src/google_commute');
function api(service, repository = { async getListing(id) { return { rows: id === 'missing' ? [] : [{ id, title: 'Saved address' }] }; } }) {
    const handlers = {};
    installCommuteApi({ get(path, fn) { handlers[path] = fn; }, post(path, fn) { handlers[path] = fn; } }, { service, repository });
    return async (path, req = new EventEmitter(), res = new EventEmitter()) => {
        req.params ||= { id: 'a' }; req.body ||= { origin: 'Client override', destination: 'Client override' };
        res.headers = {}; res.set = (k, v) => { res.headers[k] = v; };
        res.statusCode = 200; res.status = n => { res.statusCode = n; return res; };
        res.json = body => { res.body = body; res.writableEnded = true; };
        await handlers[path](req, res); return res;
    };
}
test('POST resolves saved listing server-side, ignores client origin, returns no-store', async () => {
    let calls = 0;
    const call = api({ async lookup(listing) { calls++; assert.equal(listing.title, 'Saved address'); return { attribution: 'Google Maps' }; } });
    const res = await call('/api/listings/:id/commute');
    assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'no-store'); assert.equal(calls, 1);
    assert.equal(res.body.attribution, 'Google Maps');
    const req = new EventEmitter(); req.params = { id: 'missing' };
    assert.equal((await call('/api/listings/:id/commute', req)).statusCode, 404); assert.equal(calls, 1);
});
test('status does not call routing, exposes only status and allowance', async () => {
    const res = await api({ status: async () => ({ configured: false, available: false, remaining: { daily: 300, rolling32Days: 9000 } }), lookup() { assert.fail(); } })('/api/commute/status');
    assert.equal(res.body.configured, false); assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('all route failures are sanitized and no failed result is returned as an estimate', async () => {
    for (const error of [new Error('secret key and provider response'), new CommuteError('timeout')]) {
        const res = await api({ async lookup() { throw error; } })('/api/listings/:id/commute');
        assert.equal(res.statusCode, 503); assert.ok(res.body.error); assert.equal(res.body.route, undefined);
        assert.ok(!JSON.stringify(res.body).includes('secret'));
    }
});
test('client disconnect cancels provider signal and removes request listeners', async () => {
    const req = new EventEmitter(), res = new EventEmitter();
    const result = await api({ async lookup(listing, { signal }) {
        res.emit('close'); assert.equal(signal.aborted, true); throw new CommuteError('cancelled', 499);
    } })('/api/listings/:id/commute', req, res);
    assert.equal(result.body, undefined); assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});
