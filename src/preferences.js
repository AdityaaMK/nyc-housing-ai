const fs = require('node:fs');
const path = require('node:path');

// Read the durable file at each cycle/request so preference edits do not need a restart.
function loadPreferences() {
    const preferences = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_preferences.json'), 'utf8'));
    if (!Array.isArray(preferences.preferredNeighborhoods) || !Array.isArray(preferences.includedAreas)) {
        throw new Error('Invalid saved search preferences');
    }
    if (!Number.isFinite(preferences.includedAreaCommute?.maxMinutes) || preferences.includedAreaCommute.maxMinutes <= 0) {
        throw new Error('Invalid saved commute limit');
    }
    return preferences;
}

const normalize = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
const areas = ['Manhattan', 'Brooklyn', 'Queens', 'Jersey City', 'Hoboken', 'Bronx', 'Staten Island'];

function locationArea(listing, preferences = loadPreferences()) {
    const explicit = normalize(listing.location_area);
    if (explicit) return areas.find(area => normalize(area) === explicit) || null;
    const parts = String(listing.neighborhood || '').split(',').map(normalize);
    const area = areas.find(area => parts.includes(normalize(area)));
    if (area) return area;
    return preferences.preferredNeighborhoods.find(n => [n.name, ...n.aliases].some(name => normalize(name) === parts[0]))?.area || null;
}

function matchesLocation(listing, preferences = loadPreferences()) {
    const area = locationArea(listing, preferences);
    // Apply the regional commute limit before named-neighborhood matching, including Williamsburg.
    if (preferences.includedAreas.includes(area)) {
        return Number.isFinite(listing.manhattan_commute_minutes) && listing.manhattan_commute_minutes > 0 &&
            listing.manhattan_commute_minutes <= preferences.includedAreaCommute.maxMinutes &&
            typeof listing.manhattan_arrival_station === 'string' && Boolean(listing.manhattan_arrival_station.trim()) &&
            typeof listing.manhattan_commute_summary === 'string' && Boolean(listing.manhattan_commute_summary.trim());
    }
    const neighborhood = normalize(String(listing.neighborhood || '').split(',')[0]);
    return preferences.preferredNeighborhoods.some(n => n.area === area && [n.name, ...n.aliases].some(name => normalize(name) === neighborhood));
}

function preferenceSummary(preferences = loadPreferences()) {
    return `${preferences.preferredNeighborhoods.map(n => `${n.name} (${n.area})`).join(', ')}; ${preferences.includedAreas.join(', ')} qualify ONLY when the apartment is within ${preferences.includedAreaCommute.maxMinutes} minutes by public transit of ${preferences.includedAreaCommute.destination}, including walking to the origin station, typical waiting, and transfers. This requirement also applies to named neighborhoods in those areas, including Williamsburg. Unknown commute times do not qualify. The office commute is separate`;
}

function enforceLocation(evaluation, preferences = loadPreferences()) {
    evaluation.location_area = locationArea(evaluation, preferences) || 'Unknown';
    // Keep missing/invalid estimates unknown, including older evaluations without these fields.
    if (!Number.isFinite(evaluation.manhattan_commute_minutes) || evaluation.manhattan_commute_minutes <= 0) evaluation.manhattan_commute_minutes = null;
    for (const key of ['manhattan_arrival_station', 'manhattan_commute_summary']) {
        evaluation[key] = typeof evaluation[key] === 'string' && evaluation[key].trim() ? evaluation[key].trim() : null;
    }
    evaluation.is_preferred_neighborhood = matchesLocation(evaluation, preferences);
    if (!evaluation.is_preferred_neighborhood) {
        evaluation.suitability_score = Math.min(evaluation.suitability_score, 74);
        evaluation.red_flags.push(preferences.includedAreas.includes(evaluation.location_area)
            ? `Manhattan arrival commute exceeds ${preferences.includedAreaCommute.maxMinutes} minutes or has no usable estimate/route`
            : 'Outside saved search areas or location unverified');
    }
    return evaluation;
}

function scopedAddress(address, area) {
    if (!address) return null;
    return area === 'Manhattan' ? address : `${area}:${address}`;
}

module.exports = { loadPreferences, locationArea, matchesLocation, preferenceSummary, enforceLocation, scopedAddress };
