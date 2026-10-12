const { pool } = require("./db");
const { normalizeAddress, checkOrRecordDuplicate } = require("./normalizer");

const { getSearchFeeds } = require('./search_feeds');
const { scopedAddress } = require('./preferences');

async function scrapeRentHop(browser) {
    let totalNew = 0;
    const page = await browser.newPage();
    
    try {
        for (const feed of getSearchFeeds('renthop')) {
            console.log(`📡 [RentHop] Checking feed: ${feed.name}...`);
            try {
                await page.goto(feed.url, { waitUntil: "domcontentloaded", timeout: 30000 });
                
                const rawListings = await page.evaluate(() => {
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

                for (const item of rawListings) {
                    const { beds, baths, price, url } = item;
                    if (!feed.match(beds, baths, price)) continue;

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

                    // Check for cross-site duplicate
                    const duplicate = await checkOrRecordDuplicate(pool, {
                        normalizedAddress,
                        newUrl: url,
                        newSource: "renthop"
                    });

                    if (duplicate) {
                        // Already exists (from StreetEasy or RentHop), skip creating duplicate
                        continue;
                    }

                    // Check if already in DB by ID
                    const existingById = await pool.query(`SELECT id FROM listings WHERE id = $1`, [id]);
                    if (existingById.rows.length === 0) {
                        await pool.query(
                            `INSERT INTO listings (id, url, title, price, bedrooms, bathrooms, source, normalized_address, location_area) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                            [id, url, displayTitle, price, beds, baths, "renthop", normalizedAddress, feed.area]
                        );
                        console.log(`🎉 NEW CANDIDATE [RentHop]: ${displayTitle} | $${price || "?"} | ${beds} Bed / ${baths} Bath | Key: ${normalizedAddress}`);
                        totalNew++;
                    }
                }
            } catch (err) {
                console.error(`Error scraping RentHop feed ${feed.name}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    } finally {
        await page.close();
    }
    
    return totalNew;
}

module.exports = { scrapeRentHop };
