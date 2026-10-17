const { loadPreferences } = require('./preferences');
const regions = {
    Manhattan: { streetEasy: 'manhattan', renthop: 'manhattan-new-york-ny', compass: 'manhattan-ny' },
    Brooklyn: { streetEasy: 'brooklyn', renthop: 'brooklyn-new-york-ny', compass: 'brooklyn-ny' },
    Queens: { streetEasy: 'queens', renthop: 'queens-new-york-ny', compass: 'queens-ny' },
    'Jersey City': { streetEasy: 'jersey-city', renthop: 'jersey-city-nj', compass: 'jersey-city-nj' },
    Hoboken: { streetEasy: 'hoboken', compass: 'hoboken-nj' }
};
function getSearchFeeds(source, preferences = loadPreferences()) {
    const selected = new Set([...preferences.preferredNeighborhoods.map(n => n.area), ...preferences.includedAreas]);
    return [...selected].flatMap(area => {
        const region = regions[area];
        if (!region || !region[source]) return [];
        return Object.values(preferences.budgets).filter(budget => budget.enabled).map(budget => {
            const { minRent, maxRent, minBedrooms, maxBedrooms, minBathrooms } = budget;
            const beds = Array.from({ length: maxBedrooms - minBedrooms + 1 }, (_, i) => minBedrooms + i);
            const bedFilter = minBedrooms === maxBedrooms ? minBedrooms : `${minBedrooms}-${maxBedrooms}`;
            let url;
            if (source === 'streetEasy') {
                url = `https://streeteasy.com/for-rent/${region.streetEasy}/beds:${bedFilter}|baths:${minBathrooms}|price:${minRent}-${maxRent}|sort:created`;
            } else if (source === 'renthop') {
                url = `https://www.renthop.com/apartments-for-rent/${region.renthop}?min_price=${minRent}&max_price=${maxRent}&${beds.map(bed => 'bedrooms[]=' + bed).join('&')}&bathrooms[]=${minBathrooms}&sort=created`;
            } else {
                url = `https://www.compass.com/for-rent/${region.compass}/${minRent}-${maxRent}-price/`;
            }
            return { name: `${source} ${bedFilter}B/${minBathrooms}+Bath $${minRent.toLocaleString('en-US')}-$${maxRent.toLocaleString('en-US')} (${area})`,
                area, url, preferenceRevision: preferences.revision,
                match: (bedrooms, bathrooms, price) => bedrooms != null && bathrooms != null && Number(bedrooms) >= minBedrooms && Number(bedrooms) <= maxBedrooms && Number(bathrooms) >= minBathrooms &&
                    (price === null || (Number(price) >= minRent && Number(price) <= maxRent)) };
        });
    });
}
module.exports = { getSearchFeeds };
