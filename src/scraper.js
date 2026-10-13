const { repository } = require('./repository');
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { initDB, pool } = require("./db");
const { normalizeAddress, checkOrRecordDuplicate } = require("./normalizer");
const { scrapeRentHop } = require("./renthop");
const { scrapeCompass } = require("./compass");

puppeteer.use(StealthPlugin());

const { getSearchFeeds } = require('./search_feeds');
const { scopedAddress } = require('./preferences');

async function scrapeStreetEasyFeed(browser) {
    let totalNew = 0;
    const page = await browser.newPage();
    
    try {
        for (const feed of getSearchFeeds('streetEasy')) {
            console.log(`📡 [StreetEasy] Checking feed: ${feed.name}...`);
            try {
                await page.goto(feed.url, { waitUntil: "domcontentloaded", timeout: 30000 });
                const html = await page.content();
                const matches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
                
                if (matches) {
                    for (const match of matches) {
                        const jsonStr = match.replace(/<script type="application\/ld\+json">|<\/script>/g, "");
                        try {
                            const data = JSON.parse(jsonStr);
                            const items = data["@graph"] || (Array.isArray(data) ? data : [data]);
                            
                            for (const item of items) {
                                if (item["@type"] === "Apartment" || item["@type"] === "SingleFamilyResidence") {
                                    const id = item["@id"] || item.url;
                                    const title = item.name;
                                    const url = item.url;
                                    const bedrooms = parseFloat(item.numberOfBedrooms || 0);
                                    const bathrooms = parseFloat(item.numberOfBathroomsTotal || 0);
                                    const rawPrice = item.price ?? item.additionalProperty?.find(property => property.name === 'Monthly Rent')?.value;
                                    const parsedPrice = Number(String(rawPrice ?? '').replace(/[^0-9.]/g, ''));
                                    const price = parsedPrice > 0 ? parsedPrice : null;
                                    if (!id || !url || /bronx|staten.island/i.test(url + ' ' + (item.address?.addressLocality || ''))) continue;
                                    
                                    // Verify against feed criteria
                                    if (!feed.match(bedrooms, bathrooms, price)) {
                                        continue;
                                    }
                                    
                                    const rawAddress = item.address ? item.address.streetAddress : null;
                                    const normalizedAddress = scopedAddress(normalizeAddress(title, rawAddress), feed.area);

                                    // Check cross-site duplicate
                                    const duplicate = await checkOrRecordDuplicate(pool, {
                                        normalizedAddress,
                                        newUrl: url,
                                        newSource: "streeteasy"
                                    });

                                    if (duplicate) {
                                        continue;
                                    }

                                    const res = await repository.listingExists(id);
                                    
                                    if (res.rows.length === 0) {
                                        const inserted = await repository.insertListing({ id, url, title, price, bedrooms, bathrooms, source: "streeteasy", normalized_address: normalizedAddress, location_area: feed.area });
                        if (!inserted.rowCount) continue;
                                        console.log(`🎉 NEW CANDIDATE [StreetEasy]: ${title} | $${price || "?"} | ${bedrooms} Bed / ${bathrooms} Bath | Key: ${normalizedAddress}`);
                                        totalNew++;
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }
            } catch (err) {
                console.error(`Error scraping StreetEasy feed ${feed.name}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    } finally {
        await page.close();
    }
    return totalNew;
}

async function scrapeAllSources() {
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
        
        console.log(`[${new Date().toISOString()}] Multi-source cycle complete: StreetEasy (+${seNew}), RentHop (+${rhNew}), Compass (+${compNew}).`);
    } catch (err) {
        console.error("Error during multi-source scrape cycle:", err.message);
    } finally {
        await browser.close();
    }
}

async function run() {
    await initDB();
    await scrapeAllSources();
}

if (require.main === module) {
    run().catch(console.error);
}

module.exports = { run, scrapeStreetEasy: scrapeAllSources };
