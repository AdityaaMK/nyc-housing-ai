const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTourRouteService, usableAddress } = require('../src/tour_routes');
function storeFixture() {
    const map = new Map();
    return { async get(c, id) { return map.get(c + id) || null; }, async put(c, id, data, { expectedRevision }) {
        const row = map.get(c + id); if ((row?.revision || 0) !== expectedRevision) throw Object.assign(new Error('Conflict'), { status: 409 });
        const result = { data, id, revision: expectedRevision + 1 }; map.set(c + id, result); return result;
    } };
}
const request = { origin: '620 8th Avenue, Manhattan, NY', destination: '20 West 34th Street, Manhattan, NY', departureAt: '2026-10-20T17:00:00Z', mode: 'TRANSIT' };
const response = { data: { routes: [{ duration: '1250s', distanceMeters: 1000, legs: [{ steps: [{ travelMode: 'WALK', staticDuration: '1250s', distanceMeters: 1000 }] }] }] } };
function setup(extra = {}) {
    const store = storeFixture(); let attempts = 0, disabled = false, paused = false;
    const allowance = { async status(config) { return { available: !!config && !disabled && !paused, code: !config ? 'unconfigured' : disabled ? 'configuration_error' : paused ? 'rate_limited' : 'ready' }; },
        async reserve() { attempts++; return true; }, async disable() { disabled = true; }, async pause() { paused = true; } };
    const options = { store, allowance, env: { GOOGLE_MAPS_API_KEY: 'fixture-secret' }, now: () => Date.parse('2026-10-20T16:00:00Z'), ...extra };
    return { options, service: createTourRouteService(options), attempts: () => attempts };
}
test('arbitrary street addresses route on explicit request with capped allowance; cache persists across service restart', async () => {
    let calls = 0;
    const { service, options, attempts } = setup({ client: { async request(url, options) {
        calls++; assert.equal(url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
        assert.equal(options.json.origin.address, request.origin); assert.equal(options.json.destination.address, request.destination);
        assert.equal(options.json.departureTime, '2026-10-20T17:00:00.000Z');
        assert.equal(options.json.computeAlternativeRoutes, false); return response;
    } } });
    const result = await service.lookup(request); assert.equal(result.durationMinutes, 21); assert.equal(result.fromCache, false);
    assert.equal((await service.lookup(request)).fromCache, true);
    assert.equal((await createTourRouteService(options).lookup(request)).fromCache, true);
    assert.equal(calls, 1); assert.equal(attempts(), 1); assert.match(result.routeUrl, /^https:\/\/www.google.com\/maps\/dir/);
});
test('validation and unavailable allowance make no paid request; failures remain unknown and use a short durable cache', async () => {
    let calls = 0;
    const { service, attempts } = setup({ client: { async request() { calls++; return { data: { routes: [] } }; } } });
    for (const address of ['Brooklyn', 'https://example.test', '620 8th Avenue', '620 8th Avenue near Broadway, New York']) assert.equal(usableAddress(address), null);
    await assert.rejects(service.lookup({ ...request, destination: 'Brooklyn' }), { code: 'address_needed' });
    await assert.rejects(service.lookup({ ...request, mode: 'DRIVE' }), { code: 'invalid_mode' });
    assert.equal(attempts(), 0);
    await assert.rejects(service.lookup(request), { code: 'unavailable' });
    await assert.rejects(service.lookup(request), { code: 'unavailable' }); assert.equal(calls, 1); assert.equal(attempts(), 1);
    await assert.rejects(setup({ env: {}, client: { request() { assert.fail('No live call'); } } }).service.lookup(request), { code: 'unconfigured' });
});
test('shared 429/configuration pauses, no blind retries, and sanitized errors', async () => {
    for (const [status, code] of [[429, 'rate_limited'], [403, 'configuration_error'], [500, 'service_error']]) {
        let calls = 0;
        const { service, attempts } = setup({ client: { async request() { calls++; throw Object.assign(new Error('fixture-secret private address'), { status }); } } });
        await assert.rejects(service.lookup(request), error => error.code === code && !error.message.includes('secret'));
        await assert.rejects(service.lookup(request), { code }); assert.equal(calls, 1); assert.equal(attempts(), 1);
    }
});
test('persistent compare-and-swap lease prevents concurrent service instances from duplicating a lookup', async () => {
    let resolveCall, started; const ready = new Promise(resolve => { started = resolve; });
    const { service, options, attempts } = setup({ client: { async request() { started(); return new Promise(resolve => { resolveCall = resolve; }); } } });
    const first = service.lookup(request); await ready;
    await assert.rejects(createTourRouteService(options).lookup(request), { code: 'busy' });
    resolveCall(response); await first; assert.equal(attempts(), 1);
});
