require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { initDB, pool } = require("./db");
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { checkBuildingHealth } = require("./building_health");

puppeteer.use(StealthPlugin());

async function runAIEvaluation(listing, description) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("   [⚠️ MOCK AI: GEMINI_API_KEY not found in .env]");
        const mockRedFlags = [];
        if (description.toLowerCase().includes("flex")) mockRedFlags.push("Possible Flex/Railroad layout");
        if (description.toLowerCase().includes("net")) mockRedFlags.push("Net Effective rent mentioned");
        
        return {
            true_gross_rent: listing.price ? parseInt(listing.price) : 0,
            is_fee: description.toLowerCase().includes("broker fee"),
            fee_estimate: "Unknown",
            red_flags: mockRedFlags,
            pros: ["Mock Pro"],
            suitability_score: Math.floor(Math.random() * 30) + 70
        };
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
        model: "gemini-flash-lite-latest",
        generationConfig: { responseMimeType: "application/json" }
    });

    const targetOffice = process.env.TARGET_COMMUTE_ADDRESS || "Datadog Office (620 8th Ave, NYT Building, NYC)";

    const prompt = `
    You are an expert NYC Real Estate AI Assistant evaluating an apartment for a renter.
    
    Listing Title: ${listing.title}
    Advertised Price: $${listing.price || "Unknown"}
    Bedrooms: ${listing.bedrooms} | Bathrooms: ${listing.bathrooms}
    URL: ${listing.url}
    
    Description:
    ${description}
    
    RENTER PREFERENCES & CRITERIA:
    - Budget / Layout: 2B2B between $1,800 and $5,000 OR 1B/Studio between $1,800 and $2,700 (Manhattan only). Minimum rent is $1,800.
    - PREFERRED NEIGHBORHOODS: Lower East Side (LES), Financial District (FiDi), East Village, Hell's Kitchen.
    - WORKPLACE / COMMUTE TARGET: ${targetOffice} (Located at 8th Ave & 40th/41st St, direct access to Times Sq-42 St / Port Authority A/C/E/1/2/3/7/N/Q/R/W).
    
    Analyze the listing and output a JSON object with the following exact keys:
    - "neighborhood": (string) NYC neighborhood (e.g., "Lower East Side", "East Village", "Financial District", "Hell's Kitchen", "Harlem", "Upper West Side", "Chelsea", etc.).
    - "is_preferred_neighborhood": (boolean) true if the listing is in LES, FiDi, East Village, or Hell's Kitchen.
    - "commute_minutes": (number) estimated door-to-door morning commute time in minutes to ${targetOffice} (including walking to nearest subway + train ride + walk to 620 8th Ave).
    - "commute_summary": (string) concise door-to-door transit route, e.g. "18 mins: 4 min walk to A/C/E @ 14th St -> 8 min ride to 42 St-Port Authority (direct exit into 620 8th Ave)".
    - "true_gross_rent": (number) calculate actual monthly rent. If net effective / concessions mentioned, compute actual monthly gross check. If not, use advertised price.
    - "is_fee": (boolean) true if broker fee mentioned, tenant pays fee, or 15%. False if explicitly no fee.
    - "fee_estimate": (string) e.g., "15% of annual", "1 month rent", or "None".
    - "red_flags": (array of strings) negative aspects: walk-up above 3rd floor, basement, railroad layout, windowless rooms, net-effective rent tricks, fake amenities, exorbitant fees, or >40 min commute.
    - "pros": (array of strings) positive aspects: ultra-fast commute (<25 min to office), in-unit laundry, dishwasher, private balcony, elevator, doorman, near subway, no fee.
    - "suitability_score": (number 0-100) scoring guide:
        * Preferred neighborhood baseline: In LES, FiDi, East Village, or Hell's Kitchen = strong baseline (75-90) if layout & price are good.
        * Commute adjustments to 620 8th Ave:
            <= 20 min: +10 to +15 pts bonus (elite commute to Datadog office).
            21-30 min: +5 to +10 pts bonus.
            31-40 min: neutral.
            > 40 min: -15 pts penalty.
        * Score < 75 if outside preferred neighborhoods, or if major red flags exist (walk-up > 3rd floor, broker fee on already expensive unit, deceptive gross rent, railroad layout).
    `;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const result = await model.generateContent(prompt);
            return JSON.parse(result.response.text());
        } catch(e) {
            if (attempt === 1) {
                console.warn(`   ⚠️ AI Evaluation attempt 1 failed (${e.message}). Retrying in 1.5s...`);
                await new Promise(r => setTimeout(r, 1500));
            } else {
                console.error("AI Evaluation failed", e.message);
                return { 
                    true_gross_rent: listing.price, 
                    red_flags: ["AI Parse Error"], 
                    pros: [], 
                    suitability_score: 50, 
                    is_fee: false, 
                    fee_estimate: "Error",
                    neighborhood: "Manhattan",
                    is_preferred_neighborhood: false,
                    commute_minutes: 30,
                    commute_summary: "Estimated 30 mins to 620 8th Ave"
                };
            }
        }
    }
}

