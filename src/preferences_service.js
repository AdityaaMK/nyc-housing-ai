const { refreshPreferences, validatePreferences, assessPreferences, hasScoredAssessment } = require('./preferences');

function createPreferencesService({ store, repository, now = Date.now }) {
    if (!store || !repository) throw new Error('Preferences require a shared store and listing repository');
    const get = () => refreshPreferences(store);
    async function update(input) {
        const expectedRevision = input?.expectedRevision ?? input?.revision;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
            const error = new Error('The current preference revision is required'); error.status = 400; throw error;
        }
        const data = validatePreferences(input);
        await get();
        await store.put('settings', 'search', data, { expectedRevision });
        return get();
    }
    async function annotate(listings, preferences) {
        preferences ||= await get();
        const records = await store.list('evaluation_preferences');
        const revisions = new Map(records.map(record => [record.id, record.data.revision]));
        return listings.map(listing => {
            const score_preferences_revision = revisions.get(listing.id) || (hasScoredAssessment(listing) ? 1 : null);
            const assessment = assessPreferences({ ...listing, score_preferences_revision }, preferences);
            return { ...listing, score_preferences_revision, preference_revision: preferences.revision,
                score_outdated: assessment.scoreOutdated, preferences_match: assessment.matches, preferences_reasons: assessment.reasons };
        });
    }
    async function preview(input = {}) {
        const current = await get();
        const draft = input.preferences ? { ...validatePreferences(input.preferences), revision: current.revision } : current;
        const listings = await annotate((await repository.listListings()).rows, draft);
        const assessments = listings.map(listing => ({ id: listing.id, title: listing.title, ...assessPreferences(listing, draft) }));
        const matching = assessments.filter(listing => listing.matches).length;
        return { revision: current.revision, total: assessments.length, matching, excluded: assessments.length - matching, listings: assessments };
    }
    async function recordEvaluation(id, revision) {
        // The scorer holds the listing claim until completion; saving a receipt never
        // changes application state or notification receipts.
        for (let attempt = 0; attempt < 4; attempt++) {
            const previous = await store.get('evaluation_preferences', id);
            if (previous?.data.revision > revision) return previous;
            try {
                return await store.put('evaluation_preferences', id, { revision, completedAt: new Date(now()).toISOString() }, { expectedRevision: previous?.revision || 0 });
            } catch (error) { if (error.status !== 409 || attempt === 3) throw error; }
        }
    }
    async function queueOutdated({ limit = 3, preferences } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Preference refresh limit must be 1–20');
        preferences ||= await get();
        if (preferences.revision <= 1) return { queued: 0, revision: preferences.revision };
        const listings = await annotate((await repository.listListings()).rows, preferences);
        let queued = 0;
        for (const listing of listings) {
            if (queued >= limit) break;
            if (!listing.score_outdated || !listing.is_evaluated || listing.status === 'passed' || listing.evaluation_status === 'processing') continue;
            const result = await repository.requeueEvaluation(listing.id);
            if (result.rowCount) queued++;
        }
        return { queued, revision: preferences.revision };
    }
    return { get, update, preview, annotate, recordEvaluation, queueOutdated };
}
module.exports = { createPreferencesService };
