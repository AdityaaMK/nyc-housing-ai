const { randomUUID } = require('node:crypto');
const { calculateHousingCosts, seedCostInput, validateCostInput } = require('./housing_costs');
const { publicError } = require('./evaluation_errors');

class SelectionError extends Error {
    constructor(message, status = 400, code = 'invalid_selection') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new SelectionError(message, status, code); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => {
    if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unsupported request fields.');
};
const string = (value, field, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(`${field} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
    return value.trim();
};
const revision = value => {
    if (!Number.isSafeInteger(value) || value < 0) fail('A nonnegative saved revision is required.');
    return value;
};
const parse = (value, fallback = null) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };
function publicListing(listing) {
    const { evaluation_claim_token, evaluation_claim_expires_at, ...clean } = listing;
    return { ...clean, evaluation_last_error: publicError(listing.evaluation_last_error), pros: parse(listing.pros, []), red_flags: parse(listing.red_flags, []),
        building_health: parse(listing.building_health), rent_terms: parse(listing.rent_terms) };
}
function createSelectionService({ store, repository, now = () => new Date(), preferenceService, freshnessService } = {}) {
    if (!store || !repository) throw new TypeError('Selection service requires a store and repository.');
    const timestamp = () => new Date(now()).toISOString();
    const getListing = async id => {
        string(id, 'Listing ID', 500, true);
        const listing = (await repository.getListing(id)).rows[0];
        if (!listing) fail('Listing not found.', 404, 'not_found');
        return listing;
    };
    async function getFreshness(id) {
        if (freshnessService?.getInsights) return freshnessService.getInsights(id);
        if (freshnessService?.getFreshness) return freshnessService.getFreshness(id);
        return null;
    }
    const primarySource = (listing, freshness) => freshness?.sources?.find(source => source.url === listing.url);
    function currentListing(listing, freshness) {
        const source = primarySource(listing, freshness), snapshot = source?.current_snapshot;
        // An old AI rent estimate cannot make a new asking price look affordable.
        // User-entered costs are retained separately below, never silently replaced.
        if (!freshness?.assessment_outdated && !(source?.availability === 'active' && snapshot?.verified_gross_rent)) return listing;
        const current = source?.availability === 'active' ? snapshot : null;
        return { ...listing, price: current?.advertised_rent ?? null, true_gross_rent: current?.verified_gross_rent ?? null,
            effective_monthly_rent: current?.effective_rent ?? null, rent_terms: current?.rent_terms ?? null,
            rent_provenance: { source_url: source?.url ?? null, observed_at: current?.observed_at ?? null,
                snapshot_id: current?.id ?? null, terms_status: current?.terms_status ?? 'unknown' } };
    }
    const getCostRecord = async (listing, suppliedFreshness) => {
        const freshness = suppliedFreshness === undefined ? await getFreshness(listing.id) : suppliedFreshness;
        const source = primarySource(listing, freshness), snapshot = source?.current_snapshot;
        const saved = await store.get('housing_costs', listing.id);
        const input = saved?.data.input ?? seedCostInput(currentListing(listing, freshness));
        if (!saved && source?.availability === 'active' && snapshot?.verified_gross_rent) {
            input.rent.evidence = 'confirmed';
            input.rent.source = `Observed listing terms: ${source.url} (${snapshot.observed_at}). Confirm the final offered lease.`.slice(0, 500);
        }
        const changed = Boolean(saved && snapshot?.id && saved.data.observed_snapshot_id !== snapshot.id);
        const outdated = changed || Boolean(freshness?.assessment_outdated && (!saved || !saved.data.observed_snapshot_id));
        const status = changed || source?.availability === 'unavailable' || freshness?.availability === 'unverified' ? 'needs_review' :
            !snapshot?.verified_gross_rent || outdated && input.rent.gross_monthly === null ? 'unverified' : 'current';
        return { revision: saved?.revision ?? 0, input, calculation: calculateHousingCosts(input), updated_at: saved?.updated_at ?? null,
            assumption_freshness: { status, input_source: saved ? 'user' : 'listing',
                reason: changed ? 'Observed rent terms changed after these costs were saved; your inputs have been preserved.' :
                    status === 'needs_review' ? 'Listing availability or cost evidence needs checking; saved inputs have been preserved.' :
                    status === 'unverified' ? 'Current gross rent or concession terms have not been verified. Unknown amounts remain incomplete.' :
                    saved ? 'Saved inputs refer to the latest observed terms; user assumptions remain labeled separately.' : 'Based on the latest observed primary-source terms.',
                observed_at: snapshot?.observed_at ?? null, observed_snapshot_id: snapshot?.id ?? null, source_url: source?.url ?? null } };
    };
    const getReviewRecord = async id => {
        const saved = await store.get('viewing_reviews', id);
        return { revision: saved?.revision ?? 0, review: saved?.data ?? null, updated_at: saved?.updated_at ?? null };
    };
    async function currentPreferences() {
        if (preferenceService) return null;
        const preferences = require('./preferences');
        return preferences.refreshPreferences ? preferences.refreshPreferences(store) : preferences.loadPreferences();
    }
    async function enrich(listing, preferences) {
        const freshness = await getFreshness(listing.id);
        const effectiveListing = currentListing(listing, freshness);
        const [watch, costs, review, decision] = await Promise.all([
            store.get('watchlist', listing.id), getCostRecord(listing, freshness), getReviewRecord(listing.id), store.get('decisions', listing.id)
        ]);
        let search = null;
        if (preferenceService?.eligibility) search = await preferenceService.eligibility(effectiveListing);
        else if (preferences) {
            const helpers = require('./preferences');
            search = helpers.assessPreferences ? helpers.assessPreferences(effectiveListing, preferences) : { matches: helpers.matchesLocation(effectiveListing, preferences), reasons: [] };
        }
        return { ...publicListing(effectiveListing), selection: { saved: Boolean(watch?.data.saved), saved_at: watch?.data.saved_at ?? null },
            costs, review, decision: decision ? { ...decision.data, revision: decision.revision } : null,
            ...(search ? { search_match: search } : {}), ...(freshness ? { freshness } : {}) };
    }
    async function setWatchlist(id, saved) {
        if (typeof saved !== 'boolean') fail('Saved must be true or false.');
        const listing = await getListing(id);
        for (let attempt = 0; attempt < 5; attempt++) {
            const previous = await store.get('watchlist', listing.id);
            if (Boolean(previous?.data.saved) === saved) return { id: listing.id, saved, saved_at: previous?.data.saved_at ?? null };
            const data = { saved, saved_at: saved ? timestamp() : null };
            try {
                await store.put('watchlist', listing.id, data, { expectedRevision: previous?.revision ?? 0 });
                return { id: listing.id, ...data };
            } catch (error) { if (error.status !== 409 && error.statusCode !== 409 || attempt === 4) throw error; }
        }
    }
    async function watchlist() {
        const preferences = await currentPreferences();
        const saved = (await store.list('watchlist')).filter(record => record.data.saved);
        const listings = await Promise.all(saved.map(async record => {
            const listing = (await repository.getListing(record.id)).rows[0];
            // The watch entry survives a source disappearing. If a listing was
            // deleted administratively, preserve an explicit placeholder.
            return listing ? enrich(listing, preferences) : { id: record.id, title: 'Listing record unavailable', availability: 'unverified',
                selection: { saved: true, saved_at: record.data.saved_at }, missing_record: true };
        }));
        return { listings };
    }
    async function comparison(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 4 || ids.some(id => typeof id !== 'string' || !id.trim())) fail('Compare between one and four listing IDs.');
        if (new Set(ids).size !== ids.length) fail('Comparison IDs must be unique.');
        const listings = await Promise.all(ids.map(getListing));
        if (new Set(listings.map(listing => listing.id)).size !== listings.length) fail('Comparison IDs must refer to different apartments.');
        const preferences = await currentPreferences();
        return { listings: await Promise.all(listings.map(listing => enrich(listing, preferences))) };
    }
    async function getCosts(id) { return getCostRecord(await getListing(id)); }
    async function updateCosts(id, payload) {
        keys(payload, ['revision', 'input']);
        const expectedRevision = revision(payload.revision), input = validateCostInput(payload.input);
        // Calculate before writing: invalid concession combinations never become saved state.
        calculateHousingCosts(input);
        const listing = await getListing(id);
        const freshness = await getFreshness(listing.id), snapshot = primarySource(listing, freshness)?.current_snapshot;
        await store.put('housing_costs', listing.id, { input, observed_snapshot_id: snapshot?.id ?? null }, { expectedRevision });
        return getCostRecord(listing);
    }
    async function getReview(id) { return getReviewRecord((await getListing(id)).id); }
    async function updateReview(id, payload) {
        keys(payload, ['revision', 'tour_id', 'checklist', 'notes', 'strengths', 'issues', 'rating']);
        const expectedRevision = revision(payload.revision), listing = await getListing(id);
        const tourId = string(payload.tour_id, 'Tour ID', 500, true);
        const tour = (await repository.getTour(tourId)).rows[0];
        const schedule = await store.get('tour_schedule', tourId);
        if (!tour) fail('Tour not found.', 404, 'not_found');
        if (schedule?.data.listingId !== listing.id || schedule.data.status !== 'completed') {
            fail('A review must be linked to a completed tour for this apartment.', 409, 'tour_not_completed');
        }
        const checklistKeys = ['noise', 'daylight', 'condition', 'storage', 'layout', 'building_access'];
        keys(payload.checklist, checklistKeys);
        const rating = (value, name) => {
            if (value == null) return null;
            if (!Number.isInteger(value) || value < 1 || value > 5) fail(`${name} must be 1–5 or null for unanswered.`);
            return value;
        };
        const checklist = Object.fromEntries(checklistKeys.map(key => [key, rating(payload.checklist[key], key)]));
        const previous = await store.get('viewing_reviews', listing.id);
        const data = { tour_id: tourId, checklist, rating: rating(payload.rating, 'Overall rating'),
            notes: string(payload.notes ?? '', 'Notes', 10000), strengths: string(payload.strengths ?? '', 'Strengths', 4000),
            issues: string(payload.issues ?? '', 'Issues', 4000), created_at: previous?.data.created_at ?? timestamp(), updated_at: timestamp() };
        await store.put('viewing_reviews', listing.id, data, { expectedRevision });
        return getReviewRecord(listing.id);
    }
    async function reconcileDecision(record) {
        const data = { ...record.data };
        let changed = false;
        if (data.pipeline_pending && data.action === 'pass') {
            const result = await repository.setListingStatus(record.id, 'passed');
            if (!result.rowCount) fail('Listing no longer exists.', 409, 'not_found');
            data.pipeline_pending = false; changed = true;
        }
        if (data.watchlist_pending && data.action === 'shortlist') {
            await setWatchlist(record.id, true);
            data.watchlist_pending = false; changed = true;
        }
        if (changed) return store.put('decisions', record.id, data, { expectedRevision: record.revision });
        return record;
    }
    async function decide(id, payload) {
        keys(payload, ['revision', 'action', 'reason']);
        const expectedRevision = revision(payload.revision), listing = await getListing(id);
        if (!['request_information', 'apply', 'pass', 'shortlist'].includes(payload.action)) fail('Unsupported decision action.');
        const reason = string(payload.reason ?? '', 'Decision reason', 4000, true);
        const previous = await store.get('decisions', listing.id);
        if ((previous?.revision ?? 0) !== expectedRevision) fail('Decision changed. Reload before saving.', 409, 'revision_conflict');
        const activity = { id: randomUUID(), listing_id: listing.id, action: payload.action, reason, created_at: timestamp() };
        // The decision and its full activity history share one atomic CAS write.
        // No event is sent to the Telegram or broker delivery queues.
        const data = { action: payload.action, reason, updated_at: activity.created_at,
            history: [...(previous?.data.history ?? []), activity], pipeline_pending: payload.action === 'pass', watchlist_pending: payload.action === 'shortlist' };
        const saved = await store.put('decisions', listing.id, data, { expectedRevision });
        try { await reconcileDecision(saved); }
        catch { /* The durable pending markers stay visible and are retried below. */ }
        const result = await store.get('decisions', listing.id);
        return { ...result.data, revision: result.revision };
    }
    async function decisions() {
        const preferences = await currentPreferences();
        let records = await store.list('decisions');
        // Reconcile a crash between the decision receipt and its local side effect.
        for (const record of records.filter(record => record.data.pipeline_pending || record.data.watchlist_pending)) {
            try { await reconcileDecision(record); }
            catch { /* Leave pending visible; do not discard the user's reason. */ }
        }
        records = await store.list('decisions');
        const watched = await store.list('watchlist');
        const ids = [...new Set([...records.map(record => record.id), ...watched.filter(record => record.data.saved).map(record => record.id)])];
        const listings = (await Promise.all(ids.map(async id => {
            const listing = (await repository.getListing(id)).rows[0];
            return listing ? enrich(listing, preferences) : null;
        }))).filter(Boolean).map(listing => {
            const passed = listing.status === 'passed' || listing.decision?.action === 'pass';
            const shortlist_status = passed ? 'passed' : listing.selection.saved ? 'active' : 'unsaved';
            return { ...listing, shortlist_status, activeCandidate: shortlist_status === 'active', shortlist_rank: null };
        }).sort((a, b) => {
            if (a.activeCandidate !== b.activeCandidate) return a.activeCandidate ? -1 : 1;
            if (!a.activeCandidate) return String(b.decision?.updated_at ?? '').localeCompare(String(a.decision?.updated_at ?? '')) || a.id.localeCompare(b.id);
            // Unanswered ratings remain null and sort last, never as zero stars.
            const ar = a.review.review?.rating, br = b.review.review?.rating;
            return (br ?? -1) - (ar ?? -1) || (b.suitability_score ?? -1) - (a.suitability_score ?? -1) || a.id.localeCompare(b.id);
        });
        let rank = 0;
        for (const listing of listings) if (listing.activeCandidate) listing.shortlist_rank = ++rank;
        const activity = records.flatMap(record => record.data.history ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        return { listings, activity };
    }
    return { setWatchlist, watchlist, comparison, getCosts, updateCosts, getReview, updateReview, decide, decisions };
}
module.exports = { createSelectionService, SelectionError };
