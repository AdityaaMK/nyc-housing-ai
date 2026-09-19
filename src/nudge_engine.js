require("dotenv").config();
const { pool } = require("./db");
const { sendBrokerEmail } = require("./mailer");
const { Api } = require("node-telegram-bot-api");
const crypto = require("crypto");

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function generateNudgeEmail(listing) {
    const tenantName = process.env.TENANT_NAME || "Adityaa Magesh Kumar";
    const tenantPhone = process.env.TENANT_PHONE || "732-309-5089";
    const tenantEmail = process.env.TENANT_EMAIL || "adityaa.magesh@gmail.com";
    const credit = process.env.TENANT_CREDIT || "800+";
    const income = process.env.TENANT_INCOME || "Verified 40x+ rent";

    const subject = `Following up: Tour & Application Ready - ${listing.title} - ${tenantName}`;
    const body = `Hi,\n\n` +
                 `I wanted to follow up on my inquiry from yesterday regarding ${listing.title}.\n\n` +
                 `I remain very interested in the apartment. My full tenant application file is compiled and ready for immediate submission:\n` +
                 `• Credit Score: ${credit}\n` +
                 `• Annual Income: ${income}\n` +
                 `• Documents: Paystubs, W-2s, bank statements, and photo ID ready to submit upon viewing.\n\n` +
                 `Could we schedule an in-person or video showing today or tomorrow? I can accommodate your schedule.\n\n` +
                 `Looking forward to hearing from you!\n\n` +
                 `Best regards,\n` +
                 `${tenantName}\n` +
                 `${tenantEmail} | ${tenantPhone}`;

    return { subject, body };
}

async function checkPendingNudges(botApi, chatId) {
    const targetChatId = chatId || process.env.TELEGRAM_CHAT_ID;
    const api = botApi || (process.env.TELEGRAM_BOT_TOKEN ? new Api(process.env.TELEGRAM_BOT_TOKEN) : null);

    if (!api || !targetChatId) return;

    try {
        // Find listings applied 24+ hours ago with no response, broker email known, not yet nudged
        let res;
        try {
            res = await pool.query(`
                SELECT * FROM listings 
                WHERE status = 'applied'
                  AND broker_email IS NOT NULL
                  AND (nudge_notified IS NULL OR nudge_notified = false)
                  AND (nudge_count IS NULL OR nudge_count = 0)
                  AND applied_at IS NOT NULL
                  AND applied_at <= NOW() - INTERVAL '24 HOURS'
                LIMIT 5
            `);
        } catch(e) {
            // Fallback SQLite datetime syntax if needed
            res = await pool.query(`
                SELECT * FROM listings 
                WHERE status = 'applied'
                  AND broker_email IS NOT NULL
                  AND (nudge_notified IS NULL OR nudge_notified = 0)
                  AND (nudge_count IS NULL OR nudge_count = 0)
                  AND applied_at IS NOT NULL
                  AND applied_at <= datetime('now', '-24 hours')
                LIMIT 5
            `);
        }

        const pending = res ? res.rows : [];
        if (pending.length === 0) return;

        console.log(`⏰ [Nudge Engine] Found ${pending.length} listing(s) pending broker follow-up.`);

        for (const listing of pending) {
            const actionId = listing.id_hash || 
                (listing.id.length > 50 ? crypto.createHash("md5").update(listing.id).digest("hex") : listing.id);

            const message = `⏰ <b>BROKER FOLLOW-UP NUDGE</b>\n\n` +
                            `🏢 <b>Listing:</b> <b>${escapeHtml(listing.title)}</b> ($${Number(listing.price).toLocaleString()}/mo)\n` +
                            `👤 <b>Broker Email:</b> <code>${escapeHtml(listing.broker_email)}</code>\n` +
                            `⏳ <b>Waiting:</b> 24+ hours with no response.\n\n` +
                            `<i>Brokers in NYC get buried under dozens of inquiries daily. Tap below to bump your application to the top of their inbox with an updated, polite follow-up:</i>`;

            await api.sendMessage({
                chat_id: targetChatId,
                text: message,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📨 Send 1-Tap Follow-Up Nudge", callback_data: `nudge_${actionId}` }],
                        [{ text: "❌ Don't Nudge", callback_data: `skip_nudge_${actionId}` }]
                    ]
                }
            });

            // Mark nudge_notified = true so we don't duplicate notifications
            await pool.query(`UPDATE listings SET nudge_notified = true WHERE id = $1`, [listing.id]);
            console.log(`📱 Dispatched nudge prompt for: ${listing.title} to broker ${listing.broker_email}`);
        }
    } catch (err) {
        console.warn("⚠️ Nudge engine check error:", err.message);
    }
}

async function sendNudge(actionId) {
    try {
        const res = await pool.query(
            `SELECT * FROM listings WHERE id = $1 OR id_hash = $1 OR md5(id) = $1 LIMIT 1`,
            [actionId]
        );
        const listing = res.rows[0];
        if (!listing) return { success: false, reason: "Listing not found in database." };

        const brokerEmail = listing.broker_email;
        if (!brokerEmail) {
            return { success: false, reason: "No broker email recorded for this listing." };
        }

        const { subject, body } = generateNudgeEmail(listing);

        await sendBrokerEmail({
            to: brokerEmail,
            subject,
            body
        });

        await pool.query(
            `UPDATE listings SET nudged_at = CURRENT_TIMESTAMP, nudge_count = COALESCE(nudge_count, 0) + 1 WHERE id = $1`,
            [listing.id]
        );

        console.log(`✅ [Nudge Engine] Follow-up sent to ${brokerEmail} for "${listing.title}"`);
        return { success: true, listing, recipient: brokerEmail };
    } catch (err) {
        console.error("Error dispatching nudge email:", err.message);
        return { success: false, reason: err.message };
    }
}

async function skipNudge(actionId) {
    try {
        await pool.query(
            `UPDATE listings SET nudge_count = 1 WHERE id = $1 OR id_hash = $1 OR md5(id) = $1`,
            [actionId]
        );
        return { success: true };
    } catch (err) {
        return { success: false, reason: err.message };
    }
}

module.exports = {
    checkPendingNudges,
    generateNudgeEmail,
    sendNudge,
    skipNudge
};
