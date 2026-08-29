require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { initDB, pool } = require("./db");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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
        model: "gemini-1.5-flash",
        generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
    You are an expert NYC Real Estate AI Assistant.
    Evaluate this apartment listing based on its description.
    
    Listing Title: ${listing.title}
    Advertised Price: $${listing.price || "Unknown"}
    
    Description:
    ${description}
    
    Analyze the description and output a JSON object with the following exact keys:
    - "true_gross_rent": (number) calculate the actual monthly rent you must pay. If the description mentions "net effective" or "X months free", figure out the gross rent. If not, use the advertised price.
    - "is_fee": (boolean) true if the description mentions a broker fee, tenant pays fee, or 15%. False if it explicitly says no fee.
    - "fee_estimate": (string) e.g., "15% of annual" or "1 month rent" or "None".
    - "red_flags": (array of strings) extract any negative aspects: walk-up above 3rd floor, basement, railroad layout, flex/no real windows, fake amenities.
    - "pros": (array of strings) extract positive aspects: in-unit laundry, natural light, no fee, doorman.
    - "suitability_score": (number 0-100) based on your expert opinion of NYC real estate. Penalize heavily for hidden fees, high walk-ups, or net-effective traps.
    `;

    try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch(e) {
        console.error("AI Evaluation failed", e.message);
        return { true_gross_rent: listing.price, red_flags: ["AI Parse Error"], pros: [], suitability_score: 50, is_fee: false, fee_estimate: "Error" };
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
            
            const description = await page.$$eval(".Description-block, .building-description, p, [data-test='description-text']", els => els.map(e => e.innerText).join("\n"));
            console.log(`   Extracted description (${description.length} chars)`);

            console.log(`   🧠 Sending to AI Evaluator...`);
            const evaluation = await runAIEvaluation(listing, description);
            
            await pool.query(
                `UPDATE listings SET is_evaluated = true, true_gross_rent = $1, is_fee = $2, fee_estimate = $3, red_flags = $4, pros = $5, suitability_score = $6 WHERE id = $7`,
                [
                    evaluation.true_gross_rent, 
                    evaluation.is_fee, 
                    evaluation.fee_estimate,
                    JSON.stringify(evaluation.red_flags), 
                    JSON.stringify(evaluation.pros),
                    evaluation.suitability_score, 
                    listing.id
                ]
            );
            
            console.log(`   ✅ Score: ${evaluation.suitability_score}/100 | Gross Rent: $${evaluation.true_gross_rent} | Fee: ${evaluation.fee_estimate}`);
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
