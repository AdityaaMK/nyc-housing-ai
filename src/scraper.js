const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { initDB, pool } = require("./db");
const { normalizeAddress, checkOrRecordDuplicate } = require("./normalizer");
const { scrapeRentHop } = require("./renthop");

puppeteer.use(StealthPlugin());

const TARGET_FEEDS = [
    {
        name: "StreetEasy 2B2B $1,800-$5,000 (Manhattan)",
        url: "https://streeteasy.com/for-rent/manhattan/beds:2|baths:2|price:1800-5000|sort:created",
        match: (beds, baths, price) => beds >= 2 && baths >= 2 && (price === null || (price >= 1800 && price <= 5000))
    },
    {
        name: "StreetEasy 1B/Studio $1,800-$2,700 (Manhattan)",
        url: "https://streeteasy.com/for-rent/manhattan/beds:0-1|price:1800-2700|sort:created",
        match: (beds, baths, price) => beds <= 1 && (price === null || (price >= 1800 && price <= 2700))
    }
];

async function scrapeStreetEasyFeed(browser) {
    let totalNew = 0;
    const page = await browser.newPage();
    
    try {
        for (const feed of TARGET_FEEDS) {
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
                                    const price = item.price ? parseInt(item.price, 10) : null;
                                    
                                    // Verify against feed criteria
                                    if (!feed.match(bedrooms, bathrooms, price)) {
                                        continue;
                                    }
                                    
                                    const rawAddress = item.address ? item.address.streetAddress : null;
                                    const normalizedAddress = normalizeAddress(title, rawAddress);

                                    // Check cross-site duplicate
                                    const duplicate = await checkOrRecordDuplicate(pool, {
                                        normalizedAddress,
                                        newUrl: url,
                                        newSource: "streeteasy"
                                    });

                                    if (duplicate) {
                                        continue;
                                    }

                                    const res = await pool.query(`SELECT id FROM listings WHERE id = $1`, [id]);
                                    
                                    if (res.rows.length === 0) {
                                        await pool.query(
                                            `INSERT INTO listings (id, url, title, price, bedrooms, bathrooms, source, normalized_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                                            [id, url, title, price, bedrooms, bathrooms, "streeteasy", normalizedAddress]
                                        );
                                        console.log(`🎉 NEW MATCH [StreetEasy]: ${title} | $${price || "?"} | ${bedrooms} Bed / ${bathrooms} Bath | Key: ${normalizedAddress}`);
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
        
        console.log(`[${new Date().toISOString()}] Multi-source cycle complete: StreetEasy (+${seNew}), RentHop (+${rhNew}).`);
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
