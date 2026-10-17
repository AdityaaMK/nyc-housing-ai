const { randomUUID } = require('node:crypto');
const { normalizeAddress } = require("./normalizer");
const { defaultListingInsights, ingestObservedListing, classifyScan } = require("./listing_insights");

const { getSearchFeeds } = require('./search_feeds');
const { scopedAddress } = require('./preferences');

async function scrapeCompass(browser) {
    let totalNew = 0;
    const page = await browser.newPage();
    const insights = defaultListingInsights();
    
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await page.setViewport({ width: 1280, height: 800 });

        for (const feed of getSearchFeeds('compass')) {
            console.log(`📡 [Compass] Checking feed: ${feed.name}...`);
            const started_at = new Date().toISOString(), scanId = randomUUID();
            let parsedCount = 0, observationCount = 0;
            try {
                const response = await page.goto(feed.url, { waitUntil: "networkidle2", timeout: 40000 });
                // Allow client-side rendering to settle
                await new Promise(r => setTimeout(r, 3500));

                const html = await page.content();
                const blocked = classifyScan({ html, status: response?.status?.() || 200, parsedCount: 1 }) === "blocked";
                const rawListings = blocked ? [] : await page.evaluate(() => {
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
                        let neighborhood = null;
                        const nMatch = text.match(/(?:Williamsburg|West Village|East Village|Lower East Side|Financial District|Hell's Kitchen|Chelsea|Gramercy|SoHo|Tribeca|Upper East Side|Upper West Side|Midtown|Harlem)/i);
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

                parsedCount = rawListings.length;
                for (const item of rawListings) {
                    const { beds, baths, price, url, neighborhood } = item;

                    const normalizedAddress = scopedAddress(normalizeAddress(item.title), feed.area);
                    
                    // Generate unique Compass ID
                    let compId = "compass_" + Buffer.from(url).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(-16);
                    try {
                        const idMatch = url.match(/\/([a-zA-Z0-9_]+)_(?:pid|lid)\//);
                        if (idMatch) {
                            compId = `compass_${idMatch[1]}`;
                        }
                    } catch(e) {}

                    const result = await ingestObservedListing({ listing: { id: compId, url, title: item.title, price, bedrooms: beds,
                        bathrooms: baths, source: 'compass', normalized_address: normalizedAddress, neighborhood, location_area: feed.area },
                        matchesFeed: feed.match(beds, baths, price), insights, scanId });
                    if (result.observed) observationCount++;
                    if (result.inserted) totalNew++;
                }
                await insights.recordScan({ id: scanId, source: 'compass', feed_url: feed.url, started_at, html,
                    status: response?.status?.() || 200, parsedCount, observationCount });
            } catch (err) {
                await insights.recordScan({ id: scanId, source: 'compass', feed_url: feed.url, started_at, outcome: 'failed', parsedCount, observationCount });
                console.error(`Error scraping Compass feed ${feed.name}:`, 'source request or persistence failure');
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    } finally {
        await page.close();
    }

    return totalNew;
}

module.exports = { scrapeCompass };
