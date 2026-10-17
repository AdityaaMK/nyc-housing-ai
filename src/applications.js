const { randomUUID } = require('node:crypto');
const { explicitTime } = require('./tour_planner');
const { calculateHousingCosts } = require('./housing_costs');

const COLLECTION = 'applications';
const STAGES = ['preparing', 'submitted', 'approved', 'rejected', 'lease_signed', 'withdrawn'];
const APPLICATION_FIELDS = ['stage', 'documents', 'deadlines', 'offer', 'notes'];
const OFFER_AMOUNTS = ['monthlyRent', 'leaseMonths', 'freeMonths', 'rentCredit', 'monthlyFees', 'oneTimeFees', 'refundableDeposit', 'upfrontRentMonths', 'upfrontRentCredit'];
const OFFER_FIELDS = [...OFFER_AMOUNTS, 'leaseStart', 'leaseEnd', 'source', 'notes', 'termsConfirmed'];
const DOCUMENT_SUGGESTIONS_NOTICE = 'This checklist contains suggestions, not verified application requirements. Confirm requirements with the broker. Store checklist status and notes only; document uploads are not supported.';
class ApplicationError extends Error {
    constructor(message, status = 400, code = 'invalid_application') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new ApplicationError(message, status, code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) {
        fail(`${label} must contain exactly these fields: ${allowed.join(', ')}.`);
    }
}
function text(value, label, max, required = false) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label} must be text of at most ${max} characters.`);
    const result = value.trim();
    if (required && !result) fail(`${label} is required.`);
    return result;
}
function flag(value, label) {
    if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
    return value;
}
function amount(value, label, { max = 10000000, positive = false, integer = false } = {}) {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || positive && value === 0 || integer && !Number.isInteger(value)) {
        fail(`${label} must be ${positive ? 'positive' : 'nonnegative'}${integer ? ' whole' : ''} number or null for unknown.`);
    }
    if (!integer && Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) fail(`${label} supports at most two decimal places.`);
    return value;
}
function dateOnly(value, label) {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must be a date in YYYY-MM-DD format or null.`);
    const parsed = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || +value.slice(0, 4) < 1900) fail(`${label} must be a valid date.`);
    return value;
}
function entries(value, label, fields, transform) {
    if (!Array.isArray(value) || value.length > 40) fail(`${label} must be a list of at most 40 entries.`);
    const seen = new Set();
    return value.map(entry => {
        keys(entry, fields, label + ' entry');
        const id = text(entry.id, label + ' ID', 80, true);
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || seen.has(id)) fail(`${label} IDs must be unique letters, numbers, underscores, or hyphens.`);
        seen.add(id);
        return { id, ...transform(entry) };
    });
}
function seedApplication() {
    return {
        stage: 'preparing',
        documents: [
            ['photo_id', 'Photo ID'], ['income', 'Proof of income'], ['employment', 'Employment verification'], ['references', 'References']
        ].map(([id, label]) => ({ id, label, required: false, status: 'missing', note: '' })),
        deadlines: [],
        offer: { ...Object.fromEntries(OFFER_AMOUNTS.map(key => [key, null])), leaseStart: null, leaseEnd: null, source: '', notes: '', termsConfirmed: false },
        notes: ''
    };
}
function calculateOffer(offer) {
    const evidence = offer.termsConfirmed ? 'confirmed' : 'assumed';
    const concessions = offer.freeMonths !== 0 || offer.rentCredit !== 0;
    return calculateHousingCosts({
        lease_months: offer.leaseMonths,
        rent: { gross_monthly: offer.monthlyRent, concessions_mentioned: concessions, free_months: offer.freeMonths, rent_credit: offer.rentCredit,
            upfront_rent_months: offer.upfrontRentMonths, upfront_rent_credit: offer.upfrontRentCredit, evidence, source: offer.source },
        items: [
            { id: 'monthly_fees', label: 'Monthly fees', category: 'fee', amount: offer.monthlyFees, cadence: 'monthly', refundable: false, due_before_move_in: true },
            { id: 'one_time_fees', label: 'One-time fees due before moving', category: 'fee', amount: offer.oneTimeFees, cadence: 'one_time', refundable: false, due_before_move_in: true },
            { id: 'deposit', label: 'Refundable deposit', category: 'deposit', amount: offer.refundableDeposit, cadence: 'one_time', refundable: true, due_before_move_in: true }
        ].map(item => ({ ...item, evidence, source: offer.source, annual_basis: null }))
    });
}
function validateApplication(input) {
    keys(input, APPLICATION_FIELDS, 'Application');
    if (!STAGES.includes(input.stage)) fail('Choose a supported application stage.');
    const documents = entries(input.documents, 'Documents', ['id', 'label', 'required', 'status', 'note'], entry => {
        if (!['missing', 'ready', 'submitted', 'not_needed'].includes(entry.status)) fail('Choose a supported document status.');
        return { label: text(entry.label, 'Document label', 120, true), required: flag(entry.required, 'Required'), status: entry.status, note: text(entry.note, 'Document note', 1000) };
    });
    const deadlines = entries(input.deadlines, 'Deadlines', ['id', 'type', 'label', 'dueAt', 'completed', 'reminderMinutes'], entry => {
        if (!['application', 'deposit', 'follow_up', 'lease', 'other'].includes(entry.type)) fail('Choose a supported deadline type.');
        let dueAt;
        try { dueAt = explicitTime(entry.dueAt); }
        catch (error) { fail(error.message); }
        if (!Array.isArray(entry.reminderMinutes) || entry.reminderMinutes.length > 4 || entry.reminderMinutes.some(minutes => !Number.isInteger(minutes) || minutes < 1 || minutes > 10080)) {
            fail('Choose up to four reminder intervals, each from 1 to 10080 minutes.');
        }
        return { type: entry.type, label: text(entry.label, 'Deadline label', 120, true), dueAt, completed: flag(entry.completed, 'Completed'),
            reminderMinutes: [...new Set(entry.reminderMinutes)].sort((a, b) => b - a) };
    });
    keys(input.offer, OFFER_FIELDS, 'Offer');
    const offer = Object.fromEntries(OFFER_AMOUNTS.map(key => [key, amount(input.offer[key], key,
        ['leaseMonths', 'freeMonths', 'upfrontRentMonths'].includes(key) ? { max: 120, positive: key === 'leaseMonths', integer: key === 'leaseMonths' } : { positive: key === 'monthlyRent' })]));
    if (offer.monthlyRent !== null && offer.monthlyRent < 1) fail('Monthly rent must be at least $1 or null for unknown.');
    offer.leaseStart = dateOnly(input.offer.leaseStart, 'Lease start');
    offer.leaseEnd = dateOnly(input.offer.leaseEnd, 'Lease end');
    if (offer.leaseStart && offer.leaseEnd && offer.leaseEnd <= offer.leaseStart) fail('Lease end must be after lease start.');
    offer.source = text(input.offer.source, 'Offer source', 500);
    offer.notes = text(input.offer.notes, 'Offer notes', 2000);
    offer.termsConfirmed = flag(input.offer.termsConfirmed, 'Confirmed offer terms');
    if (offer.termsConfirmed && !offer.source) fail('Identify a source before marking offer terms confirmed.');
    calculateOffer(offer); // Share rent/concession consistency rules with the housing calculator.
    return { stage: input.stage, documents, deadlines, offer, notes: text(input.notes, 'Application notes', 4000) };
}
function publicListing(listing) {
    const result = Object.fromEntries(['id', 'title', 'neighborhood', 'location_area', 'price', 'status'].map(key => [key, listing[key] ?? null]));
    try { const url = new URL(listing.url); result.url = ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
    catch { result.url = null; }
    return result;
}
function differences(before, after, path = '') {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (Array.isArray(before) && Array.isArray(after) && ['documents', 'deadlines'].includes(path)) {
        const previous = new Map(before.map(entry => [entry.id, entry])), current = new Map(after.map(entry => [entry.id, entry]));
        const changes = [...new Set([...previous.keys(), ...current.keys()])].flatMap(id => differences(previous.get(id) ?? null, current.get(id) ?? null, `${path}.${id}`));
        if (!changes.length) changes.push({ field: `${path}.order`, before: before.map(item => item.id), after: after.map(item => item.id) });
        return changes;
    }
    if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => differences(before[key] ?? null, after[key] ?? null, path ? `${path}.${key}` : key));
    return [{ field: path, before, after }];
}
const excerpt = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\s]+/g, ' ').trim().slice(0, 500) : '';
function relatedActivityFor(id, messages, decisions) {
    const activity = [];
    for (const message of messages) {
        const data = message.data;
        if (data.listingId !== id || data.direction !== 'inbound' || !Number.isFinite(Date.parse(data.at))) continue;
        activity.push({ id: 'broker_reply:' + message.id, at: new Date(data.at).toISOString(), type: 'broker_reply',
            summary: excerpt(data.summary) || excerpt(data.subject) || 'Broker reply received.' });
    }
    const decision = decisions.find(record => record.id === id);
    for (const entry of decision?.data.history ?? []) {
        if (!entry.id || entry.listing_id && entry.listing_id !== id || !Number.isFinite(Date.parse(entry.created_at)) ||
            !['request_information', 'apply', 'pass', 'shortlist'].includes(entry.action)) continue;
        activity.push({ id: 'decision:' + entry.id, at: new Date(entry.created_at).toISOString(), type: 'decision', action: entry.action, summary: excerpt(entry.reason) });
    }
    return activity.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
function createApplicationService({ store, repository, now = Date.now } = {}) {
    if (!store || !repository) throw new Error('Application service requires store and repository.');
    async function listingFor(id) {
        if (typeof id !== 'string' || !id.length || id.length > 2048) fail('A listing ID is required.');
        const listing = (await repository.getListing(id)).rows[0];
        if (!listing) fail('Listing not found.', 404, 'not_found');
        return listing;
    }
    async function relatedRecords() {
        return Promise.all([store.list('conversation_messages'), store.list('decisions')]);
    }
    function response(listing, record, related = [[], []]) {
        const data = record?.data;
        const application = data?.application ?? seedApplication();
        return { listingId: listing.id, listing: publicListing(listing), revision: record?.revision ?? 0, application,
            createdAt: data?.createdAt ?? null, updatedAt: data?.updatedAt ?? null, stageTimestamps: data?.stageTimestamps ?? {}, activity: data?.activity ?? [],
            calculation: calculateOffer(application.offer), documentSuggestionsNotice: DOCUMENT_SUGGESTIONS_NOTICE,
            relatedActivity: relatedActivityFor(listing.id, ...related) };
    }
    async function get(id) {
        const listing = await listingFor(id);
        const [record, related] = await Promise.all([store.get(COLLECTION, listing.id), relatedRecords()]);
        return response(listing, record, related);
    }
    async function update(id, input) {
        keys(input, ['revision', 'application'], 'Save request');
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('Revision must be a nonnegative integer.');
        const application = validateApplication(input.application), listing = await listingFor(id);
        const [previous, related] = await Promise.all([store.get(COLLECTION, listing.id), relatedRecords()]);
        if ((previous?.revision ?? 0) !== input.revision) fail('The application changed. Reload it before saving.', 409, 'revision_conflict');
        const before = previous?.data.application ?? seedApplication();
        const changes = differences(before, application);
        if (previous && !changes.length) return response(listing, previous, related);
        const at = new Date(now()).toISOString();
        const stageChanged = before.stage !== application.stage;
        const data = { application, createdAt: previous?.data.createdAt ?? at, updatedAt: at,
            stageTimestamps: { ...(previous?.data.stageTimestamps ?? {}), ...(!previous || stageChanged ? { [application.stage]: at } : {}) },
            activity: [...(previous?.data.activity ?? []), { id: randomUUID(), at, actor: 'user',
                type: !previous ? 'created' : stageChanged ? 'stage_changed' : 'updated', fromStage: previous ? before.stage : null, toStage: application.stage, changes }] };
        // Never truncate audit history when the feature record reaches its storage limit.
        if (JSON.stringify(data).length > 240000) fail('This application has reached its history storage limit. Existing history has been preserved.', 400, 'history_limit');
        const record = await store.put(COLLECTION, listing.id, data, { expectedRevision: input.revision });
        return response(listing, record, related);
    }
    async function list() {
        const applications = [];
        const [records, related] = await Promise.all([store.list(COLLECTION), relatedRecords()]);
        for (const record of records) {
            const listing = (await repository.getListing(record.id)).rows[0];
            if (listing) applications.push(response(listing, record, related));
        }
        applications.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.listingId.localeCompare(b.listingId));
        return { applications };
    }
    async function compare(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 4) fail('Choose one to four applications to compare.');
        const applications = await Promise.all(ids.map(get));
        if (new Set(applications.map(application => application.listingId)).size !== applications.length) fail('Choose different apartments for comparison.');
        return { applications, currency: 'USD', notes: [
            'Offer terms are entered by you and remain separate from advertised rent and AI estimates.',
            'Unknown amounts are not treated as zero. Totals cover entered terms only.',
            'Upfront cash assumes the first monthly fee payment, all entered one-time fees, refundable deposit, and specified upfront rent are due before moving.',
            'Lease months are entered separately from lease dates; confirm any partial-month billing with the broker.'
        ] };
    }
    return { get, update, list, compare };
}
module.exports = { createApplicationService, ApplicationError, validateApplication, seedApplication, calculateOffer, COLLECTION, STAGES, DOCUMENT_SUGGESTIONS_NOTICE };
