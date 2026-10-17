const { repository } = require('./repository');
require("dotenv").config();
const { openMailbox } = require('./mailbox');
const { mailBackend } = require('./backend_config');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Api } = require("node-telegram-bot-api");
const { sendBrokerEmail } = require("./mailer");
const crypto = require("crypto");
const { generateGoogleCalendarUrl } = require('./inbox_messages');


let processedEmailIds = new Set();

async function analyzeInboundEmail(subject, from, bodyText, receivedAt = new Date().toISOString(), { quiet = false } = {}) {
    if (!process.env.GEMINI_API_KEY) {
        return null;
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
        model: "gemini-flash-lite-latest",
        generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
You are an expert NYC rental assistant parsing an inbound reply email from a real estate broker or landlord.

Email date/time: ${receivedAt}. Interpret relative dates from this email date in America/New_York.
Subject: ${subject}
From: ${from}
Email Body:
${bodyText}

Analyze whether this email is proposing, inviting, or confirming an apartment tour / showing date or time.
Output a JSON object with the following exact keys:
- "is_tour_invitation": (boolean) true if broker is offering, proposing, or confirming a tour/showing time.
- "proposed_datetime": (string or null) ISO 8601 string including the NYC UTC offset if a specific date/time was mentioned. Use null if the time is ambiguous; never invent a time.
- "human_readable_time": (string or null) e.g., "Tuesday, Sep 16 at 5:30 PM".
- "listing_address": (string) the apartment or building address mentioned.
- "broker_name": (string) the broker's name if identified.
- "broker_email": (string) the broker's email.
- "special_instructions": (string or null) e.g., "Buzz unit 3B, call when outside".
- "summary": (string) 1-sentence summary of the message.
`;

    try {
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text());
    } catch (err) {
        if (!quiet) console.error('AI inbound email parse failed; retry later.');
        return null;
    }
}

async function checkInboundReplies(botApi, chatId, { connect = openMailbox, analyze = analyzeInboundEmail } = {}) {
    if (mailBackend() === 'smtp-imap' && !process.env.MAIL_BACKEND && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
        return;
    }

    console.log("📬 [Inbound Listener] Checking Gmail for broker tour replies...");

    let connection;
    try {
        connection = await connect();
        const messages = await connection.listUnread(new Date(Date.now() - 2 * 86400000));
        console.log(`   Found ${messages.length} unread message(s) to inspect.`);

        for (const uid of messages) {
            const identity = connection.identity(uid);
            if (processedEmailIds.has(identity)) continue;
            const { subject, from, fromAddress, body, receivedAt } = await connection.getMessage(uid);

            // Quick pre-filter: is it relevant to real estate / apartment tours?
            const lowerSub = subject.toLowerCase();
            const lowerFrom = from.toLowerCase();

            // Exclude automated newsletters / social media
            const isSpamOrMarketing = lowerFrom.includes("no-reply") ||
                                      lowerFrom.includes("noreply") ||
                                      lowerFrom.includes("nextdoor") ||
                                      lowerFrom.includes("linkedin") ||
                                      lowerFrom.includes("facebook") ||
                                      lowerFrom.includes("notification") ||
                                      lowerFrom.includes("digest") ||
                                      lowerFrom.includes("marketing") ||
                                      lowerFrom.includes("update") ||
                                      lowerSub.includes("digest");
            if (isSpamOrMarketing) { processedEmailIds.add(identity); continue; }

            const cleanBody = (typeof body === "string" ? body : "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 1500);

            const lowerBody = cleanBody.toLowerCase();
            const isRelevant = lowerSub.includes("tour") || 
                               lowerSub.includes("showing") || 
                               lowerSub.includes("inquiry") || 
                               lowerSub.includes("apartment") ||
                               lowerSub.includes("streeteasy") || 
                               lowerSub.includes("renthop") ||
                               lowerBody.includes("tour") ||
                               lowerBody.includes("showing") ||
                               lowerBody.includes("available for viewing");

            if (!isRelevant) { processedEmailIds.add(identity); continue; }

            console.log(`   🔍 Analyzing broker reply: "${subject}" from: ${from}`);
            const analysis = await analyze(subject, from, cleanBody, receivedAt);

            if (analysis?.is_tour_invitation === false) processedEmailIds.add(identity);
            if (analysis && analysis.is_tour_invitation) {
                console.log(`   🎉 Tour Invitation Detected! Address: ${analysis.listing_address} | Time: ${analysis.human_readable_time}`);

                const startTime = analysis.proposed_datetime ? new Date(analysis.proposed_datetime) : null;
                const hasTime = startTime && Number.isFinite(startTime.getTime());
                const endTime = hasTime ? new Date(startTime.getTime() + 45 * 60 * 1000) : null;

                const calendarUrl = hasTime ? generateGoogleCalendarUrl({
                    title: analysis.listing_address || "Apartment Tour",
                    startTime,
                    endTime,
                    location: analysis.listing_address,
                    details: `Broker: ${analysis.broker_name || from}\nNotes: ${analysis.special_instructions || "None"}\nSummary: ${analysis.summary}`
                }) : null;

                // Generate unique tour ID for confirmation button
                const tourId = crypto.createHash("md5").update(identity).digest("hex").slice(0, 12);

                await repository.saveTour({ id: tourId, listing_address: analysis.listing_address || subject,
                    broker_email: fromAddress || from.match(/<([^>]+)>/)?.[1] || from,
                    broker_name: analysis.broker_name || 'Broker', proposed_time: analysis.human_readable_time || 'TBD',
                    special_instructions: analysis.special_instructions || null, proposed_datetime: hasTime ? startTime.toISOString() : null });
                const esc = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

                const telegramMessage = `📅 <b>TOUR INVITATION RECEIVED!</b>\n\n` +
                                        `🏢 <b>Listing:</b> ${esc(analysis.listing_address || "NYC Apartment")}\n` +
                                        `🕒 <b>Time:</b> <code>${esc(analysis.human_readable_time || "Time specified in email")}</code>\n` +
                                        `👤 <b>From:</b> ${esc(analysis.broker_name || from)}\n` +
                                        `📝 <b>Instructions:</b> ${esc(analysis.special_instructions || "None")}\n\n` +
                                        `💬 <i>"${esc(analysis.summary || subject)}"</i>\n\n` +
                                        `👇 <i>Tap below to add directly to Google Calendar or confirm to broker:</i>`;

                const api = botApi || (process.env.TELEGRAM_BOT_TOKEN ? new Api(process.env.TELEGRAM_BOT_TOKEN) : null);
                const targetChatId = chatId || process.env.TELEGRAM_CHAT_ID;
                if (api && targetChatId) {
                    await api.sendMessage({
                        chat_id: targetChatId,
                        text: telegramMessage,
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [
                                ...(calendarUrl ? [[{ text: "📅 Add to Google Calendar", url: calendarUrl }]] : []),
                                [{ text: "✅ Confirm Tour with Broker", callback_data: `confirm_tour_${tourId}` }]
                            ]
                        }
                    });
                    console.log(`📱 Sent Tour Alert to Telegram for: ${analysis.listing_address}`);
                    await connection.markRead(uid);
                    processedEmailIds.add(identity);
                }
            }
        }
    } catch (err) {
        console.warn("⚠️ Inbound listener check error:", err.message);
        if (process.env.MAIL_BACKEND) throw err;
    } finally {
        if (connection) {
            await connection.close();
        }
    }
}

async function confirmTourBooking(tourId, { repository: repo = repository, store, planner, send = sendBrokerEmail, now = Date.now, expectedRevision } = {}) {
    try {
        const res = await repo.getTour(tourId);
        const tour = res.rows[0];
        if (!tour) return { success: false, reason: "Tour schedule record not found" };

        store ||= require('./feature_store').createFeatureStore();
        planner ||= require('./tour_planner').createTourPlanner({ store, repository: repo, now });
        const schedule = await planner.getSchedule(tourId);
        if (expectedRevision !== undefined && schedule.revision !== expectedRevision) return { success: false, reason: 'The tour changed. Review the current schedule before confirming.' };
        if (['cancelled', 'completed'].includes(schedule.status)) return { success: false, reason: 'This tour is cancelled or completed.' };
        if (schedule.status === 'confirmed') { await repo.confirmTour(tourId); return { success: true, tour, schedule }; }
        if (!schedule.startsAt || Date.parse(schedule.startsAt) <= now()) return { success: false, reason: 'Choose a specific future date and time before confirming the tour.' };

        if (!schedule.brokerEmail) {
            return { success: false, reason: "Broker email address unknown" };
        }

        const selectedTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }).format(new Date(schedule.startsAt));
        const subject = `Confirmed: Apartment Tour for ${schedule.address} - Adityaa Magesh Kumar`;
        const body = `Hi ${tour.broker_name || ""},\n\n` +
                     `Thank you for getting back to me! ${selectedTime} (New York time) works perfectly for me. I look forward to viewing ${schedule.address}.\n\n` +
                     `If there are any gate codes or entry instructions needed upon arrival, please let me know.\n\n` +
                     `Best regards,\n` +
                     `Adityaa Magesh Kumar\n` +
                     `adityaa.magesh@gmail.com | 732-309-5089`;

        const conversation = schedule.conversationId ? await store.get('conversation_messages', schedule.conversationId) : null;
        await send({
            to: schedule.brokerEmail,
            listingId: schedule.listingId,
            tourId, purpose: 'tour_confirmation', operationId: `tour:${tourId}:${schedule.revision}`,
            threadId: conversation?.data.threadId,
            inReplyTo: conversation?.data.rfcMessageId,
            references: [...(conversation?.data.references || []), ...(conversation?.data.rfcMessageId ? [conversation.data.rfcMessageId] : [])],
            subject,
            body
        });

        let confirmed;
        try { confirmed = await planner.updateSchedule(tourId, { expectedRevision: schedule.revision, status: 'confirmed' }); }
        catch (error) {
            if (error.status === 409) return { success: false, emailSent: true, reason: 'The confirmation email was sent, but the schedule changed meanwhile. Review the current tour before making another change.' };
            throw error;
        }
        await repo.confirmTour(tourId);
        return { success: true, tour, schedule: confirmed };
    } catch (err) {
        console.error("Error confirming tour booking:", err.message);
        return { success: false, reason: err.message };
    }
}

module.exports = {
    checkInboundReplies,
    analyzeInboundEmail,
    confirmTourBooking,
    generateGoogleCalendarUrl
};
