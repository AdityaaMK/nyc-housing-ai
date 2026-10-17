const { featureStore } = require('./feature_store');
const { repository } = require('./repository');
const { pool } = require('./db');
const { createAllowance } = require('./commute_allowance');
const { createListingInsights, summarizeAvailability } = require('./listing_insights');
const { createPreferencesService } = require('./preferences_service');
const { createSelectionService } = require('./selection_service');
const { createConversationService } = require('./conversations');
const { createTourPlanner } = require('./tour_planner');
const { createTourRouteService } = require('./tour_routes');
const { createHealthService } = require('./health_service');
const { assessPreferences } = require('./preferences');

function createProductServices({ store = featureStore, repo = repository, db = pool, now = Date.now, routeService, localHealth = true } = {}) {
    const preferences = createPreferencesService({ store, repository: repo, now });
    const insights = createListingInsights({ store, repository: repo, now, onTermsChanged: id => repo.requeueEvaluation(id) });
    const selection = createSelectionService({ store, repository: repo, now,
        preferenceService: { eligibility: async listing => assessPreferences(listing, await preferences.get()) },
        freshnessService: { getFreshness: id => insights.getInsights(id) } });
    const conversations = createConversationService({ store, repository: repo, now });
    const tours = createTourPlanner({ store, repository: repo, now,
        routeService: routeService || createTourRouteService({ store, allowance: createAllowance(db), now }) });
    const health = createHealthService({ store, repository: repo, now, local: localHealth });
    async function enrichListings(rows) {
        const [prefs, sources, metadata, watchlist] = await Promise.all([preferences.get(), store.list('listing_sources'), store.list('listing_insights'), store.list('watchlist')]);
        const byListing = new Map(), meta = new Map(metadata.map(row => [row.id, row.data])), watched = new Map(watchlist.map(row => [row.id, row.data]));
        for (const row of sources) {
            const list = byListing.get(row.data.listing_id) || []; list.push(row.data); byListing.set(row.data.listing_id, list);
        }
        const annotated = await preferences.annotate(rows, prefs);
        return annotated.map(row => {
            const observed = [...(byListing.get(row.id) || [])];
            let cross = [];
            try { cross = typeof row.cross_posted_sources === 'string' ? JSON.parse(row.cross_posted_sources) : row.cross_posted_sources || []; } catch {}
            for (const candidate of [{ source: row.source, url: row.url }, ...(Array.isArray(cross) ? cross : [])]) {
                if (candidate.url && !observed.some(source => source.url === candidate.url)) observed.push({ ...candidate, availability: 'unverified', observed_at: null });
            }
            return { ...row, ...summarizeAvailability(observed, now()), assessment_outdated: meta.get(row.id)?.assessment_outdated === true,
                saved: watched.get(row.id)?.saved === true };
        });
    }
    return { store, repository: repo, preferences, insights, selection, conversations, tours, health, enrichListings };
}
let shared;
const getProductServices = () => shared ||= createProductServices();
module.exports = { createProductServices, getProductServices };
