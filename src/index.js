const { initDB, pool } = require('./db');
const { scrapeStreetEasy } = require('./scraper');
const { evaluateListings } = require('./evaluator');
const { notifyHighScoringListings } = require('./notifier');

async function runCycle() {
    console.log(`\n======================================================`);
    console.log(`🚀 STARTING HOUSING AI CYCLE @ ${new Date().toLocaleTimeString()}`);
    console.log(`======================================================\n`);
    
    try {
        console.log("▶️ STEP 1: SCRAPING STREETEASY (STEALTH MODE)");
        await scrapeStreetEasy();
        
        console.log("\n▶️ STEP 2: RUNNING AI EVALUATOR");
        await evaluateListings();
        
        console.log("\n▶️ STEP 3: DISPATCHING MOBILE NOTIFICATIONS");
        await notifyHighScoringListings();
        
        console.log(`\n======================================================`);
        console.log(`✅ CYCLE COMPLETE.`);
        console.log(`======================================================\n`);
    } catch (err) {
        console.error("❌ Error during cycle:", err);
    }
}

if (require.main === module) {
    initDB().then(() => {
        runCycle().then(() => {
            if (process.env.DAEMON_MODE === 'true') {
                console.log("💤 Sleeping for 60 seconds before next cycle...");
                setInterval(runCycle, 60000);
            } else {
                console.log("Process exited (Single-run mode).");
                pool.end();
                process.exit(0);
            }
        });
    });
}

module.exports = { runCycle };
