const { createHash } = require('node:crypto');
const { createHttpsClient } = require('./https_client');
const { parseRoute, FIELD_MASK } = require('./google_commute');

const ROUTE_COLLECTION = 'tour_route_cache';
const ROUTE_TTL_MS = 15 * 60000;
const messages = {
    address_needed: 'Use a street address and borough or city for every stop.',
    invalid_time: 'Choose a departure time with an explicit time zone offset.',
    invalid_mode: 'Select walking or transit.', unconfigured: 'Google Maps routing is not configured.',
    configuration_error: 'Google Maps routing is paused until its configuration is corrected.',
    allowance_exhausted: 'The shared Google Maps request allowance is exhausted.',
    rate_limited: 'Google Maps routing is temporarily paused after a rate limit.',
    unavailable: 'No route estimate is available.', ambiguous_address: 'Confirm this address; Google could not resolve it precisely.',
    busy: 'This route estimate is already being refreshed.', timeout: 'The route estimate timed out.',
    cancelled: 'Route planning was cancelled.', service_error: 'Route estimates are temporarily unavailable.'
};
class TourRouteError extends Error {
    constructor(code, status = 503) { super(messages[code] || messages.service_error); this.code = code; this.status = status; }
}
function usableAddress(value) {
    const address = typeof value === 'string' ? value.trim() : '';
    return address.length >= 8 && address.length <= 240 && /^\d+[A-Z]?(?:[-/]\d+)?\s+/i.test(address) &&
        /\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|place|pl|court|ct|terrace|way|broadway)\b/i.test(address) &&
        /\b(?:Manhattan|Brooklyn|Queens|Bronx|Staten Island|Jersey City|Hoboken|New York|NYC)\b/i.test(address) &&
        !/[\r\n<>]|https?:|\b(?:near|between|corner)\b/i.test(address) ? address : null;
}
function routeUrl(origin, destination, mode) {
    return 'https://www.google.com/maps/dir/?' + new URLSearchParams({ api: '1', origin, destination,
        travelmode: mode === 'WALK' ? 'walking' : 'transit' }).toString();
}
function createTourRouteService({ store, allowance, client = createHttpsClient({ timeoutMs: 15000 }), env = process.env, now = Date.now } = {}) {
    if (!store || !allowance) throw new Error('Tour routes require durable cache and shared allowance');
    let localBlock = null, localPause = 0;
    const config = () => env.GOOGLE_MAPS_API_KEY?.trim() ? createHash('sha256')
        .update(env.GOOGLE_MAPS_API_KEY + '|' + (env.GOOGLE_MAPS_CONFIG_VERSION || '')).digest('hex') : null;
    async function status() {
        const fingerprint = config();
        const state = await allowance.status(fingerprint);
        if (fingerprint && localBlock === fingerprint) return { ...state, available: false, code: 'configuration_error' };
        if (localPause > now()) return { ...state, available: false, code: 'rate_limited' };
        return state;
    }
    async function lookup({ origin, destination, departureAt, mode = 'TRANSIT', signal }) {
        origin = usableAddress(origin); destination = usableAddress(destination);
        if (!origin || !destination) throw new TourRouteError('address_needed', 422);
        if (!['WALK', 'TRANSIT'].includes(mode)) throw new TourRouteError('invalid_mode', 422);
        if (typeof departureAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(departureAt) || !Number.isFinite(Date.parse(departureAt))) {
            throw new TourRouteError('invalid_time', 422);
        }
        departureAt = new Date(departureAt).toISOString();
        const key = createHash('sha256').update(JSON.stringify([origin.toLowerCase(), destination.toLowerCase(), departureAt, mode])).digest('hex');
        const existing = await store.get(ROUTE_COLLECTION, key);
        if (existing?.data.expiresAt > now()) {
            if (existing.data.error) throw new TourRouteError(existing.data.error.code, existing.data.error.status);
            return { ...existing.data.result, fromCache: true };
        }
        if (existing?.data.leaseUntil > now()) throw new TourRouteError('busy', 409);
        let lease, attempted = false;
        try { lease = await store.put(ROUTE_COLLECTION, key, { leaseUntil: now() + 30000 }, { expectedRevision: existing?.revision || 0 }); }
        catch (error) { if (error.status === 409 || error.statusCode === 409) throw new TourRouteError('busy', 409); throw error; }
        try {
            if (signal?.aborted) throw new TourRouteError('cancelled', 499);
            const state = await status();
            if (!state.available) throw new TourRouteError(state.code, ['allowance_exhausted', 'rate_limited'].includes(state.code) ? 429 : 503);
            const fingerprint = config();
            if (!await allowance.reserve(fingerprint)) throw new TourRouteError('allowance_exhausted', 429);
            attempted = true;
            if (signal?.aborted) throw new TourRouteError('cancelled', 499);
            let response;
            try {
                response = await client.request('https://routes.googleapis.com/directions/v2:computeRoutes', {
                    method: 'POST', service: 'Google Tour Routes', signal,
                    headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': FIELD_MASK },
                    json: { origin: { address: origin }, destination: { address: destination }, travelMode: mode,
                        ...(mode === 'TRANSIT' ? { departureTime: departureAt } : {}),
                        computeAlternativeRoutes: false, languageCode: 'en-US', units: 'IMPERIAL' }
                });
            } catch (error) {
                if ([400, 401, 403].includes(error.status)) {
                    localBlock = fingerprint; await allowance.disable(fingerprint);
                    throw new TourRouteError('configuration_error');
                }
                if (error.status === 429) {
                    const pause = Math.max(300000, error.retryAfterMs || 0);
                    localPause = now() + pause; await allowance.pause(pause);
                    throw new TourRouteError('rate_limited', 429);
                }
                throw new TourRouteError(signal?.aborted ? 'cancelled' : error.code === 'request deadline exceeded or cancelled' ? 'timeout' : 'service_error');
            }
            if (signal?.aborted) throw new TourRouteError('cancelled', 499);
            let route;
            try { route = parseRoute(response.data); }
            catch (error) { throw new TourRouteError(error.code === 'ambiguous_address' ? 'ambiguous_address' : 'unavailable', 422); }
            const result = { route, durationMinutes: Math.ceil(route.durationSeconds / 60), origin, destination, departureAt, mode,
                retrievedAt: new Date(now()).toISOString(), attribution: 'Google Maps', routeUrl: routeUrl(origin, destination, mode) };
            await store.put(ROUTE_COLLECTION, key, { result, expiresAt: now() + ROUTE_TTL_MS, leaseUntil: 0 }, { expectedRevision: lease.revision });
            return { ...result, fromCache: false };
        } catch (error) {
            const safe = error instanceof TourRouteError ? error : new TourRouteError('service_error');
            safe.attempted = attempted;
            // Cache failures briefly as well, so refreshing the page cannot replay a failed paid call.
            try { await store.put(ROUTE_COLLECTION, key, { error: { code: safe.code, status: safe.status }, expiresAt: now() + 60000, leaseUntil: 0 }, { expectedRevision: lease.revision }); } catch {}
            throw safe;
        }
    }
    return { lookup, status, close: () => client.close?.() };
}
module.exports = { createTourRouteService, TourRouteError, usableAddress, routeUrl, ROUTE_COLLECTION, ROUTE_TTL_MS };
