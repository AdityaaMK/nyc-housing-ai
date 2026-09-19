require("dotenv").config();
const { checkBuildingHealth } = require("./building_health");
const { generateGoogleCalendarUrl } = require("./inbound_listener");
const { Api } = require("node-telegram-bot-api");
const { pool } = require("./db");
const crypto = require("crypto");

async function testBuildingHealth() {
    console.log("==================================================");
    console.log("🏥 TESTING FEATURE 2: NYC OPEN DATA BUILDING HEALTH");
    console.log("==================================================");

    const testAddresses = [
        { address: "305 W 50th St", borough: "Manhattan", desc: "Clean luxury Hell's Kitchen building" },
        { address: "2040 7th Ave", borough: "Manhattan", desc: "Older Central Harlem apartment building" }
    ];

    for (const item of testAddresses) {
        console.log(`\n🔍 Checking address: "${item.address}, ${item.borough}" (${item.desc})...`);
        const result = await checkBuildingHealth(item.address, item.borough);
        console.log(`   Grade: ${result.grade}`);
        console.log(`   Summary: ${result.summary}`);
        console.log(`   Open Class C Violations: ${result.classC}`);
        console.log(`   Heat/Hot Water Outages (last 12m): ${result.heatComplaints}`);
        console.log(`   Bedbug Reports (last 12m): ${result.bedbugReports}`);
        console.log(`   Hazardous Flag: ${result.isHazardous}`);
    }
}