async function evaluateListings() {
    console.log(`[${new Date().toISOString()}] Connecting to Postgres database...`);
    
    const res = await pool.query(`SELECT * FROM listings WHERE is_evaluated = false LIMIT 3`);
    const pending = res.rows;
    
    if (pending.length === 0) {
        console.log("No pending listings to evaluate.");
        return;
    }

    console.log(`Found ${pending.length} pending listings. Launching browser to fetch full descriptions...`);
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    
    try {
        const page = await browser.newPage();

        for (const listing of pending) {
            console.log(`\n🔍 Fetching details for: ${listing.title} (${listing.url})`);
            await page.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            
            const description = await page.$$eval(".Description-block, .building-description, p, [data-test='description-text'], .font-size-9, #listing-description", els => els.map(e => e.innerText).join("\n"));
            console.log(`   Extracted description (${description.length} chars)`);

            // Extract price from page if missing
            if (!listing.price) {
                const pagePrice = await page.evaluate(() => {
                    const el = document.querySelector('[data-test="price"], .price, .PriceInfo, [class*="price"], .details_info_price');
                    return el ? el.innerText : null;
                });
                if (pagePrice) {
                    const pMatch = pagePrice.match(/\$([0-9,]+)/);
                    if (pMatch) listing.price = parseInt(pMatch[1].replace(/,/g, ''), 10);
                }
            }

            console.log(`   🧠 Sending to AI Evaluator... (Price: $${listing.price || "Unknown"})`);
            const evaluation = await runAIEvaluation(listing, description);
            
            // Hard enforcement of budget caps and floors
            const beds = parseFloat(listing.bedrooms || 0);
            const baths = parseFloat(listing.bathrooms || 0);
            if (listing.price) {
                if (listing.price < 1800) {
                    evaluation.suitability_score = 0;
                    evaluation.red_flags.push(`Price ($${listing.price}) is below minimum threshold of $1,800 (likely room share, parking, or scam)`);
                } else if (beds >= 2 && baths >= 2 && listing.price > 5000) {
                    evaluation.suitability_score = Math.min(evaluation.suitability_score, 40);
                    evaluation.red_flags.push(`Price ($${listing.price}) exceeds $5,000 budget for 2B2B`);
                } else if (beds <= 1 && listing.price > 2700) {
                    evaluation.suitability_score = Math.min(evaluation.suitability_score, 40);
                    evaluation.red_flags.push(`Price ($${listing.price}) exceeds $2,700 budget for 1B/Studio`);
                }
            } else {
                // If price is completely unknown, score cannot qualify for mobile alerts
                evaluation.suitability_score = 0;
                evaluation.red_flags.push("Price unknown or unlisted");
            }

            // Check Building Health via NYC Open Data (HPD & 311)
            const health = await checkBuildingHealth(listing.title);
            if (health) {
                if (health.isHazardous) {
                    evaluation.suitability_score = Math.max(0, evaluation.suitability_score - 20);
                    evaluation.red_flags.push(`Building Health: ${health.summary}`);
                } else if (health.grade === 'B') {
                    evaluation.suitability_score = Math.max(0, evaluation.suitability_score - 5);
                    evaluation.red_flags.push(`Building Health: ${health.summary}`);
                } else {
                    evaluation.suitability_score = Math.min(100, evaluation.suitability_score + 5);
                    evaluation.pros.push(`Building Health: ${health.summary}`);
                }
            }

            const idHash = crypto.createHash("md5").update(listing.id).digest("hex");

            await pool.query(
                `UPDATE listings SET price = $1, is_evaluated = true, true_gross_rent = $2, is_fee = $3, fee_estimate = $4, red_flags = $5, pros = $6, suitability_score = $7, neighborhood = $8, is_preferred = $9, id_hash = $10, commute_minutes = $11, commute_summary = $12, building_health = $13 WHERE id = $14`,
                [
                    listing.price,
                    evaluation.true_gross_rent || listing.price || 0, 
                    evaluation.is_fee, 
                    evaluation.fee_estimate,
                    JSON.stringify(evaluation.red_flags || []), 
                    JSON.stringify(evaluation.pros || []), 
                    evaluation.suitability_score, 
                    evaluation.neighborhood || "Manhattan",
                    evaluation.is_preferred_neighborhood || false,
                    idHash,
                    evaluation.commute_minutes || null,
                    evaluation.commute_summary || null,
                    JSON.stringify(health || {}),
                    listing.id
                ]
            );
            
            console.log(`   ✅ Score: ${evaluation.suitability_score}/100 | Gross Rent: $${evaluation.true_gross_rent} | Health: ${health.grade} (${health.summary})`);
            if (evaluation.commute_summary) {
                console.log(`   🚇 Commute: ${evaluation.commute_summary} (${evaluation.commute_minutes} mins)`);
            }
            if (evaluation.red_flags && evaluation.red_flags.length > 0) {
                console.log(`   🚨 Red Flags: ${evaluation.red_flags.join(", ")}`);
            }
            
            await new Promise(r => setTimeout(r, 2000));
        }
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    initDB().then(evaluateListings).catch(console.error);
}

module.exports = { evaluateListings };
