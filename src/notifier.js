require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { initDB, pool } = require("./db");

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;
if (token) {
    bot = new TelegramBot(token, {polling: false});
}

async function notifyHighScoringListings() {
    const res = await pool.query(`SELECT * FROM listings WHERE is_evaluated = true AND is_notified = false`);
    const pending = res.rows;
    
    if (pending.length === 0) {
        console.log("No new evaluated listings to notify.");
        return;
    }

    console.log(`Found ${pending.length} listings to push to mobile...`);

    for (const listing of pending) {
        let redFlags = "None";
        let pros = "None";
        try { if (listing.red_flags) redFlags = JSON.parse(listing.red_flags).join(", "); } catch(e){}
        try { if (listing.pros) pros = JSON.parse(listing.pros).join(", "); } catch(e){}
        
        const feeText = listing.is_fee ? `Yes (${listing.fee_estimate})` : "No Fee 💸";
        const title = listing.title || "Unknown Apartment";
        const price = listing.price || "Unknown";
        const gross = listing.true_gross_rent || listing.price;
        const score = listing.suitability_score || "N/A";
        
        const message = `🚨 <b>NEW MATCH: ${title}</b>\n` +
                        `💰 <b>Price:</b> $${price} ` + 
                        `(<i>Gross: $${gross}</i>)\n` +
                        `🛏 <b>Bed:</b> ${listing.bedrooms} | 🛁 <b>Bath:</b> ${listing.bathrooms}\n` +
                        `⚠️ <b>Broker Fee:</b> ${feeText}\n\n` +
                        `🚩 <b>Red Flags:</b> ${redFlags || "None"}\n` +
                        `✅ <b>Pros:</b> ${pros || "None"}\n\n` +
                        `📊 <b>AI Suitability Score:</b> ${score}/100`;

        const keyboard = {
            inline_keyboard: [
                [{ text: "🌐 View on StreetEasy", url: listing.url }],
                [
                    { text: "✉️ Send Intro Packet", callback_data: `apply_${listing.id}` },
                    { text: "❌ Pass", callback_data: `pass_${listing.id}` }
                ]
            ]
        };

        if (bot && chatId) {
            try {
                await bot.sendMessage(chatId, message, { parse_mode: "HTML", reply_markup: keyboard });
                console.log(`📱 Sent Telegram alert for: ${title}`);
            } catch (e) {
                console.error(`Failed to send Telegram message:`, e.message);
            }
        } else {
            console.log(`\n[MOCK PUSH NOTIFICATION TO PHONE]`);
            console.log(message.replace(/<[^>]*>?/gm, "")); 
            console.log(`[Buttons: View Listing | ✉️ Send Intro Packet | ❌ Pass]`);
        }

        await pool.query(`UPDATE listings SET is_notified = true WHERE id = $1`, [listing.id]);
    }
}

if (require.main === module) {
    initDB().then(notifyHighScoringListings).catch(console.error);
}
module.exports = { notifyHighScoringListings };
