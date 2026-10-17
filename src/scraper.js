const { randomUUID } = require('node:crypto');
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { initDB } = require("./db");
const { normalizeAddress } = require("./normalizer");
const { defaultListingInsights, ingestObservedListing, classifyScan } = require("./listing_insights");
const { scrapeRentHop } = require("./renthop");
const { scrapeCompass } = require("./compass");

puppeteer.use(StealthPlugin());

const { getSearchFeeds } = require('./search_feeds');
const { scopedAddress } = require('./preferences');

async function scrapeStreetEasyFeed(browser) {
    let totalNew = 0;
    const page = await browser.newPage();
    const insights = defaultListingInsights();
    try {
        for (const feed of getSearchFeeds('streetEasy')) {
            const started_at = new Date().toISOString(), scanId = randomUUID();
            let parsedCount = 0, observationCount = 0, parseErrors = 0;
            console.log(`📡 [StreetEasy] Checking feed: ${feed.name}...`);
            try {
                const response = await page.goto(feed.url, { waitUntil: "domcontentloaded", timeout: 30000 });
                const html = await page.content();
                const blocked = classifyScan({ html, status: response?.status?.() || 200, parsedCount: 1 }) === 'blocked';
                const matches = blocked ? [] : [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)];
                for (const match of matches) {
                    let data;
                    try { data = JSON.parse(match[1]); } catch { parseErrors++; continue; }
                    const items = data['@graph'] || (Array.isArray(data) ? data : [data]);
                    for (const item of items) {
                        if (!['Apartment', 'SingleFamilyResidence'].includes(item['@type'])) continue;
                        parsedCount++;
                        const id = item['@id'] || item.url, title = item.name, url = item.url;
                        const bedrooms = parseFloat(item.numberOfBedrooms || 0), bathrooms = parseFloat(item.numberOfBathroomsTotal || 0);
                        const rawPrice = item.price ?? item.additionalProperty?.find(property => property.name === 'Monthly Rent')?.value;
                        const parsedPrice = Number(String(rawPrice ?? '').replace(/[^0-9.]/g, ''));
                        const price = parsedPrice > 0 ? parsedPrice : null;
                        if (!id || !url || /bronx|staten.island/i.test(url + ' ' + (item.address?.addressLocality || ''))) { parseErrors++; continue; }
                        const normalizedAddress = scopedAddress(normalizeAddress(title, item.address?.streetAddress), feed.area);
                        const result = await ingestObservedListing({ listing: { id, url, title, price, bedrooms, bathrooms,
                            source: 'streeteasy', normalized_address: normalizedAddress, location_area: feed.area },
                            matchesFeed: feed.match(bedrooms, bathrooms, price), insights, scanId });
                        if (result.observed) observationCount++;
                        if (result.inserted) totalNew++;
                    }
                }
                await insights.recordScan({ id: scanId, source: 'streeteasy', feed_url: feed.url, started_at, html,
                    status: response?.status?.() || 200, parsedCount, observationCount, parseErrors });
            } catch {
                await insights.recordScan({ id: scanId, source: 'streeteasy', feed_url: feed.url, started_at, outcome: 'failed', parsedCount, observationCount });
                console.error(`StreetEasy feed failed: ${feed.name}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally { await page.close(); }
    return totalNew;
}

async function scrapeAllSources() {
    const cycleStarted = new Date().toISOString();
    await require("./preferences").refreshPreferences(require("./feature_store").createFeatureStore());
    console.log(`[${new Date().toISOString()}] Launching browser for multi-source ingestion cycle...`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    try {
        // 1. StreetEasy Ingestion
        const seNew = await scrapeStreetEasyFeed(browser);
        
        // 2. RentHop Ingestion
        const rhNew = await scrapeRentHop(browser);
        
        // 3. Compass Ingestion
        const compNew = await scrapeCompass(browser);
        await defaultListingInsights().recheckTracked({ limit: 3 });
        
        console.log(`[${new Date().toISOString()}] Multi-source cycle complete: StreetEasy (+${seNew}), RentHop (+${rhNew}), Compass (+${compNew}).`);
        const scans = (await require('./feature_store').createFeatureStore().list('source_scans')).map(row => row.data).filter(scan => scan.started_at >= cycleStarted);
        return { newListings: seNew + rhNew + compNew, scanCount: scans.length,
            degraded: !scans.length || scans.some(scan => !['success', 'empty'].includes(scan.outcome)) };
    } catch (err) {
        console.error("Multi-source scrape cycle failed.");
        throw err;
    } finally {
        await browser.close();
    }
}

async function run() {
    await initDB();
    return scrapeAllSources();
}

if (require.main === module) {
    run().catch(console.error);
}

module.exports = { run, scrapeStreetEasy: scrapeAllSources, scrapeStreetEasyFeed };