async function sendTestTourAlert() {
    console.log("\n==================================================");
    console.log("📅 TESTING FEATURE 1: INBOUND TOUR & CALENDAR ALERT");
    console.log("==================================================");

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.error("❌ Telegram bot token or chat ID missing in .env");
        return;
    }

    const bot = new Api(token);

    // Realistic upcoming tour time: tomorrow at 5:30 PM NYC Eastern
    const startTime = new Date();
    startTime.setDate(startTime.getDate() + 1);
    startTime.setHours(17, 30, 0, 0);
    const endTime = new Date(startTime.getTime() + 45 * 60 * 1000);

    const humanTime = startTime.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });

    const listingAddress = "350 W 50th St #4B, Hell's Kitchen";
    const brokerName = "Sarah Jenkins (Compass)";
    const brokerEmail = process.env.TENANT_EMAIL || "adityaa.magesh@gmail.com"; // Test to own email
    const specialInstructions = "Buzz unit 4B upon arrival. Bring government photo ID.";
    const summary = "Offered an in-person showing slot tomorrow afternoon.";

    const calendarUrl = generateGoogleCalendarUrl({
        title: listingAddress,
        startTime,
        endTime,
        location: "350 W 50th St, New York, NY 10019",
        details: `Broker: ${brokerName} (${brokerEmail})\nInstructions: ${specialInstructions}\nSummary: ${summary}`
    });

    // Create a unique tour ID in DB so tapping the button confirms it
    const tourId = "test_" + crypto.randomBytes(4).toString("hex");

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tour_schedules (
                id TEXT PRIMARY KEY,
                listing_address TEXT,
                broker_email TEXT,
                broker_name TEXT,
                proposed_time TEXT,
                special_instructions TEXT,
                status TEXT DEFAULT 'proposed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`
            INSERT INTO tour_schedules (id, listing_address, broker_email, broker_name, proposed_time, special_instructions)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id) DO NOTHING
        `, [
            tourId,
            listingAddress,
            brokerEmail,
            brokerName,
            humanTime,
            specialInstructions
        ]);
    } catch (err) {
        console.warn("DB note:", err.message);
    }

    const telegramMessage = `📅 <b>[TEST] TOUR INVITATION RECEIVED!</b>\n\n` +
                            `🏢 <b>Listing:</b> ${listingAddress}\n` +
                            `🕒 <b>Time:</b> <code>${humanTime}</code>\n` +
                            `👤 <b>From:</b> ${brokerName}\n` +
                            `📝 <b>Instructions:</b> ${specialInstructions}\n\n` +
                            `💬 <i>"Hi Adityaa, I have an open slot for an in-person showing tomorrow at 5:30 PM. Let me know if that works!"</i>\n\n` +
                            `👇 <i>Tap below to test 1-click Google Calendar or confirm tour:</i>`;

    console.log(`📱 Sending test tour alert to Telegram chat: ${chatId}...`);

    await bot.sendMessage({
        chat_id: chatId,
        text: telegramMessage,
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📅 Add to Google Calendar", url: calendarUrl }],
                [{ text: "✅ Confirm Tour with Broker", callback_data: `confirm_tour_${tourId}` }]
            ]
        }
    });

    console.log("✅ Test tour notification dispatched to your Telegram!");
    console.log("👉 Check Telegram: you can tap 'Add to Google Calendar' or 'Confirm Tour with Broker'.");
}

async function sendTestNudgeAlert() {
    console.log("\n==================================================");
    console.log("⏰ TESTING FEATURE: 24-HOUR BROKER NUDGE ALERT");
    console.log("==================================================");

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.error("❌ Telegram credentials missing in .env");
        return;
    }

    const bot = new Api(token);
    const testId = "test_nudge_" + crypto.randomBytes(4).toString("hex");
    const brokerEmail = process.env.TENANT_EMAIL || "adityaa.magesh@gmail.com";
    const title = "350 W 50th St #4B, Hell's Kitchen";
    const price = 4800;

    // Create a mock listing in DB that was applied 26 hours ago
    try {
        await pool.query(`
            INSERT INTO listings (id, url, title, price, bedrooms, bathrooms, status, broker_email, applied_at, nudge_notified, nudge_count)
            VALUES ($1, $2, $3, $4, 2, 2, 'applied', $5, NOW() - INTERVAL '26 HOURS', true, 0)
            ON CONFLICT (id) DO UPDATE SET status = 'applied', broker_email = $5, applied_at = NOW() - INTERVAL '26 HOURS', nudge_count = 0
        `, [
            testId,
            "https://compass.com/test-listing",
            title,
            price,
            brokerEmail
        ]);
    } catch (e) {
        console.warn("DB note:", e.message);
    }

    const message = `⏰ <b>[TEST] BROKER FOLLOW-UP NUDGE</b>\n\n` +
                    `🏢 <b>Listing:</b> <b>${title}</b> ($${price.toLocaleString()}/mo)\n` +
                    `👤 <b>Broker Email:</b> <code>${brokerEmail}</code>\n` +
                    `⏳ <b>Waiting:</b> 26 hours since initial application with no reply.\n\n` +
                    `<i>NYC brokers often get 50+ inquiries daily. Tap below to send a polite follow-up emphasizing that your 800+ credit & 40x income paperwork is ready to view:</i>`;

    console.log(`📱 Sending test nudge alert to Telegram chat: ${chatId}...`);

    await bot.sendMessage({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📨 Send 1-Tap Follow-Up Nudge", callback_data: `nudge_${testId}` }],
                [{ text: "❌ Don't Nudge", callback_data: `skip_nudge_${testId}` }]
            ]
        }
    });

    console.log("✅ Test nudge alert dispatched to your Telegram!");
    console.log("👉 Check Telegram: tap 'Send 1-Tap Follow-Up Nudge' to test live follow-up dispatch.");
}

async function main() {
    const mode = process.argv[2] || "all";
    if (mode === "health" || mode === "all") {
        await testBuildingHealth();
    }
    if (mode === "tour" || mode === "all") {
        await sendTestTourAlert();
    }
    if (mode === "nudge" || mode === "all") {
        await sendTestNudgeAlert();
    }
    await pool.end();
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { testBuildingHealth, sendTestTourAlert, sendTestNudgeAlert };

