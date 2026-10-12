const { locationArea } = require('./preferences');

// Maps URLs open the transit planner; they do not verify or alter a saved estimate.
function commuteMapsUrl(listing) {
    const area = locationArea(listing);
    const title = String(listing.title || '').split('\n')[0].trim();
    const address = title.split(',')[0].replace(/\s*(?:#|\bAPT\.?\s|\bUNIT\s|\bSUITE\s).*$/i, '').trim();
    if (!area || !/^\d+[A-Z]?(?:[-/]\d+)?\s/i.test(address) ||
        !/\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|place|pl|court|ct|terrace|way|broadway)\b/i.test(address)) return null;
    const state = ['Jersey City', 'Hoboken'].includes(area) ? 'NJ' : 'NY';
    const configured = process.env.TARGET_COMMUTE_ADDRESS?.trim();
    const destination = !configured || configured === 'Datadog Office (620 8th Ave, NYT Building, NYC)'
        ? '620 8th Avenue, New York, NY 10018' : configured;
    const url = new URL('https://www.google.com/maps/dir/');
    url.search = new URLSearchParams({ api: '1', origin: `${address}, ${area}, ${state}`,
        destination, travelmode: 'transit' }).toString();
    return url.href.length <= 2048 ? url.href : null;
}
module.exports = { commuteMapsUrl };
