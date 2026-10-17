const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTourPlanner, explicitTime } = require('../src/tour_planner');
const { installTourPlannerApi } = require('../src/tour_planner_api');
function memoryStore() {
    const records = new Map(), events = new Map();
    return { records, events, async get(c, id) { return structuredClone(records.get(c + ':' + id) || null); },
        async list(c) { return [...records.entries()].filter(([key]) => key.startsWith(c + ':')).map(([, value]) => structuredClone(value)); },
        async put(c, id, data, { expectedRevision }) {
            const old = records.get(c + ':' + id); if ((old?.revision || 0) !== expectedRevision) throw Object.assign(new Error('Conflict'), { status: 409 });
            const row = { id, data: structuredClone(data), revision: expectedRevision + 1, updated_at: new Date().toISOString() };
            records.set(c + ':' + id, row); return structuredClone(row);
        }, async enqueueEvent(event) { if (!events.has(event.id)) events.set(event.id, structuredClone(event)); }
    };
}
const fixtures = () => [{ id: 'a', listing_address: '20 West 34th Street, Manhattan, NY', proposed_datetime: '2026-10-20T14:00:00-04:00', status: 'proposed' },
    { id: 'b', listing_address: '100 West 42nd Street, Manhattan, NY', proposed_datetime: '2026-10-20T15:00:00-04:00', status: 'confirmed' }];
