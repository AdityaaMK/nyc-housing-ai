/** Normalize a specific apartment, retaining its unit and requiring a house number. */
function normalizeAddress(title, rawAddress) {
    const titleLine = String(title || '').split('\n')[0].trim();
    let text = String(rawAddress || titleLine).split('\n')[0].toUpperCase().trim();
    if (!/^\d+[A-Z]?(?:[-/]\d+)?\s/.test(text)) return null;
    const unitPattern = /(?:#|\bAPT\.?|\bUNIT\.?|\bSUITE\.?|\bPENTHOUSE|\bPH)\s*([0-9A-Z-]+)/i;
    const unitMatch = text.match(unitPattern) || titleLine.match(unitPattern);
    const unit = unitMatch ? unitMatch[1].toUpperCase().replace(/^0+(?=[1-9A-Z])/, '') : '';
    text = text.replace(unitPattern, '').replace(/,.*$/, '').trim();
    const substitutions = { WEST:'W', EAST:'E', NORTH:'N', SOUTH:'S', STREET:'ST', AVENUE:'AVE', BOULEVARD:'BLVD', PLACE:'PL', ROAD:'RD', DRIVE:'DR', LANE:'LN', SQUARE:'SQ' };
    for (const [word, abbreviation] of Object.entries(substitutions)) text = text.replace(new RegExp(`\\b${word}\\b`, 'g'), abbreviation);
    text = text.replace(/[^A-Z0-9]/g, ' ').trim().replace(/\s+/g, '-');
    // A building without a known unit is insufficient evidence of a duplicate apartment.
    return unit ? `${text}-${unit}` : null;
}

async function checkOrRecordDuplicate(pool, input) {
    return require('./repository').createRepository(pool).recordDuplicate(input);
}
module.exports = { normalizeAddress, checkOrRecordDuplicate };
