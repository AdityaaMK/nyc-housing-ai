const { createHash } = require('node:crypto');
const { TIME_ZONE } = require('./commute_time');
const { routeUrl, usableAddress } = require('./tour_routes');
const COLLECTION = 'tour_schedule';
const ACTIVE = new Set(['proposed', 'confirmed']);
const minute = 60000;
class TourPlannerError extends Error {
    constructor(message, status = 422, code = 'invalid_schedule') { super(message); this.status = status; this.code = code; }
}
const localParts = at => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(p => [p.type, p.value]));
function explicitTime(value, { optional = false } = {}) {
    if (value == null && optional) return null;
    if (typeof value !== 'string') throw new TourPlannerError('Choose a date and time with an explicit time zone offset.');
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
    const at = Date.parse(value);
    if (!match || !Number.isFinite(at) || +match[2] < 1 || +match[2] > 12 || +match[3] < 1 ||
        +match[3] > new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate() || +match[4] > 23 || +match[5] > 59 || +(match[6] || 0) > 59) {
        throw new TourPlannerError('Choose a valid date and time with an explicit time zone offset.');
    }
    // A numeric offset represents a New York wall clock choice. Reject nonexistent
    // spring-forward times; fall-back times are unambiguous because the offset is explicit.
    if (match[7] !== 'Z') {
        const parts = localParts(at);
        if ([parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join('|') !==
            [match[1], match[2], match[3], match[4], match[5], match[6] || '00'].join('|')) {
            throw new TourPlannerError('The chosen time and offset do not match America/New_York; choose the applicable daylight-saving offset.');
        }
    }
    return new Date(at).toISOString();
}
function integer(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) throw new TourPlannerError(`${name} must be an integer from ${min} to ${max}.`);
    return value;
}
function boundedText(value, name, max, nullable = false) {
    if (nullable && (value === null || value === '')) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new TourPlannerError(`${name} is invalid.`);
    return value.trim();
}
function conflictsFor(tours) {
    const active = tours.filter(t => ACTIVE.has(t.status) && t.startsAt).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const conflicts = [];
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
        const earlier = active[i], later = active[j];
        const gapMinutes = (Date.parse(later.startsAt) - Date.parse(earlier.endsAt)) / minute;
        const requiredBufferMinutes = earlier.bufferAfterMinutes + later.bufferBeforeMinutes;
        if (gapMinutes < requiredBufferMinutes || gapMinutes < 0) conflicts.push({ tourIds: [earlier.id, later.id],
            kind: gapMinutes < 0 ? 'overlap' : 'insufficient_buffer', gapMinutes, requiredBufferMinutes });
    }
    return conflicts;
}
function brokerMessage(schedule) {
    if (!schedule.startsAt) return 'Please confirm a specific date and time for the showing.';
    const when = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, dateStyle: 'full', timeStyle: 'short' }).format(new Date(schedule.startsAt));
    if (schedule.status === 'cancelled') return `I need to cancel the showing at ${schedule.address} on ${when} (New York time). Thank you.`;
    return `I would like to ${schedule.status === 'confirmed' ? 'confirm' : 'schedule'} the showing at ${schedule.address} on ${when} (New York time). Please let me know if this works. Thank you.`;
}
function createTourPlanner({ store, repository, now = Date.now, routeService } = {}) {
    if (!store || !repository) throw new Error('Tour planner requires store and repository');
    async function baseSchedule(tour) {
        const [saved, link] = await Promise.all([store.get(COLLECTION, tour.id), store.get('tour_links', tour.id)]);
        let startsAt = null;
        try { startsAt = explicitTime(tour.proposed_datetime, { optional: true }); } catch {}
        const data = { listingId: link?.data.listingId || null, conversationId: link?.data.conversationId || null,
            address: tour.listing_address || 'Address needed', brokerEmail: tour.broker_email || null, startsAt,
            durationMinutes: 45, bufferBeforeMinutes: 15, bufferAfterMinutes: 10,
            status: ['confirmed', 'cancelled', 'completed'].includes(tour.status) ? tour.status : 'proposed', reminderMinutes: [1440, 60],
            ...(saved?.data || {}) };
        const schedule = { ...data, id: tour.id, revision: saved?.revision || 0, timeZone: TIME_ZONE,
            endsAt: data.startsAt ? new Date(Date.parse(data.startsAt) + data.durationMinutes * minute).toISOString() : null,
            requiresTimeSelection: !data.startsAt, updatedAt: saved?.updated_at || null };
        schedule.brokerMessagePreview = brokerMessage(schedule);
        return schedule;
    }
    async function listSchedule() {
        const tours = await Promise.all((await repository.listTours()).rows.map(baseSchedule));
        const conflicts = conflictsFor(tours);
        for (const tour of tours) tour.conflicts = conflicts.filter(c => c.tourIds.includes(tour.id)).map(c => ({ ...c, tourId: c.tourIds.find(id => id !== tour.id) }));
        tours.sort((a, b) => (Date.parse(a.startsAt) || Infinity) - (Date.parse(b.startsAt) || Infinity) || a.id.localeCompare(b.id));
        return { timeZone: TIME_ZONE, tours, conflicts };
    }
    async function getSchedule(id) {
        const tour = (await repository.getTour(id)).rows[0];
        if (!tour) throw new TourPlannerError('Tour not found.', 404, 'not_found');
        const schedule = await baseSchedule(tour);
        const others = await listSchedule();
        schedule.conflicts = others.tours.find(t => t.id === id)?.conflicts || [];
        return schedule;
    }
    async function updateSchedule(id, input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TourPlannerError('A schedule object is required.');
        const allowed = new Set(['expectedRevision', 'listingId', 'conversationId', 'address', 'startsAt', 'durationMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes', 'status', 'reminderMinutes']);
        if (Object.keys(input).some(key => !allowed.has(key))) throw new TourPlannerError('The schedule contains unsupported fields.');
        const expectedRevision = integer(input.expectedRevision, 'Revision', 0, Number.MAX_SAFE_INTEGER);
        const previous = await getSchedule(id);
        if (previous.revision !== expectedRevision) throw new TourPlannerError('The tour changed; reload before saving.', 409, 'revision_conflict');
        const data = Object.fromEntries([...allowed].filter(key => key !== 'expectedRevision').map(key => [key, input[key] === undefined ? previous[key] : input[key]]));
        data.startsAt = explicitTime(data.startsAt, { optional: true });
        data.address = boundedText(data.address, 'Address', 240);
        data.listingId = boundedText(data.listingId, 'Listing', 500, true);
        data.conversationId = boundedText(data.conversationId, 'Conversation', 200, true);
        integer(data.durationMinutes, 'Showing duration', 5, 240);
        integer(data.bufferBeforeMinutes, 'Preparation buffer', 0, 180);
        integer(data.bufferAfterMinutes, 'Travel buffer', 0, 180);
        if (!['proposed', 'confirmed', 'cancelled', 'completed'].includes(data.status)) throw new TourPlannerError('Unknown tour status.');
        if (['confirmed', 'completed'].includes(data.status) && !data.startsAt) throw new TourPlannerError('Choose a specific time before confirming or completing a tour.');
        if (!Array.isArray(data.reminderMinutes) || data.reminderMinutes.length > 4) throw new TourPlannerError('Choose up to four reminder intervals.');
        data.reminderMinutes.forEach(value => integer(value, 'Reminder minutes', 1, 10080));
        data.reminderMinutes = [...new Set(data.reminderMinutes)].sort((a, b) => b - a);
        if (data.listingId && !(await repository.getListing(data.listingId)).rows[0]) throw new TourPlannerError('The linked listing does not exist.');
        if (data.conversationId) {
            const conversation = await store.get('conversation_messages', data.conversationId);
            if (!conversation) throw new TourPlannerError('The linked conversation does not exist.');
            if (conversation.data.listingId && data.listingId !== conversation.data.listingId) throw new TourPlannerError('The conversation belongs to another listing.');
        }
        await store.put(COLLECTION, id, data, { expectedRevision });
        return getSchedule(id);
    }
    async function isReminderCurrent(reference) {
        if (!reference || !Number.isInteger(reference.minutesBefore)) return false;
        let schedule;
        try { schedule = await getSchedule(reference.tourId); } catch (error) { if (error.status === 404) return false; throw error; }
        const start = Date.parse(schedule.startsAt);
        const due = schedule.reminderMinutes.filter(minutesBefore => now() >= start - minutesBefore * minute);
        return schedule.status === 'confirmed' && schedule.revision === reference.revision && schedule.reminderMinutes.includes(reference.minutesBefore) &&
            reference.minutesBefore === Math.min(...due) && now() < start;
    }
    async function queueDueReminders() {
        const { tours } = await listSchedule();
        let queued = 0;
        for (const tour of tours) {
            const start = Date.parse(tour.startsAt);
            if (tour.status !== 'confirmed' || !start || start <= now()) continue;
            // If several intervals elapsed while offline, only the most urgent one remains useful.
            const due = tour.reminderMinutes.filter(minutesBefore => now() >= start - minutesBefore * minute);
            if (!due.length) continue;
            const minutesBefore = Math.min(...due);
            const id = 'tour-reminder:' + createHash('sha256').update(JSON.stringify([tour.id, tour.revision, minutesBefore])).digest('hex');
            await store.enqueueEvent({ id, kind: 'tour_reminder', reference: { tourId: tour.id, revision: tour.revision, minutesBefore },
                payload: { tourId: tour.id, listingId: tour.listingId, address: tour.address, startsAt: tour.startsAt,
                    durationMinutes: tour.durationMinutes, minutesBefore, timeZone: TIME_ZONE }, created_at: now() });
            queued++;
        }
        return { queued };
    }
    async function calendar(id) {
        const tour = await getSchedule(id);
        if (!tour.startsAt) throw new TourPlannerError('Choose a specific time before exporting a calendar event.');
        const escape = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
        const stamp = value => new Date(value).toISOString().replace(/[-:]|\.\d{3}/g, '');
        const fold = value => {
            const lines = []; let line = '';
            for (const char of value) { if (Buffer.byteLength(line + char, 'utf8') > 73) { lines.push(line); line = ' '; } line += char; }
            lines.push(line); return lines.join('\r\n');
        };
        return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NYC Housing AI//Tours//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
            `UID:${createHash('sha256').update(tour.id).digest('hex')}@nyc-housing-ai`, `SEQUENCE:${tour.revision}`, `DTSTAMP:${stamp(now())}`,
            `DTSTART:${stamp(tour.startsAt)}`, `DTEND:${stamp(tour.endsAt)}`, `SUMMARY:${escape('Apartment tour: ' + tour.address)}`,
            `LOCATION:${escape(tour.address)}`, `DESCRIPTION:${escape('New York time zone: America/New_York. ' + (tour.brokerEmail ? 'Broker: ' + tour.brokerEmail : ''))}`,
            `STATUS:${tour.status === 'cancelled' ? 'CANCELLED' : tour.status === 'proposed' ? 'TENTATIVE' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
    }
    async function planItinerary(input, { signal } = {}) {
        if (!input || !Array.isArray(input.tourIds) || input.tourIds.length < 2 || input.tourIds.length > 6 ||
            new Set(input.tourIds).size !== input.tourIds.length || input.tourIds.some(id => typeof id !== 'string' || id.length > 500)) {
            throw new TourPlannerError('Select two to six different tours.');
        }
        const startAddress = usableAddress(input.startAddress);
        if (!startAddress) throw new TourPlannerError('Enter a starting street address including borough or city.');
        const departureAt = explicitTime(input.departureAt);
        if (Date.parse(departureAt) < now() || Date.parse(departureAt) > now() + 90 * 86400000) {
            throw new TourPlannerError('Choose an upcoming departure within 90 days.');
        }
        const mode = input.mode || 'TRANSIT';
        if (!['WALK', 'TRANSIT'].includes(mode)) throw new TourPlannerError('Select walking or transit.');
        const arrivalBufferMinutes = integer(input.arrivalBufferMinutes ?? 10, 'Arrival buffer', 0, 120);
        const schedules = await Promise.all(input.tourIds.map(getSchedule));
        const stops = [], excluded = [];
        for (const tour of schedules) {
            const reason = !ACTIVE.has(tour.status) ? 'inactive_tour' : !tour.startsAt ? 'time_needed' : !usableAddress(tour.address) ? 'address_needed' : null;
            if (reason) excluded.push({ tourId: tour.id, address: tour.address, reason }); else stops.push(tour);
        }
        stops.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        const day = at => { const p = localParts(at); return `${p.year}-${p.month}-${p.day}`; };
        if (stops.some(t => day(t.startsAt) !== day(departureAt))) throw new TourPlannerError('Choose tours and a departure time on the same New York calendar day.');
        const legs = []; let origin = startAddress, depart = Date.parse(departureAt), requestCount = 0, unresolvedPrior = false;
        for (const tour of stops) {
            if (signal?.aborted) throw new TourPlannerError('Route planning was cancelled.', 499, 'cancelled');
            const arrivalBy = Date.parse(tour.startsAt) - Math.max(arrivalBufferMinutes, tour.bufferBeforeMinutes) * minute;
            const leg = { from: origin, to: tour.address, tourId: tour.id, departureAt: new Date(depart).toISOString(),
                arrivalBy: new Date(arrivalBy).toISOString(), durationMinutes: null, arrivalAt: null, latestDepartureAt: null, slackMinutes: null,
                route: null, routeUrl: routeUrl(origin, tour.address, mode), status: 'unresolved', reason: null };
            if (unresolvedPrior) leg.reason = 'previous_route_unresolved';
            else if (!routeService) leg.reason = 'unconfigured';
            else {
                try {
                    const result = await routeService.lookup({ origin, destination: tour.address, departureAt: leg.departureAt, mode, signal });
                    if (!Number.isFinite(result.durationMinutes) || result.durationMinutes <= 0) throw new Error('Unknown travel time');
                    if (!result.fromCache) requestCount++;
                    leg.durationMinutes = result.durationMinutes; leg.route = result.route; leg.retrievedAt = result.retrievedAt;
                    leg.fromCache = Boolean(result.fromCache); leg.attribution = result.attribution || 'Google Maps';
                    leg.arrivalAt = new Date(depart + result.durationMinutes * minute).toISOString();
                    leg.latestDepartureAt = new Date(arrivalBy - result.durationMinutes * minute).toISOString();
                    leg.slackMinutes = (arrivalBy - Date.parse(leg.arrivalAt)) / minute;
                    leg.status = leg.slackMinutes >= 0 ? 'feasible' : 'incompatible';
                    leg.reason = leg.slackMinutes < 0 ? 'insufficient_travel_time' : null;
                } catch (error) { if (error.attempted) requestCount++; leg.reason = error.code || 'service_error'; }
            }
            legs.push(leg);
            tour.arrivalAt = leg.arrivalAt; tour.leaveBy = leg.latestDepartureAt;
            unresolvedPrior ||= leg.status === 'unresolved';
            depart = Math.max(Date.parse(tour.endsAt), (Date.parse(leg.arrivalAt) || 0) + tour.durationMinutes * minute) + tour.bufferAfterMinutes * minute;
            origin = tour.address;
        }
        const status = legs.some(l => l.status === 'incompatible') ? 'incompatible' : excluded.length || legs.some(l => l.status === 'unresolved') ? 'unresolved' : 'feasible';
        return { status, label: 'Suggested order by fixed appointment time; not a guaranteed optimal route.', timeZone: TIME_ZONE,
            createdAt: new Date(now()).toISOString(), mode, startAddress, departureAt, arrivalBufferMinutes, stops, legs, excluded,
            requestCount, maximumRequests: 6, notice: 'Travel estimates can change. Open each route before departure; no broker messages were sent.' };
    }
    return { listSchedule, getSchedule, updateSchedule, queueDueReminders, isReminderCurrent, calendar, planItinerary };
}
module.exports = { createTourPlanner, TourPlannerError, explicitTime, conflictsFor, COLLECTION };