function setup(tours = fixtures(), extra = {}) {
    const store = memoryStore(); let clock = Date.parse('2026-10-20T12:00:00-04:00');
    const repository = { async listTours() { return { rows: tours }; }, async getTour(id) { return { rows: tours.filter(t => t.id === id) }; },
        async getListing(id) { return { rows: id === 'listing-a' ? [{ id }] : [] }; } };
    const service = createTourPlanner({ store, repository, now: () => clock, ...extra });
    return { store, repository, service, setTime: at => { clock = Date.parse(at); } };
}
test('explicit New York times reject ambiguity, invalid dates, and DST gaps; both repeated offsets work', () => {
    assert.equal(explicitTime('2026-11-01T01:30:00-04:00'), '2026-11-01T05:30:00.000Z');
    assert.equal(explicitTime('2026-11-01T01:30:00-05:00'), '2026-11-01T06:30:00.000Z');
    assert.equal(explicitTime('2026-03-08T07:30:00Z'), '2026-03-08T07:30:00.000Z');
    for (const invalid of ['2026-11-01T01:30:00', '2026-03-08T02:30:00-05:00', '2026-02-30T10:00:00Z', '2026-10-20T14:00:00-05:00']) assert.throws(() => explicitTime(invalid));
});
test('schedule detects insufficient buffers and overlap; cancellation removes conflicts without changing legacy rows', async () => {
    const tours = fixtures(), { service } = setup(tours);
    let schedule = await service.listSchedule();
    assert.equal(schedule.conflicts[0].kind, 'insufficient_buffer');
    assert.equal(schedule.conflicts[0].gapMinutes, 15);
    await service.updateSchedule('a', { expectedRevision: 0, startsAt: '2026-10-20T14:30:00-04:00' });
    schedule = await service.listSchedule(); assert.equal(schedule.conflicts[0].kind, 'overlap');
    await service.updateSchedule('a', { expectedRevision: 1, status: 'cancelled' });
    assert.equal((await service.listSchedule()).conflicts.length, 0); assert.equal(tours[0].status, 'proposed');
    await assert.rejects(service.updateSchedule('a', { expectedRevision: 1, status: 'confirmed' }), { status: 409 });
});
test('uncertain email time requires explicit selection; links validate listing and conversation ownership', async () => {
    const { service, store } = setup([{ ...fixtures()[0], proposed_datetime: 'Tomorrow afternoon' }]);
    assert.equal((await service.getSchedule('a')).requiresTimeSelection, true);
    await assert.rejects(service.updateSchedule('a', { expectedRevision: 0, status: 'confirmed' }), /specific time/);
    await assert.rejects(service.updateSchedule('a', { expectedRevision: 0, listingId: 'missing' }), /does not exist/);
    await store.put('conversation_messages', 'msg', { listingId: 'listing-a' }, { expectedRevision: 0 });
    await assert.rejects(service.updateSchedule('a', { expectedRevision: 0, conversationId: 'msg' }), /another listing/);
    const updated = await service.updateSchedule('a', { expectedRevision: 0, conversationId: 'msg', listingId: 'listing-a',
        startsAt: '2026-10-20T14:00:00-04:00', status: 'confirmed' });
    assert.equal(updated.listingId, 'listing-a'); assert.match(updated.brokerMessagePreview, /confirm/);
});
test('durable reminders deduplicate on repeated scans and restart; rescheduling and cancellation invalidate queued events', async () => {
    const context = setup(); const { service, store, repository, setTime } = context;
    await service.updateSchedule('a', { expectedRevision: 0, status: 'confirmed', reminderMinutes: [1440, 60] });
    setTime('2026-10-20T13:15:00-04:00');
    await service.queueDueReminders(); await service.queueDueReminders();
    const reminder = [...store.events.values()].find(e => e.reference.tourId === 'a');
    assert.equal([...store.events.values()].filter(e => e.reference.tourId === 'a').length, 1);
    assert.equal(reminder.reference.minutesBefore, 60); assert.equal(await service.isReminderCurrent(reminder.reference), true);
    const restarted = createTourPlanner({ store, repository, now: () => Date.parse('2026-10-20T13:15:00-04:00') });
    await restarted.queueDueReminders(); assert.equal(store.events.size, 2);
    await service.updateSchedule('a', { expectedRevision: 1, startsAt: '2026-10-20T16:00:00-04:00' });
    assert.equal(await service.isReminderCurrent(reminder.reference), false);
    await service.queueDueReminders();
    const revised = [...store.events.values()].find(e => e.reference.tourId === 'a' && e.reference.revision === 2);
    assert.ok(revised);
    await service.updateSchedule('a', { expectedRevision: 2, status: 'cancelled' });
    assert.equal(await service.isReminderCurrent(revised.reference), false);
});
test('past tours never queue reminders and unknown time is not exported as an invented calendar date', async () => {
    const { service, store, setTime } = setup([{ ...fixtures()[0], status: 'confirmed' }, { ...fixtures()[1], proposed_datetime: null }]);
    setTime('2026-10-21T12:00:00-04:00'); await service.queueDueReminders(); assert.equal(store.events.size, 0);
    await assert.rejects(service.calendar('b'), /specific time/);
    const ics = await service.calendar('a'); assert.match(ics, /DTSTART:20261020T180000Z/); assert.match(ics, /SEQUENCE:0/);
    assert.match(ics, /America\/New_York/); assert.match(ics, /STATUS:CONFIRMED/);
    await service.updateSchedule('a', { expectedRevision: 0, status: 'cancelled' });
    assert.match(await service.calendar('a'), /SEQUENCE:1/); assert.match(await service.calendar('a'), /STATUS:CANCELLED/);
});
test('a more urgent reminder suppresses old queued reminders and reminder intervals cannot be zero', async () => {
    const { service, store, setTime } = setup();
    await service.updateSchedule('a', { expectedRevision: 0, status: 'confirmed' });
    await service.queueDueReminders();
    const old = [...store.events.values()].find(event => event.reference.tourId === 'a');
    assert.equal(old.reference.minutesBefore, 1440);
    setTime('2026-10-20T13:30:00-04:00');
    assert.equal(await service.isReminderCurrent(old.reference), false);
    await assert.rejects(service.updateSchedule('a', { expectedRevision: 1, reminderMinutes: [0] }), /from 1 to 10080/);
});
test('fixed tour itinerary includes all duration and buffers; late arrival is incompatible and never marked feasible', async () => {
    const requests = [];
    const { service } = setup(fixtures(), { routeService: { async lookup(args) { requests.push(args); return { durationMinutes: 20, route: {}, fromCache: false }; } } });
    const plan = await service.planItinerary({ tourIds: ['b', 'a'], startAddress: '620 8th Avenue, Manhattan, NY',
        departureAt: '2026-10-20T13:00:00-04:00', mode: 'WALK', arrivalBufferMinutes: 10 });
    assert.equal(plan.stops[0].id, 'a'); assert.equal(plan.legs[0].status, 'feasible');
    assert.equal(plan.legs[1].departureAt, '2026-10-20T18:55:00.000Z');
    assert.equal(plan.legs[1].slackMinutes, -30); assert.equal(plan.status, 'incompatible');
    assert.equal(plan.requestCount, 2); assert.match(plan.label, /not a guaranteed optimal/); assert.equal(requests.length, 2);
});
test('unknown routes and incomplete stops stay unresolved; passive reads make no provider calls', async () => {
    let calls = 0;
    const { service } = setup(fixtures(), { routeService: { async lookup() { calls++; throw Object.assign(new Error('private'), { code: 'unavailable' }); } } });
    await service.listSchedule(); await service.getSchedule('a'); assert.equal(calls, 0);
    const plan = await service.planItinerary({ tourIds: ['a', 'b'], startAddress: '620 8th Avenue, Manhattan, NY', departureAt: '2026-10-20T13:00:00-04:00' });
    assert.equal(plan.status, 'unresolved'); assert.equal(plan.legs[0].durationMinutes, null);
    assert.equal(plan.legs[1].reason, 'previous_route_unresolved'); assert.equal(calls, 1);
    await assert.rejects(service.planItinerary({ tourIds: ['a'] }), /two to six/);
    await assert.rejects(service.planItinerary({ tourIds: ['a', 'b'], startAddress: '620 8th Avenue, Manhattan, NY', departureAt: '2026-10-19T13:00:00-04:00' }), /upcoming departure/);
});
test('scheduling APIs require the owner guard before reading, editing, exporting or paid planning', () => {
    const routes = [], guard = () => {}, app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (...args) => routes.push({ method, args })]));
    installTourPlannerApi(app, { service: {}, requireOwner: guard });
    assert.equal(routes.length, 5); assert.ok(routes.every(route => route.args[1] === guard));
    assert.throws(() => installTourPlannerApi(app, { service: {} }), /owner authorization/);
});
