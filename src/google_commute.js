const { createHash } = require('node:crypto');
const { createHttpsClient } = require('./https_client');
const { nextWeekdayArrival, TIME_ZONE } = require('./commute_time');
const DESTINATION = '620 8th Avenue, New York, NY 10018';
const FIELD_MASK = ['routes.duration', 'routes.distanceMeters', 'routes.legs.steps.travelMode',
    'routes.legs.steps.staticDuration', 'routes.legs.steps.distanceMeters',
    'routes.legs.steps.navigationInstruction.instructions', 'routes.legs.steps.transitDetails',
    'geocodingResults.origin', 'geocodingResults.destination'].join(',');
const messages = {
    unconfigured: 'Google commute is not configured.',
    configuration_error: 'Google commute is disabled until its configuration is corrected.',
    allowance_exhausted: 'Google commute request allowance exhausted.',
    rate_limited: 'Google commute is temporarily paused after a rate limit.',
    address_needed: 'Address needed: add a usable street address and borough/city.',
    ambiguous_address: 'Google could not resolve this address precisely. Confirm the address in Google Maps.',
    unavailable: 'No Google Maps route is available for the requested arrival time.',
    timeout: 'Google commute timed out. No estimate was retrieved.',
    cancelled: 'Google commute request cancelled.',
    busy: 'A Google commute lookup is already running for this listing.',
    service_error: 'Google commute is temporarily unavailable. No estimate was retrieved.',
    not_found: 'Listing not found.'
};
class CommuteError extends Error {
    constructor(code, status = 503) { super(messages[code] || messages.service_error); this.code = code; this.status = status; }
}
// Use only explicit borough/city evidence. Never derive a city from a neighborhood.
function commuteOrigin(listing) {
    const areas = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'Jersey City', 'Hoboken', 'New York'];
    const normalize = value => String(value || '').trim().toLowerCase();
    const area = areas.find(a => [listing.location_area, listing.city, listing.borough].some(v => normalize(v) === normalize(a)));
    const title = String(listing.street_address || listing.title || '').split('\n')[0].trim();
    const address = title.split(',')[0].replace(/\s*(?:#|\bAPT\.?\s|\bUNIT\s|\bSUITE\s).*$/i, '').trim();
    if (!area || address.length > 160 || !/^\d+[A-Z]?(?:[-/]\d+)?\s+/i.test(address) ||
        !/\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|place|pl|court|ct|terrace|way|broadway)\b(?:\s+(?:north|south|east|west))?\.?$/i.test(address) ||
        /[&@;<>]|\b(?:near|between|at|corner|and|or)\b/i.test(address)) return null;
    return `${address}, ${area}, ${['Jersey City', 'Hoboken'].includes(area) ? 'NJ' : 'NY'}`;
}
const duration = value => typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value) ? Number(value.slice(0, -1)) : null;
const text = value => typeof value === 'string' ? value : null;
function parseRoute(data) {
    for (const geo of [data?.geocodingResults?.origin, data?.geocodingResults?.destination]) {
        if (geo?.partialMatch || (geo?.geocoderStatus?.code && geo.geocoderStatus.code !== 0) ||
            (geo?.type?.length && !geo.type.some(t => ['street_address', 'premise', 'subpremise', 'establishment'].includes(t)))) {
            throw new CommuteError('ambiguous_address', 422);
        }
    }
    const route = data?.routes?.[0];
    const seconds = duration(route?.duration);
    if (!seconds || !Array.isArray(route?.legs) || !route.legs.length) throw new CommuteError('unavailable', 404);
    const steps = route.legs.flatMap(leg => leg.steps || []).map(step => {
        if (!['WALK', 'TRANSIT'].includes(step.travelMode)) throw new CommuteError('unavailable', 404);
        const result = { mode: step.travelMode, durationSeconds: duration(step.staticDuration),
            distanceMeters: Number.isFinite(step.distanceMeters) ? step.distanceMeters : null,
            instruction: text(step.navigationInstruction?.instructions) };
        if (step.travelMode === 'TRANSIT') {
            const t = step.transitDetails;
            if (!t?.transitLine || !t.stopDetails?.departureStop?.name || !t.stopDetails?.arrivalStop?.name) throw new CommuteError('unavailable', 404);
            result.transit = { line: text(t.transitLine.nameShort) || text(t.transitLine.name),
                vehicle: text(t.transitLine.vehicle?.type), headsign: text(t.headsign),
                departureStop: t.stopDetails.departureStop.name, arrivalStop: t.stopDetails.arrivalStop.name,
                departureTime: text(t.stopDetails.departureTime), arrivalTime: text(t.stopDetails.arrivalTime),
                stopCount: Number.isInteger(t.stopCount) ? t.stopCount : null,
                agencies: (t.transitLine.agencies || []).map(a => ({ name: text(a.name), uri: text(a.uri) })) };
        }
        return result;
    });
    if (!steps.length) throw new CommuteError('unavailable', 404);
    const transitCount = steps.filter(s => s.mode === 'TRANSIT').length;
    const walks = steps.filter(s => s.mode === 'WALK');
    return { durationSeconds: seconds, distanceMeters: route.distanceMeters ?? null, steps,
        walkingSeconds: walks.some(s => s.durationSeconds === null) ? null : walks.reduce((sum, s) => sum + s.durationSeconds, 0),
        transfers: Math.max(0, transitCount - 1), walkingOnly: transitCount === 0 };
}
function createCommuteService({ allowance, client = createHttpsClient({ timeoutMs: 15000 }), env = process.env, now = Date.now, destination = () => DESTINATION } = {}) {
    const inFlight = new Set();
    let localBlock = null, localPause = 0;
    const config = () => env.GOOGLE_MAPS_API_KEY?.trim() ? createHash('sha256')
        .update(env.GOOGLE_MAPS_API_KEY + '|' + (env.GOOGLE_MAPS_CONFIG_VERSION || '')).digest('hex') : null;
    async function status() {
        const fingerprint = config();
        const state = await allowance.status(fingerprint);
        // Also fail closed in this process if persisting a provider pause failed.
        if (fingerprint && localBlock === fingerprint) return { ...state, available: false, code: 'configuration_error' };
        if (localPause > now()) return { ...state, available: false, code: 'rate_limited', retryAt: new Date(localPause).toISOString() };
        return state;
    }
    async function lookup(listing, { signal } = {}) {
        const origin = commuteOrigin(listing);
        if (!origin) throw new CommuteError('address_needed', 422);
        if (inFlight.has(listing.id)) throw new CommuteError('busy', 409);
        inFlight.add(listing.id);
        try {
            if (signal?.aborted) throw new CommuteError('cancelled', 499);
            const state = await status();
            if (!state.available) throw new CommuteError(state.code, state.code === 'allowance_exhausted' || state.code === 'rate_limited' ? 429 : 503);
            const fingerprint = config();
            const destinationAddress = destination();
            if (typeof destinationAddress !== 'string' || !destinationAddress.trim() || destinationAddress.length > 300) throw new CommuteError('configuration_error');
            const arrivalTime = nextWeekdayArrival(now());
            if (!await allowance.reserve(fingerprint)) {
                const current = await status();
                throw new CommuteError(current.code === 'ready' ? 'service_error' : current.code, 429);
            }
            // Every reservation is consumed, including cancellations and provider failures.
            if (signal?.aborted) throw new CommuteError('cancelled', 499);
            let response;
            try {
                response = await client.request('https://routes.googleapis.com/directions/v2:computeRoutes', {
                    method: 'POST', service: 'Google Routes', signal,
                    headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': FIELD_MASK },
                    json: { origin: { address: origin }, destination: { address: destinationAddress }, travelMode: 'TRANSIT',
                        arrivalTime, computeAlternativeRoutes: false, languageCode: 'en-US', units: 'IMPERIAL' }
                });
            } catch (error) {
                if ([400, 401, 403].includes(error.status)) {
                    localBlock = fingerprint;
                    await allowance.disable(fingerprint);
                    throw new CommuteError('configuration_error');
                }
                if (error.status === 429) {
                    const pause = Math.max(300000, error.retryAfterMs || 0);
                    localPause = now() + pause;
                    await allowance.pause(pause);
                    throw new CommuteError('rate_limited', 429);
                }
                throw new CommuteError(signal?.aborted ? 'cancelled' : error.code === 'request deadline exceeded or cancelled' ? 'timeout' : 'service_error', signal?.aborted ? 499 : 503);
            }
            if (signal?.aborted) throw new CommuteError('cancelled', 499);
            return { route: parseRoute(response.data), origin, destination: destinationAddress,
                requestedArrivalTime: arrivalTime, timeZone: TIME_ZONE, retrievedAt: new Date(now()).toISOString(),
                attribution: 'Google Maps' };
        } catch (error) {
            if (error instanceof CommuteError) throw error;
            throw new CommuteError('service_error');
        } finally { inFlight.delete(listing.id); }
    }
    return { status, lookup, close: () => client.close?.() };
}
module.exports = { createCommuteService, commuteOrigin, parseRoute, CommuteError, messages, DESTINATION, FIELD_MASK };
