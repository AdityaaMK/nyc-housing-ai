require("dotenv").config();
const imaps = require("imap-simple");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Api } = require("node-telegram-bot-api");
const { pool } = require("./db");
const { sendBrokerEmail } = require("./mailer");
const crypto = require("crypto");

const imapConfig = {
    imap: {
        user: process.env.GMAIL_USER,
        password: process.env.GMAIL_APP_PASSWORD,
        host: "imap.gmail.com",
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000
    }
};

let processedEmailIds = new Set();

function generateGoogleCalendarUrl({ title, startTime, endTime, location, details }) {
    // Format YYYYMMDDTHHMMSSZ
    function formatTime(d) {
        return d.toISOString().replace(/-|:|\.\d+/g, "");
    }

    const start = formatTime(startTime);
    const end = formatTime(endTime);

    const base = "https://calendar.google.com/calendar/render?action=TEMPLATE";
    const text = encodeURIComponent(`Apartment Tour: ${title}`);
    const dates = `${start}/${end}`;
    const loc = encodeURIComponent(location || "New York, NY");
    const det = encodeURIComponent(details || "NYC Housing AI Scheduled Tour");

    return `${base}&text=${text}&dates=${dates}&details=${det}&location=${loc}`;
}

async function analyzeInboundEmail(subject, from, bodyText) {
    if (!process.env.GEMINI_API_KEY) {
        return { is_tour_invitation: false };
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
        model: "gemini-flash-lite-latest",
        generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
You are an expert NYC rental assistant parsing an inbound reply email from a real estate broker or landlord.

Subject: ${subject}
From: ${from}
Email Body:
${bodyText}

Analyze whether this email is proposing, inviting, or confirming an apartment tour / showing date or time.
Output a JSON object with the following exact keys:
- "is_tour_invitation": (boolean) true if broker is offering, proposing, or confirming a tour/showing time.
- "proposed_datetime": (string or null) ISO 8601 string if a specific date/time was mentioned (assume current year if omitted, NYC Eastern Time).
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
        console.error("AI Inbound Email Parse Error:", err.message);
        return { is_tour_invitation: false };
    }
}

async function checkInboundReplies(botApi, chatId) {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
        return;
    }

    console.log("📬 [Inbound Listener] Checking Gmail for broker tour replies...");

    let connection;
    try {
        connection = await imaps.connect(imapConfig);
        await connection.openBox("INBOX");

        // Search for unseen messages in the last 2 days
        const delay = 24 * 3600 * 1000 * 2;
        const yesterday = new Date();
        yesterday.setTime(Date.now() - delay);
        const searchCriteria = ["UNSEEN", ["SINCE", yesterday]];
        const fetchOptions = {
            bodies: ["HEADER", "TEXT"],
            markSeen: false
        };

        const messages = await connection.search(searchCriteria, fetchOptions);
        console.log(`   Found ${messages.length} unread message(s) to inspect.`);

        for (const item of messages) {
            const uid = item.attributes.uid;
            if (processedEmailIds.has(uid)) continue;
            processedEmailIds.add(uid);

            const header = item.parts.find(p => p.which === "HEADER");
            const textPart = item.parts.find(p => p.which === "TEXT");

            const subject = header?.body?.subject?.[0] || "No Subject";
            const from = header?.body?.from?.[0] || "Unknown Sender";
            const body = textPart?.body || "";

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
            if (isSpamOrMarketing) continue;

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

            if (!isRelevant) continue;

            console.log(`   🔍 Analyzing broker reply: "${subject}" from: ${from}`);
            const analysis = await analyzeInboundEmail(subject, from, cleanBody);

            if (analysis && analysis.is_tour_invitation) {
                console.log(`   🎉 Tour Invitation Detected! Address: ${analysis.listing_address} | Time: ${analysis.human_readable_time}`);

                // Mark seen so we don't re-notify
                try {
                    await connection.addFlags(uid, "\\Seen");
                } catch {}

                // Default 45 min duration
                let startTime = new Date();
                if (analysis.proposed_datetime) {
                    startTime = new Date(analysis.proposed_datetime);
                } else {
                    startTime.setDate(startTime.getDate() + 1);
                    startTime.setHours(17, 0, 0, 0); // Default tomorrow 5pm
                }
                const endTime = new Date(startTime.getTime() + 45 * 60 * 1000);

                const calendarUrl = generateGoogleCalendarUrl({
                    title: analysis.listing_address || "Apartment Tour",
                    startTime,
                    endTime,
                    location: analysis.listing_address,
                    details: `Broker: ${analysis.broker_name || from}\nNotes: ${analysis.special_instructions || "None"}\nSummary: ${analysis.summary}`
                });

                // Generate unique tour ID for confirmation button
                const tourId = crypto.createHash("md5").update(subject + from + Date.now()).digest("hex").slice(0, 12);

                // Save tour proposal in DB if available
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
                        analysis.listing_address || subject,
                        analysis.broker_email || from,
                        analysis.broker_name || "Broker",
                        analysis.human_readable_time || "TBD",
                        analysis.special_instructions || null
                    ]);
                } catch (e) {
                    console.warn("DB tour record note:", e.message);
                }

                const telegramMessage = `📅 <b>TOUR INVITATION RECEIVED!</b>\n\n` +
                                        `🏢 <b>Listing:</b> ${analysis.listing_address || "NYC Apartment"}\n` +
                                        `🕒 <b>Time:</b> <code>${analysis.human_readable_time || "Time specified in email"}</code>\n` +
                                        `👤 <b>From:</b> ${analysis.broker_name || from}\n` +
                                        `📝 <b>Instructions:</b> ${analysis.special_instructions || "None"}\n\n` +
                                        `💬 <i>"${analysis.summary || subject}"</i>\n\n` +
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
                                [{ text: "📅 Add to Google Calendar", url: calendarUrl }],
                                [{ text: "✅ Confirm Tour with Broker", callback_data: `confirm_tour_${tourId}` }]
                            ]
                        }
                    });
                    console.log(`📱 Sent Tour Alert to Telegram for: ${analysis.listing_address}`);
                }
            }
        }
    } catch (err) {
        console.warn("⚠️ Inbound listener check error:", err.message);
    } finally {
        if (connection) {
            connection.end();
        }
    }
}

async function confirmTourBooking(tourId) {
    try {
        const res = await pool.query(`SELECT * FROM tour_schedules WHERE id = $1 LIMIT 1`, [tourId]);
        const tour = res.rows[0];
        if (!tour) return { success: false, reason: "Tour schedule record not found" };

        if (!tour.broker_email) {
            return { success: false, reason: "Broker email address unknown" };
        }

        const subject = `Confirmed: Apartment Tour for ${tour.listing_address} - Adityaa Magesh Kumar`;
        const body = `Hi ${tour.broker_name || ""},\n\n` +
                     `Thank you for getting back to me! ${tour.proposed_time} works perfectly for me. I look forward to viewing the apartment.\n\n` +
                     `If there are any gate codes or entry instructions needed upon arrival, please let me know.\n\n` +
                     `Best regards,\n` +
                     `Adityaa Magesh Kumar\n` +
                     `adityaa.magesh@gmail.com | 732-309-5089`;

        await sendBrokerEmail({
            to: tour.broker_email,
            subject,
            body
        });

        await pool.query(`UPDATE tour_schedules SET status = 'confirmed' WHERE id = $1`, [tourId]);
        return { success: true, tour };
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
