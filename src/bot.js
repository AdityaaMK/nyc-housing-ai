require("dotenv").config();
const { Bot } = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { pool, initDB } = require("./db");
const { submitInquiry } = require("./auto_inquire");
const { confirmTourBooking } = require("./inbound_listener");
const { sendNudge, skipNudge } = require("./nudge_engine");

const token = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;

async function generateIntroPacket(listing) {
    const tenantProfile = {
        name: process.env.TENANT_NAME || "Adityaa Magesh Kumar",
        credit: process.env.TENANT_CREDIT || "800+",
        income: process.env.TENANT_INCOME || "Verified 40x+ rent",
        pets: process.env.TENANT_PETS || "None",
        moveIn: process.env.TENANT_MOVE_IN || "Immediate / Flexible",
        commuteTarget: process.env.TARGET_COMMUTE_ADDRESS || "Datadog Office (620 8th Ave, NYT Building, NYC)",
        email: process.env.TENANT_EMAIL || "adityaa.magesh@gmail.com",
        phone: process.env.TENANT_PHONE || "732-309-5089"
    };

    if (!process.env.GEMINI_API_KEY) {
        return `Subject: Tour Request & Application Ready: ${listing.title}\n\n` +
               `Hi,\n\n` +
               `I am very interested in viewing ${listing.title} listed for $${Number(listing.price).toLocaleString()}/month.\n\n` +
               `A quick summary of my tenant qualifications:\n` +
               `• Tenant: ${tenantProfile.name}\n` +
               `• Credit Score: ${tenantProfile.credit}\n` +
               `• Income: ${tenantProfile.income}\n` +
               `• Move-in Date: ${tenantProfile.moveIn}\n` +
               `• Pets: ${tenantProfile.pets}\n` +
               `• Documentation: 100% complete (paystubs, W-2s, bank statements, photo ID ready for immediate submission).\n\n` +
               `I am available for an in-person tour today or tomorrow at your convenience. Looking forward to hearing from you!\n\n` +
               `Best regards,\n${tenantProfile.name}\n${tenantProfile.email} | ${tenantProfile.phone}`;
    }

    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });

        const prompt = `
You are an expert NYC real estate agent writing a high-converting, polite, and persuasive outreach message for a prime prospective tenant.

Apartment Details:
- Title: ${listing.title}
- Price: $${Number(listing.price).toLocaleString()}/month
- Neighborhood: ${listing.neighborhood || "Manhattan"}
- URL: ${listing.url}

Tenant Profile:
- Name: ${tenantProfile.name}
- Email: ${tenantProfile.email}
- Phone: ${tenantProfile.phone}
- Credit Score: ${tenantProfile.credit}
- Annual Income: ${tenantProfile.income}
- Move-in Date: ${tenantProfile.moveIn}
- Pets: ${tenantProfile.pets}
- Paperwork: Fully compiled and ready (recent paystubs, W-2s, bank statements, government photo ID)
- Workplace: Working near ${tenantProfile.commuteTarget}

Requirements:
- Write an inquiry suitable for StreetEasy/RentHop message box or email.
- Include a clear Subject Line.
- Mention specific enthusiasm for this apartment.
- Highlight clean financial qualifications clearly with bullet points so a broker immediately prioritizes this inquiry.
- Ask for an in-person or video tour at their earliest availability.
- Sign off with tenant's actual name (${tenantProfile.name}), email (${tenantProfile.email}), and phone (${tenantProfile.phone}). Never use placeholder brackets like [Your Name] or [Your Phone Number].
- Do not output markdown code fences (like \`\`\`), output clean text.
`;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (err) {
        console.error("Error generating intro packet with Gemini:", err.message);
        return `Subject: Rental Application & Tour Request: ${listing.title}\n\n` +
               `Hi,\n\n` +
               `I am very interested in viewing ${listing.title} ($${Number(listing.price).toLocaleString()}/mo).\n\n` +
               `Tenant Qualifications:\n` +
               `• Name: ${tenantProfile.name}\n` +
               `• Credit Score: ${tenantProfile.credit}\n` +
               `• Income: ${tenantProfile.income}\n` +
               `• Move-in: ${tenantProfile.moveIn}\n` +
               `• Pets: ${tenantProfile.pets}\n` +
               `• Documents: Paystubs, W-2s, bank statements, and photo ID ready for immediate submission.\n\n` +
               `Could we schedule a tour at your earliest convenience?\n\n` +
               `Best,\n${tenantProfile.name}`;
    }
}

