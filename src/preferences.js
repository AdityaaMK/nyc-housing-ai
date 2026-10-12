const fs = require('node:fs');
const path = require('node:path');

// Read the durable file at each cycle/request so preference edits do not need a restart.
function loadPreferences() {
    const preferences = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_preferences.json'), 'utf8'));
    if (!Array.isArray(preferences.preferredNeighborhoods) || !Array.isArray(preferences.includedAreas)) {
        throw new Error('Invalid saved search preferences');
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
    if (preferences.includedAreas.includes(area)) return true;
    const neighborhood = normalize(String(listing.neighborhood || '').split(',')[0]);
    return preferences.preferredNeighborhoods.some(n => n.area === area && [n.name, ...n.aliases].some(name => normalize(name) === neighborhood));
}

function preferenceSummary(preferences = loadPreferences()) {
    return `${preferences.preferredNeighborhoods.map(n => `${n.name} (${n.area})`).join(', ')}; also all neighborhoods in ${preferences.includedAreas.join(', ')}`;
}

function enforceLocation(evaluation, preferences = loadPreferences()) {
    evaluation.location_area = locationArea(evaluation, preferences) || 'Unknown';
    evaluation.is_preferred_neighborhood = matchesLocation(evaluation, preferences);
    if (!evaluation.is_preferred_neighborhood) {
        evaluation.suitability_score = Math.min(evaluation.suitability_score, 74);
        evaluation.red_flags.push('Outside saved search areas or location unverified');
    }
    return evaluation;
}

function scopedAddress(address, area) {
    if (!address) return null;
    return area === 'Manhattan' ? address : `${area}:${address}`;
}

module.exports = { loadPreferences, locationArea, matchesLocation, preferenceSummary, enforceLocation, scopedAddress };
