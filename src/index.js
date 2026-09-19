const { initDB, pool } = require('./db');
const { scrapeStreetEasy } = require('./scraper');
const { evaluateListings } = require('./evaluator');
const { notifyHighScoringListings } = require('./notifier');
const { startBot } = require('./bot');
const { checkInboundReplies } = require('./inbound_listener');
const { checkPendingNudges } = require('./nudge_engine');

let isRunning = false;
let shouldStop = false;
let botInstance = null;

async function runCycle() {
    if (isRunning) return;
    isRunning = true;
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
        
        console.log("\n▶️ STEP 4: CHECKING INBOUND BROKER REPLIES & TOURS");
        await checkInboundReplies(botInstance?.api || botInstance, process.env.TELEGRAM_CHAT_ID);

        console.log("\n▶️ STEP 5: SCANNING FOR UNANSWERED INQUIRIES & NUDGES");
        await checkPendingNudges(botInstance?.api || botInstance, process.env.TELEGRAM_CHAT_ID);

        console.log(`\n======================================================`);
        console.log(`✅ CYCLE COMPLETE.`);
        console.log(`======================================================\n`);
    } catch (err) {
        console.error("❌ Error during cycle:", err);
    } finally {
        isRunning = false;
    }
}

async function startDaemon() {
    const intervalSec = parseInt(process.env.CYCLE_INTERVAL_SECONDS, 10) || 180; // 3 minutes default
    console.log(`🤖 NYC Housing AI Daemon initialized. Polling interval: ${intervalSec} seconds (${intervalSec / 60} mins)`);
    
    while (!shouldStop) {
        await runCycle();
        if (shouldStop) break;
        console.log(`💤 Sleeping for ${intervalSec} seconds before next cycle...`);
        await new Promise(r => setTimeout(r, intervalSec * 1000));
    }
    console.log("🛑 Daemon stopped cleanly.");
    await pool.end();
    process.exit(0);
}

process.on('SIGINT', async () => {
    console.log("\nReceived SIGINT. Shutting down gracefully...");
    shouldStop = true;
    if (!isRunning) {
        await pool.end();
        process.exit(0);
    }
});

process.on('SIGTERM', async () => {
    console.log("\nReceived SIGTERM. Shutting down gracefully...");
    shouldStop = true;
    if (!isRunning) {
        await pool.end();
        process.exit(0);
    }
});

if (require.main === module) {
    initDB().then(async () => {
        botInstance = await startBot();
        if (process.env.DAEMON_MODE === 'true') {
            startDaemon();
        } else {
            runCycle().then(() => {
                console.log("Process exited (Single-run mode). To run continuously, set DAEMON_MODE=true");
                pool.end();
                process.exit(0);
            });
        }
    });
}

module.exports = { runCycle };
