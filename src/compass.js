const { pool } = require("./db");
const { normalizeAddress, checkOrRecordDuplicate } = require("./normalizer");

const COMPASS_FEEDS = [
    {
        name: "Compass 2B2B $1,800-$5,000 (Manhattan)",
        url: "https://www.compass.com/for-rent/manhattan-ny/1800-5000-price/",
        match: (beds, baths, price) => beds >= 2 && baths >= 2 && (price === null || (price >= 1800 && price <= 5000))
    },
    {
        name: "Compass 1B/Studio $1,800-$2,700 (Manhattan)",
        url: "https://www.compass.com/for-rent/manhattan-ny/1800-2700-price/",
        match: (beds, baths, price) => beds <= 1 && (price === null || (price >= 1800 && price <= 2700))
    }
];

async function scrapeCompass(browser) {
    let totalNew = 0;
    const page = await browser.newPage();
    
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await page.setViewport({ width: 1280, height: 800 });

        for (const feed of COMPASS_FEEDS) {
            console.log(`📡 [Compass] Checking feed: ${feed.name}...`);
            try {
                await page.goto(feed.url, { waitUntil: "networkidle2", timeout: 40000 });
                // Allow client-side rendering to settle
                await new Promise(r => setTimeout(r, 3500));

                const rawListings = await page.evaluate(() => {
                    const items = [];
                    const seenUrls = new Set();
                    const links = Array.from(document.querySelectorAll("a[href*=\"/homedetails/\"]"));

                    for (const link of links) {
                        const href = link.href.split("?")[0];
                        if (seenUrls.has(href)) continue;
                        seenUrls.add(href);

                        // Find parent card container that holds price & details
                        let container = link.parentElement;
                        for (let i = 0; i < 5; i++) {
                            if (container && container.innerText && container.innerText.includes("$")) break;
                            if (container && container.parentElement) container = container.parentElement;
                        }

                        const text = container ? container.innerText : link.innerText;

                        // Price
                        const priceMatch = text.match(/\$([0-9,]+)/);
                        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ""), 10) : null;

                        // Beds
                        let beds = 0;
                        if (/studio/i.test(text)) {
                            beds = 0;
                        } else {
                            const bedMatch = text.match(/([0-9.]+)\s*(?:bed|bedroom)/i);
                            if (bedMatch) beds = parseFloat(bedMatch[1]);
                        }

                        // Baths
                        let baths = 1;
                        const bathMatch = text.match(/([0-9.]+)\s*(?:bath|bathroom)/i);
                        if (bathMatch) baths = parseFloat(bathMatch[1]);

                        // Title / Address
                        let title = link.innerText.trim();
                        // Extract address from URL slug if link text is short
                        if (!title || title.length < 5) {
                            try {
                                const slug = href.split("/homedetails/")[1].split("/")[0];
                                title = slug.replace(/-/g, " ").replace(/ Manhattan NY.*$/i, "");
                            } catch(e) {}
                        }

                        // Neighborhood (often after pipe or in text)
                        let neighborhood = "Manhattan";
                        const nMatch = text.match(/(?:West Village|East Village|Lower East Side|Financial District|Hell's Kitchen|Chelsea|Gramercy|SoHo|Tribeca|Upper East Side|Upper West Side|Midtown|Harlem)/i);
                        if (nMatch) neighborhood = nMatch[0];

                        items.push({
                            url: href,
                            title,
                            price,
                            beds,
                            baths,
                            neighborhood
                        });
                    }
                    return items;
                });

                console.log(`   [Compass] Found ${rawListings.length} potential listings on page.`);

                for (const item of rawListings) {
                    const { beds, baths, price, url, neighborhood } = item;
                    if (!feed.match(beds, baths, price)) continue;

                    const normalizedAddress = normalizeAddress(item.title);
                    
                    // Generate unique Compass ID
                    let compId = "compass_" + Buffer.from(url).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(-16);
                    try {
                        const idMatch = url.match(/\/([a-zA-Z0-9_]+)_(?:pid|lid)\//);
                        if (idMatch) {
                            compId = `compass_${idMatch[1]}`;
                        }
                    } catch(e) {}

                    // Check for cross-site duplicate
                    const duplicate = await checkOrRecordDuplicate(pool, {
                        normalizedAddress,
                        newUrl: url,
                        newSource: "compass"
                    });

                    if (duplicate) {
                        continue;
                    }

                    // Check if already in DB
                    const existingById = await pool.query(`SELECT id FROM listings WHERE id = $1`, [compId]);
                    if (existingById.rows.length === 0) {
                        await pool.query(
                            `INSERT INTO listings (id, url, title, price, bedrooms, bathrooms, source, normalized_address, neighborhood)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                            [compId, url, item.title, price, beds, baths, "compass", normalizedAddress, neighborhood]
                        );
                        console.log(`🎉 NEW MATCH [Compass]: ${item.title} | $${price || "?"} | ${beds} Bed / ${baths} Bath | ${neighborhood}`);
                        totalNew++;
                    }
                }
            } catch (err) {
                console.error(`Error scraping Compass feed ${feed.name}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    } finally {
        await page.close();
    }

    return totalNew;
}

module.exports = { scrapeCompass };