function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function setupBotHandlers(botInstance) {
    botInstance.on("callback_query", async (ctx) => {
        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData) return;

        console.log(`🔘 Received Telegram callback: "${callbackData}" from user: ${ctx.from?.username || ctx.from?.id}`);

        if (callbackData.startsWith("pass_")) {
            const actionId = callbackData.replace("pass_", "");
            try {
                await pool.query(
                    `UPDATE listings SET status = 'passed' WHERE id = $1 OR id_hash = $1`,
                    [actionId]
                );
                await ctx.answerCallbackQuery({ text: "❌ Passed! Saved to your passed list." });
                await ctx.reply("❌ <i>Marked listing as passed. It won't be recommended again.</i>", {
                    parse_mode: "HTML"
                });
            } catch (err) {
                console.error("Error updating passed listing:", err.message);
                await ctx.answerCallbackQuery({ text: "Error recording pass." });
            }
        } else if (callbackData.startsWith("apply_")) {
            const actionId = callbackData.replace("apply_", "");
            try {
                await ctx.answerCallbackQuery({ text: "✍️ Generating customized Intro Packet..." });

                const res = await pool.query(
                    `SELECT * FROM listings WHERE id = $1 OR id_hash = $1 OR md5(id) = $1 LIMIT 1`,
                    [actionId]
                );
                const listing = res.rows[0];

                if (!listing) {
                    await ctx.reply("⚠️ Could not find listing details in database.");
                    return;
                }

                await pool.query(
                    `UPDATE listings SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = $1 OR id_hash = $1 OR md5(id) = $1`,
                    [actionId]
                );

                const introPacket = await generateIntroPacket(listing);

                // Attempt automated headless submission
                console.log(`🤖 Attempting auto-inquiry for: ${listing.title}`);
                const autoResult = await submitInquiry(listing, introPacket);

                if (autoResult && autoResult.recipient) {
                    await pool.query(
                        `UPDATE listings SET broker_email = $1 WHERE id = $2 OR id_hash = $2 OR md5(id) = $2`,
                        [autoResult.recipient, actionId]
                    );
                }

                let statusBadge = "";
                if (autoResult.success) {
                    if (autoResult.method === "email") {
                        statusBadge = `📧 <b>SUCCESS: DIRECT EMAIL SENT TO BROKER!</b>\n` +
                                      `• <b>To:</b> <code>${escapeHtml(autoResult.recipient)}</code>\n` +
                                      `• <b>From:</b> <code>${escapeHtml(process.env.GMAIL_USER)}</code>\n` +
                                      `• <b>BCC:</b> Sent to your inbox for tracking\n\n`;
                    } else {
                        statusBadge = `🚀 <b>SUCCESS: AUTO-SUBMITTED ON PORTAL!</b>\n<i>Our runner submitted your contact info and intro packet directly on the listing page.</i>\n\n`;
                    }
                } else {
                    statusBadge = `⚠️ <i>Auto-dispatch note: ${escapeHtml(autoResult.reason)}</i>\n\n`;
                }

                const replyMsg = `${statusBadge}` +
                                 `📋 <b>CUSTOMIZED INTRO PACKET FOR:</b>\n` +
                                 `🏢 <b>${escapeHtml(listing.title)}</b> ($${Number(listing.price).toLocaleString()}/mo)\n` +
                                 `🌐 <a href="${listing.url}">View Listing</a>\n\n` +
                                 `<pre>${escapeHtml(introPacket)}</pre>\n\n` +
                                 `<i>💡 Tap the box above on mobile to copy and paste directly into StreetEasy, RentHop, or email if needed!</i>`;

                await ctx.reply(replyMsg, { parse_mode: "HTML" });
            } catch (err) {
                console.error("Error handling apply action:", err.message);
                await ctx.answerCallbackQuery({ text: "Error generating intro packet." });
            }
        } else if (callbackData.startsWith("confirm_tour_")) {
            const tourId = callbackData.replace("confirm_tour_", "");
            try {
                await ctx.answerCallbackQuery({ text: "⏳ Confirming tour with broker..." });
                const res = await confirmTourBooking(tourId);
                if (res.success) {
                    await ctx.reply(
                        `✅ <b>TOUR CONFIRMED!</b>\n\n` +
                        `Sent confirmation email to broker <code>${escapeHtml(res.tour.broker_email)}</code> for <b>${escapeHtml(res.tour.proposed_time)}</b> at <b>${escapeHtml(res.tour.listing_address)}</b>.\n\n` +
                        `<i>A confirmation copy has been sent to your Gmail inbox.</i>`,
                        { parse_mode: "HTML" }
                    );
                } else {
                    await ctx.reply(`⚠️ Could not confirm tour: ${escapeHtml(res.reason)}`, { parse_mode: "HTML" });
                }
            } catch (err) {
                console.error("Error confirming tour:", err.message);
                await ctx.answerCallbackQuery({ text: "Error confirming tour." });
            }
        } else if (callbackData.startsWith("nudge_")) {
            const actionId = callbackData.replace("nudge_", "");
            try {
                await ctx.answerCallbackQuery({ text: "📨 Sending follow-up nudge to broker..." });
                const res = await sendNudge(actionId);
                if (res.success) {
                    await ctx.reply(
                        `✅ <b>FOLLOW-UP NUDGE SENT!</b>\n\n` +
                        `Dispatched polite follow-up email to broker <code>${escapeHtml(res.recipient)}</code> for <b>${escapeHtml(res.listing.title)}</b>.\n\n` +
                        `<i>A copy has been delivered to your Gmail inbox.</i>`,
                        { parse_mode: "HTML" }
                    );
                } else {
                    await ctx.reply(`⚠️ Could not send nudge: ${escapeHtml(res.reason)}`, { parse_mode: "HTML" });
                }
            } catch (err) {
                console.error("Error sending nudge:", err.message);
                await ctx.answerCallbackQuery({ text: "Error sending nudge." });
            }
        } else if (callbackData.startsWith("skip_nudge_")) {
            const actionId = callbackData.replace("skip_nudge_", "");
            try {
                await skipNudge(actionId);
                await ctx.answerCallbackQuery({ text: "❌ Nudge dismissed." });
                await ctx.reply("❌ <i>Follow-up nudge dismissed for this listing.</i>", { parse_mode: "HTML" });
            } catch (err) {
                await ctx.answerCallbackQuery({ text: "Error dismissing nudge." });
            }
        }
    });

    botInstance.catch((err, ctx) => {
        console.error("Telegram bot error encountered:", err);
    });
}

async function startBot() {
    if (!token) {
        console.log("ℹ️ No TELEGRAM_BOT_TOKEN defined. Skipping bot listener.");
        return null;
    }

    if (bot) return bot;

    try {
        bot = new Bot(token);
        setupBotHandlers(bot);
        bot.startPolling().catch(err => {
            console.warn("⚠️ Telegram bot polling error:", err.message);
        });
        console.log("🤖 Telegram Interactive Bot started & polling for button clicks.");
        return bot;
    } catch (err) {
        console.error("Failed to initialize Telegram Bot:", err.message);
        return null;
    }
}

if (require.main === module) {
    initDB().then(startBot).catch(console.error);
}

module.exports = { startBot, generateIntroPacket };
