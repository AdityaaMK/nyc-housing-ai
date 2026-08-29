const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { initDB, pool } = require("./db");

puppeteer.use(StealthPlugin());

async function scrapeStreetEasy() {
    console.log(`[${new Date().toISOString()}] Launching browser for scrape cycle...`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    try {
        const page = await browser.newPage();
        const targetUrl = "https://streeteasy.com/for-rent/manhattan/sort:created";
        
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        const html = await page.content();
        
        const matches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
        let newListingsCount = 0;
        
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
                            const bedrooms = item.numberOfBedrooms || 0;
                            const bathrooms = item.numberOfBathroomsTotal || 0;
                            
                            const res = await pool.query(`SELECT id FROM listings WHERE id = $1`, [id]);
                            
                            if (res.rows.length === 0) {
                                await pool.query(
                                    `INSERT INTO listings (id, url, title, price, bedrooms, bathrooms) VALUES ($1, $2, $3, $4, $5, $6)`,
                                    [id, url, title, item.price || null, bedrooms, bathrooms]
                                );
                                console.log(`🎉 NEW LISTING FOUND: ${title} | Bed: ${bedrooms} | Bath: ${bathrooms} | URL: ${url}`);
                                newListingsCount++;
                            }
                        }
                    }
                } catch (e) {}
            }
        }
        console.log(`[${new Date().toISOString()}] Cycle complete. Found ${newListingsCount} new listings.`);
    } catch (err) {
        console.error("Error during scrape cycle:", err.message);
    } finally {
        await browser.close();
    }
}

async function run() {
    await initDB();
    await scrapeStreetEasy();
}

if (require.main === module) {
    run().catch(console.error);
}

module.exports = { run, scrapeStreetEasy };
