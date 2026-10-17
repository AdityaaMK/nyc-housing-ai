const { randomUUID } = require('node:crypto');
const { normalizeAddress } = require("./normalizer");
const { defaultListingInsights, ingestObservedListing, classifyScan } = require("./listing_insights");

const { getSearchFeeds } = require('./search_feeds');
const { scopedAddress } = require('./preferences');

async function scrapeRentHop(browser) {
    let totalNew = 0;
    const page = await browser.newPage();
    const insights = defaultListingInsights();
    
    try {
        for (const feed of getSearchFeeds('renthop')) {
            console.log(`📡 [RentHop] Checking feed: ${feed.name}...`);
            const started_at = new Date().toISOString(), scanId = randomUUID();
            let parsedCount = 0, observationCount = 0;
            try {
                const response = await page.goto(feed.url, { waitUntil: "domcontentloaded", timeout: 30000 });
                
                const html = await page.content();
                const blocked = classifyScan({ html, status: response?.status?.() || 200, parsedCount: 1 }) === "blocked";
                const rawListings = blocked ? [] : await page.evaluate(() => {
                    const items = [];
                    document.querySelectorAll(".search-listing").forEach(el => {
                        const link = el.querySelector("a[href*=\"/listings/\"]");
                        if (!link) return;
                        
                        const text = el.innerText || "";
                        
                        
                        // Price
                        const priceMatch = text.match(/\$([0-9,]+)/);
                        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ""), 10) : null;
                        
                        // Beds
                        let beds = 0;
                        if (text.includes("Studio")) {
                            beds = 0;
                        } else {
                            const bedMatch = text.match(/([0-9.]+)\s*Bed/i);
                            if (bedMatch) beds = parseFloat(bedMatch[1]);
                        }
                        
                        // Baths
                        let baths = 1;
                        const bathMatch = text.match(/([0-9.]+)\s*Bath/i);
                        if (bathMatch) baths = parseFloat(bathMatch[1]);
                        
                        // Address from title or card
                        const allLinks = Array.from(el.querySelectorAll("a[href*=\"/listings/\"]"));
                        let title = "";
                        for (const l of allLinks) {
                            const t = l.innerText.trim();
                            if (t.length > 3 && t !== "Suggested" && t !== "Featured" && t !== "Check Availability") {
                                title = t;
                                break;
                            }
                        }

                        items.push({
                            url: link.href.split("?")[0],
                            title,
                            price,
                            beds,
                            baths
                        });
                    });
                    return items;
                });

                parsedCount = rawListings.length;
                for (const item of rawListings) {
                    const { beds, baths, price, url } = item;

                    // Parse slug from URL to extract clean address and unit
                    let normalizedAddress = null;
                    let displayTitle = item.title;

                    try {
                        const pathParts = url.split("/listings/")[1].split("/");
                        if (pathParts.length >= 3) {
                            const street = pathParts[0].replace(/-/g, " ");
                            const unit = pathParts[1];
                            normalizedAddress = normalizeAddress(`${street} #${unit}`);
                            if (!displayTitle || displayTitle.length < 5) {
                                displayTitle = `${street.toUpperCase()} #${unit.toUpperCase()}`;
                            }
                        }
                    } catch(e) {}

                    normalizedAddress = normalizeAddress(displayTitle) || normalizedAddress;

                    normalizedAddress = scopedAddress(normalizedAddress, feed.area);

                    const numericId = url.split("/").pop();
                    const id = `renthop_${numericId}`;

                    const result = await ingestObservedListing({ listing: { id, url, title: displayTitle, price, bedrooms: beds,
                        bathrooms: baths, source: 'renthop', normalized_address: normalizedAddress, location_area: feed.area },
                        matchesFeed: feed.match(beds, baths, price), insights, scanId });
                    if (result.observed) observationCount++;
                    if (result.inserted) totalNew++;
                }
                await insights.recordScan({ id: scanId, source: 'renthop', feed_url: feed.url, started_at, html,
                    status: response?.status?.() || 200, parsedCount, observationCount });
            } catch (err) {
                await insights.recordScan({ id: scanId, source: 'renthop', feed_url: feed.url, started_at, outcome: 'failed', parsedCount, observationCount });
                console.error(`Error scraping RentHop feed ${feed.name}:`, 'source request or persistence failure');
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    } finally {
        await page.close();
    }
    
    return totalNew;
}

module.exports = { scrapeRentHop };
