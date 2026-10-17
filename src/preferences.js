const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_AREAS = ['Manhattan', 'Brooklyn', 'Queens', 'Jersey City', 'Hoboken'];
const ALL_AREAS = [...SUPPORTED_AREAS, 'Bronx', 'Staten Island'];
const BUDGET_TYPES = ['studioOneBedroom', 'twoBedroom'];
const normalize = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
const clone = value => JSON.parse(JSON.stringify(value));
let snapshot;
function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, field, max = 120) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) invalid(`Invalid ${field}`);
    return value.trim();
}
function number(value, field, min, max, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(`Invalid ${field}`);
    return value;
}
function defaultPreferences() {
    const saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_preferences.json'), 'utf8'));
    return { schemaVersion: 1, ...saved,
        budgets: {
            studioOneBedroom: { enabled: true, minRent: 1800, maxRent: 2700, minBedrooms: 0, maxBedrooms: 1, minBathrooms: 1 },
            twoBedroom: { enabled: true, minRent: 1800, maxRent: 5000, minBedrooms: 2, maxBedrooms: 2, minBathrooms: 2 }
        },
        officeCommute: { maxMinutes: null, destination: process.env.TARGET_COMMUTE_ADDRESS || '620 8th Ave, New York, NY' }
    };
}
function validatePreferences(value) {
    if (!object(value)) invalid('Search preferences must be an object');
    const allowed = new Set(['schemaVersion', 'revision', 'expectedRevision', 'preferredNeighborhoods', 'includedAreas', 'includedAreaCommute', 'budgets', 'officeCommute']);
    if (Object.keys(value).some(key => !allowed.has(key))) invalid('Unsupported search preference field');
    if (value.schemaVersion !== 1) invalid('Unsupported search preferences schema version');
    if (!Array.isArray(value.preferredNeighborhoods) || value.preferredNeighborhoods.length > 100) invalid('Invalid preferred neighborhoods');
    const preferredNeighborhoods = value.preferredNeighborhoods.map(neighborhood => {
        if (!object(neighborhood) || !SUPPORTED_AREAS.includes(neighborhood.area) || !Array.isArray(neighborhood.aliases) || neighborhood.aliases.length > 20) invalid('Unsupported neighborhood or region');
        return { name: text(neighborhood.name, 'neighborhood'), area: neighborhood.area, aliases: neighborhood.aliases.map(alias => text(alias, 'neighborhood alias')) };
    });
    if (!Array.isArray(value.includedAreas) || value.includedAreas.some(area => !SUPPORTED_AREAS.includes(area))) invalid('Unsupported search region');
    const includedAreas = [...new Set(value.includedAreas)];
    if (!preferredNeighborhoods.length && !includedAreas.length) invalid('Choose at least one neighborhood or region');
    if (!object(value.includedAreaCommute)) invalid('Invalid Manhattan arrival commute');
    const includedAreaCommute = { maxMinutes: number(value.includedAreaCommute.maxMinutes, 'Manhattan arrival limit', 1, 180), destination: 'any Manhattan arrival station' };
    if (value.includedAreaCommute.destination !== includedAreaCommute.destination) invalid('Manhattan arrival destination must remain separate from the office destination');
    if (!object(value.officeCommute)) invalid('Invalid office commute');
    const officeCommute = {
        maxMinutes: value.officeCommute.maxMinutes === null ? null : number(value.officeCommute.maxMinutes, 'office commute limit', 1, 240),
        destination: text(value.officeCommute.destination, 'office destination', 300)
    };
    if (!object(value.budgets) || Object.keys(value.budgets).some(key => !BUDGET_TYPES.includes(key))) invalid('Invalid apartment budgets');
    const budgets = {};
    for (const type of BUDGET_TYPES) {
        const budget = value.budgets[type];
        if (!object(budget) || typeof budget.enabled !== 'boolean') invalid(`Invalid ${type} budget`);
        budgets[type] = { enabled: budget.enabled,
            minRent: number(budget.minRent, 'minimum rent', 0, 100000), maxRent: number(budget.maxRent, 'maximum rent', 1, 100000),
            minBedrooms: number(budget.minBedrooms, 'minimum bedrooms', 0, 8, true), maxBedrooms: number(budget.maxBedrooms, 'maximum bedrooms', 0, 8, true),
            minBathrooms: number(budget.minBathrooms, 'minimum bathrooms', 0.5, 8) };
        if (budget.minRent > budget.maxRent || budget.minBedrooms > budget.maxBedrooms) invalid('Minimum values must not exceed maximum values');
    }
    if (!Object.values(budgets).some(budget => budget.enabled)) invalid('Enable at least one apartment type');
    const [first, second] = BUDGET_TYPES.map(type => budgets[type]);
    if (first.enabled && second.enabled && first.minBedrooms <= second.maxBedrooms && second.minBedrooms <= first.maxBedrooms) invalid('Bedroom ranges must not overlap');
    return { schemaVersion: 1, preferredNeighborhoods, includedAreas, includedAreaCommute, budgets, officeCommute };
}
// Synchronous readers use a validated snapshot; each independent worker refreshes
// from the shared database at its cycle boundary. JSON is only the initial seed.
function loadPreferences() {
    snapshot ||= { ...validatePreferences(defaultPreferences()), revision: 1 };
    return clone(snapshot);
}
async function refreshPreferences(store) {
    let record = await store.get('settings', 'search');
    if (!record) {
        await store.create('settings', 'search', validatePreferences(defaultPreferences()));
        record = await store.get('settings', 'search');
    }
    if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('Search preferences are unavailable');
    const validated = validatePreferences(record.data);
    snapshot = { ...validated, revision: record.revision };
    return clone(snapshot);
}
function locationArea(listing, preferences = loadPreferences()) {
    const explicit = normalize(listing.location_area);
    if (explicit) return ALL_AREAS.find(area => normalize(area) === explicit) || null;
    const parts = String(listing.neighborhood || '').split(',').map(normalize);
    const area = ALL_AREAS.find(area => parts.includes(normalize(area)));
    if (area) return area;
    return preferences.preferredNeighborhoods.find(n => [n.name, ...n.aliases].some(name => normalize(name) === parts[0]))?.area || null;
}
function matchesLocation(listing, preferences = loadPreferences()) {
    const area = locationArea(listing, preferences);
    if (preferences.includedAreas.includes(area)) {
        if (area === 'Manhattan') return true;
        return Number.isFinite(listing.manhattan_commute_minutes) && listing.manhattan_commute_minutes > 0 &&
            listing.manhattan_commute_minutes <= preferences.includedAreaCommute.maxMinutes &&
            typeof listing.manhattan_arrival_station === 'string' && Boolean(listing.manhattan_arrival_station.trim()) &&
            typeof listing.manhattan_commute_summary === 'string' && Boolean(listing.manhattan_commute_summary.trim());
    }
    const neighborhood = normalize(String(listing.neighborhood || '').split(',')[0]);
    return preferences.preferredNeighborhoods.some(n => n.area === area && [n.name, ...n.aliases].some(name => normalize(name) === neighborhood));
}
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
function hasScoredAssessment(listing) {
    return Boolean(listing.is_evaluated) || Number.isFinite(listing.suitability_score) ||
        (Number.isSafeInteger(listing.score_preferences_revision) && listing.score_preferences_revision > 0);
}
function budgetForListing(listing, preferences = loadPreferences()) {
    const beds = numeric(listing.bedrooms);
    if (beds === null) return null;
    return Object.entries(preferences.budgets).find(([, budget]) => budget.enabled && beds >= budget.minBedrooms && beds <= budget.maxBedrooms) || null;
}
function assessPreferences(listing, preferences = loadPreferences()) {
    const reasons = [], budgetEntry = budgetForListing(listing, preferences), baths = numeric(listing.bathrooms);
    const budgetRent = numeric(listing.effective_monthly_rent) ?? numeric(listing.true_gross_rent) ?? numeric(listing.price);
    if (!budgetEntry) reasons.push(numeric(listing.bedrooms) === null ? 'Bedroom count is unknown' : 'Bedroom count is outside the saved search');
    if (baths === null) reasons.push('Bathroom count is unknown');
    else if (budgetEntry && baths < budgetEntry[1].minBathrooms) reasons.push(`Requires at least ${budgetEntry[1].minBathrooms} bathrooms`);
    if (budgetRent === null || budgetRent <= 0) reasons.push('Rent is unknown');
    else if (budgetEntry && (budgetRent < budgetEntry[1].minRent || budgetRent > budgetEntry[1].maxRent)) reasons.push(`Rent is outside the $${budgetEntry[1].minRent}–$${budgetEntry[1].maxRent} budget`);
    if (!matchesLocation(listing, preferences)) reasons.push('Location or Manhattan arrival commute does not match the saved search');
    const officeLimit = preferences.officeCommute?.maxMinutes;
    if (officeLimit != null && (!Number.isFinite(listing.commute_minutes) || listing.commute_minutes <= 0 || listing.commute_minutes > officeLimit)) reasons.push(`Office commute exceeds ${officeLimit} minutes or is unknown`);
    return { matches: reasons.length === 0, reasons, revision: preferences.revision,
        budgetType: budgetEntry?.[0] || null, budgetRent,
        scoreOutdated: hasScoredAssessment(listing) && Number(listing.score_preferences_revision || 1) < preferences.revision };
}
const matchesPreferences = (listing, preferences) => assessPreferences(listing, preferences).matches;
function preferenceSummary(preferences = loadPreferences()) {
    return `${preferences.preferredNeighborhoods.map(n => `${n.name} (${n.area})`).join(', ')}; ${preferences.includedAreas.join(', ')} qualify ONLY when the apartment is within ${preferences.includedAreaCommute.maxMinutes} minutes by public transit of ${preferences.includedAreaCommute.destination}, including walking to the origin station, typical waiting, and transfers (apartments already in Manhattan need no arrival journey). This requirement also applies to named neighborhoods in those areas, including Williamsburg. Unknown commute times do not qualify. The office commute is separate${preferences.officeCommute?.maxMinutes == null ? ' and has no hard maximum' : ` and must be at most ${preferences.officeCommute.maxMinutes} minutes`}`;
}
function budgetSummary(preferences = loadPreferences()) {
    return Object.values(preferences.budgets).filter(b => b.enabled).map(b => `${b.minBedrooms}–${b.maxBedrooms} bedrooms, at least ${b.minBathrooms} bathrooms, $${b.minRent}–$${b.maxRent} monthly net effective rent`).join(' OR ');
}
function enforceLocation(evaluation, preferences = loadPreferences()) {
    evaluation.location_area = locationArea(evaluation, preferences) || 'Unknown';
    if (!Number.isFinite(evaluation.manhattan_commute_minutes) || evaluation.manhattan_commute_minutes <= 0) evaluation.manhattan_commute_minutes = null;
    for (const key of ['manhattan_arrival_station', 'manhattan_commute_summary']) evaluation[key] = typeof evaluation[key] === 'string' && evaluation[key].trim() ? evaluation[key].trim() : null;
    evaluation.is_preferred_neighborhood = matchesLocation(evaluation, preferences);
    if (!evaluation.is_preferred_neighborhood) {
        evaluation.suitability_score = Math.min(evaluation.suitability_score, 74);
        evaluation.red_flags.push(preferences.includedAreas.includes(evaluation.location_area)
            ? `Manhattan arrival commute exceeds ${preferences.includedAreaCommute.maxMinutes} minutes or has no usable estimate/route`
            : 'Outside saved search areas or location unverified');
    }
    return evaluation;
}
function scopedAddress(address, area) { return !address ? null : area === 'Manhattan' ? address : `${area}:${address}`; }
module.exports = { loadPreferences, refreshPreferences, validatePreferences, defaultPreferences, SUPPORTED_AREAS,
    locationArea, matchesLocation, matchesPreferences, assessPreferences, hasScoredAssessment, budgetForListing, budgetSummary, preferenceSummary, enforceLocation, scopedAddress };
