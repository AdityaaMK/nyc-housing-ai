require("dotenv").config();
const crypto = require("crypto");
const { Api } = require("node-telegram-bot-api");
const { initDB, pool } = require("./db");

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;
if (token) {
    bot = new Api(token);
}

async function notifyHighScoringListings() {
    const res = await pool.query(`SELECT * FROM listings WHERE is_evaluated = true AND is_notified = false`);
    const pending = res.rows;
    
    if (pending.length === 0) {
        console.log("No new evaluated listings to notify.");
        return;
    }

    console.log(`Found ${pending.length} listings to review for mobile alerts (threshold >= 75)...`);

    for (const listing of pending) {
        const score = listing.suitability_score || 0;
        
        // Only buzz phone if score is above 75 AND price is at least $1,800!
        if (score < 75 || !listing.price || listing.price < 1800) {
            console.log(`   ⏭️ Skipping Telegram buzz for "${listing.title}": ${!listing.price ? "Price unknown" : listing.price < 1800 ? `Price ($${listing.price}) < $1,800 minimum` : `Score ${score}/100 is below 75 threshold`}.`);
            await pool.query(`UPDATE listings SET is_notified = true WHERE id = $1`, [listing.id]);
            continue;
        }

        let redFlags = "None";
        let pros = "None";
        try { if (listing.red_flags) redFlags = JSON.parse(listing.red_flags).join(", "); } catch(e){}
        try { if (listing.pros) pros = JSON.parse(listing.pros).join(", "); } catch(e){}
        
        function esc(s) {
            if (!s) return "";
            return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        const feeText = esc(listing.is_fee ? `Yes (${listing.fee_estimate})` : "No Fee 💸");
        const title = esc(listing.title || "Unknown Apartment");
        const priceStr = `$${Number(listing.price).toLocaleString()}`;
        const grossStr = (listing.true_gross_rent && listing.true_gross_rent > 0)
            ? `$${Number(listing.true_gross_rent).toLocaleString()}`
            : priceStr;
        const neighborhoodTag = listing.neighborhood 
            ? `\n📍 <b>Neighborhood:</b> ${esc(listing.neighborhood)} ${listing.is_preferred ? "⭐ (Preferred)" : ""}`
            : "";
        
        const sourceName = listing.source === 'renthop' ? 'RentHop' : 'StreetEasy';
        const sourceBadge = `\n🌐 <b>Source:</b> ${sourceName}`;

        const commuteInfo = listing.commute_summary
            ? `\n🚇 <b>Commute to 620 8th Ave:</b> ${esc(listing.commute_summary)}`
            : (listing.commute_minutes ? `\n🚇 <b>Commute to 620 8th Ave:</b> ~${listing.commute_minutes} mins` : "");

        let buildingHealthBadge = "";
        try {
            if (listing.building_health) {
                const bh = JSON.parse(listing.building_health);
                if (bh.summary) {
                    buildingHealthBadge = `\n🏥 <b>Building Health:</b> ${esc(bh.summary)}`;
                }
            }
        } catch(e) {}

        const message = `🚨 <b>NEW MATCH: ${title}</b>\n` +
                        `💰 <b>Price:</b> ${priceStr} ` + 
                        `(<i>Gross: ${grossStr}</i>)\n` +
                        `🛏 <b>Bed:</b> ${listing.bedrooms} | 🛁 <b>Bath:</b> ${listing.bathrooms}` +
                        `${neighborhoodTag}` +
                        `${sourceBadge}` +
                        `${commuteInfo}` +
                        `${buildingHealthBadge}\n` +
                        `⚠️ <b>Broker Fee:</b> ${feeText}\n\n` +
                        `🚩 <b>Red Flags:</b> ${esc(redFlags || "None")}\n` +
                        `✅ <b>Pros:</b> ${esc(pros || "None")}\n\n` +
                        `📊 <b>AI Suitability Score:</b> ${score}/100`;

        const actionId = listing.id_hash 
            ? listing.id_hash 
            : (listing.id.length > 50 ? crypto.createHash("md5").update(listing.id).digest("hex") : listing.id);

        const inlineButtons = [
            [{ text: `🌐 View on ${sourceName}`, url: listing.url }]
        ];

        // Add buttons for cross-posted sources if any
        try {
            if (listing.cross_posted_sources) {
                const cross = JSON.parse(listing.cross_posted_sources);
                for (const c of cross) {
                    const cName = c.source === 'renthop' ? 'RentHop' : 'StreetEasy';
                    inlineButtons.push([{ text: `🔗 Also listed on ${cName}`, url: c.url }]);
                }
            }
        } catch(e) {}

        inlineButtons.push([
            { text: "✉️ Send Intro Packet", callback_data: `apply_${actionId}` },
            { text: "❌ Pass", callback_data: `pass_${actionId}` }
        ]);

        const keyboard = {
            inline_keyboard: inlineButtons
        };

        if (bot && chatId) {
            try {
                await bot.sendMessage({
                    chat_id: chatId,
                    text: message,
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
                console.log(`📱 Sent Telegram alert for: ${title} (Score: ${score}/100)`);
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
