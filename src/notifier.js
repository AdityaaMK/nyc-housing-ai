const { repository } = require('./repository');
require("dotenv").config();
const { buildListingAlert, eligibleForAlert } = require('./telegram_messages');
const { Api } = require("node-telegram-bot-api");
const { initDB } = require("./db");

const { matchesPreferences } = require('./preferences');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;
if (token) {
    bot = new Api(token);
}

async function notifyHighScoringListings() {
    const products = require('./product_services').getProductServices();
    const preferences = await products.preferences.get();
    const res = await repository.pendingNotifications();
    const pending = await products.enrichListings(res.rows);
    
    if (pending.length === 0) {
        console.log("No new evaluated listings to notify.");
        return;
    }

    console.log(`Found ${pending.length} listings to review for mobile alerts (threshold >= 75)...`);

    for (const listing of pending) {
        if (listing.status !== 'inbox') continue;
        const score = listing.suitability_score || 0;
        // Never let score bonuses or a stale model-generated flag override saved locations.
        listing.is_preferred = matchesPreferences(listing, preferences);
        if (!listing.is_preferred) {
            console.log(`   Skipping alert outside saved locations: ${listing.title}`);
            continue;
        }
        
        if (!eligibleForAlert(listing, preferences)) {
            console.log('Skipping an ineligible or outdated listing alert.');
            continue;
        }

        const { text: message, reply_markup: keyboard } = buildListingAlert(listing);

        if (bot && chatId) {
            try {
                await bot.sendMessage({
                    chat_id: chatId,
                    text: message,
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
                console.log(`📱 Sent Telegram alert for listing ${listing.id} (Score: ${score}/100)`);
            } catch (e) {
                console.error(`Failed to send Telegram message:`, e.message);
                continue;
            }
        } else {
            console.log(`\n[MOCK PUSH NOTIFICATION TO PHONE]`);
            console.log(message.replace(/<[^>]*>?/gm, "")); 
            console.log(`[Buttons: View Listing | ✉️ Send Intro Packet | ❌ Pass]`);
            continue;
        }

        await repository.markNotified(listing.id);
    }
}

if (require.main === module) {
    initDB().then(notifyHighScoringListings).catch(console.error);
}
module.exports = { notifyHighScoringListings };
