const { loadPreferences } = require('./preferences');

const regions = {
    Manhattan: { streetEasy: 'manhattan', renthop: 'manhattan-new-york-ny', compass: 'manhattan-ny' },
    Brooklyn: { streetEasy: 'brooklyn', renthop: 'brooklyn-new-york-ny', compass: 'brooklyn-ny' },
    Queens: { streetEasy: 'queens', renthop: 'queens-new-york-ny', compass: 'queens-ny' },
    'Jersey City': { streetEasy: 'jersey-city', renthop: 'jersey-city-nj', compass: 'jersey-city-nj' },
    Hoboken: { streetEasy: 'hoboken', compass: 'hoboken-nj' }
};

function getSearchFeeds(source) {
    const preferences = loadPreferences();
    const selected = new Set([...preferences.preferredNeighborhoods.map(n => n.area), ...preferences.includedAreas]);
    return [...selected].flatMap(area => {
        const region = regions[area];
        if (!region || !region[source]) return [];
        return [true, false].map(twoBed => {
            const cap = twoBed ? 5000 : 2700;
            let url;
            if (source === 'streetEasy') {
                url = `https://streeteasy.com/for-rent/${region.streetEasy}/${twoBed ? 'beds:2|baths:2' : 'beds:0-1'}|price:1800-${cap}|sort:created`;
            } else if (source === 'renthop') {
                url = `https://www.renthop.com/apartments-for-rent/${region.renthop}?min_price=1800&max_price=${cap}&${twoBed ? 'bedrooms[]=2&bathrooms[]=2' : 'bedrooms[]=0&bedrooms[]=1'}&sort=created`;
            } else {
                url = `https://www.compass.com/for-rent/${region.compass}/1800-${cap}-price/`;
            }
            return {
                name: `${source} ${twoBed ? '2B2B' : '1B/Studio'} $1,800-$${cap.toLocaleString('en-US')} (${area})`,
                area, url,
                match: (beds, baths, price) => (twoBed ? beds >= 2 && baths >= 2 : beds <= 1) && (price === null || (price >= 1800 && price <= cap))
            };
        });
    });
}

module.exports = { getSearchFeeds };
