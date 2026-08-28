const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

puppeteer.use(StealthPlugin());

async function setupDB() {
    const db = await open({
        filename: "./listings.db",
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS listings (
            id TEXT PRIMARY KEY,
            url TEXT,
            title TEXT,
            price TEXT,
            bedrooms REAL,
            bathrooms REAL,
            discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    return db;
}

async function scrapeStreetEasy(db) {
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
                            
                            const exists = await db.get(`SELECT id FROM listings WHERE id = ?`, [id]);
                            
                            if (!exists) {
                                await db.run(
                                    `INSERT INTO listings (id, url, title, price, bedrooms, bathrooms) VALUES (?, ?, ?, ?, ?, ?)`,
                                    [id, url, title, item.price || null, bedrooms, bathrooms]
                                );
                                console.log(`🎉 NEW LISTING FOUND: ${title} | Bed: ${bedrooms} | Bath: ${bathrooms} | URL: ${url}`);
                                newListingsCount++;
                            }
                        }
                    }
                } catch (e) {
                }
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
    console.log("Starting StreetEasy Real-Time Monitor...");
    const db = await setupDB();
    await scrapeStreetEasy(db);
}

if (require.main === module) {
    run().catch(console.error);
}

module.exports = { run, scrapeStreetEasy, setupDB };
