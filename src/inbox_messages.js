const crypto = require('node:crypto');
const text = (value, limit) => String(value || '').slice(0, limit);
const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function generateGoogleCalendarUrl({ title, startTime, endTime, location, details }) {
    const format = date => date.toISOString().replace(/-|:|\.\d+/g, '');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
        `&text=${encodeURIComponent(`Apartment Tour: ${title}`)}&dates=${format(startTime)}/${format(endTime)}` +
        `&details=${encodeURIComponent(details || 'NYC Housing AI Scheduled Tour')}&location=${encodeURIComponent(location || 'New York, NY')}`;
}

function inspectMessage(message, knownBroker = false) {
    const subject = text(message.subject, 300);
    const from = text(message.from, 300);
    const sender = String(message.fromAddress || from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
    const body = String(message.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    const marketing = /no-?reply|nextdoor|linkedin|facebook|notification|digest|marketing/.test(from.toLowerCase()) || /digest/i.test(subject);
    return { subject, from, sender, body, receivedAt: message.receivedAt,
        relevant: !marketing && (knownBroker || /tour|showing|inquiry|apartment|streeteasy|renthop/i.test(subject) || /tour|showing|available for viewing/i.test(body)) };
}

function tourProposal(identity, message, analysis) {
    const start = typeof analysis.proposed_datetime === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(analysis.proposed_datetime)
        ? new Date(analysis.proposed_datetime) : null;
    const hasTime = start && Number.isFinite(start.getTime());
    const tour = { id: crypto.createHash('md5').update(identity).digest('hex').slice(0, 12),
        listing_address: text(analysis.listing_address || message.subject || 'NYC Apartment', 200),
        broker_email: text(message.sender || message.fromAddress || message.from, 254),
        broker_name: text(analysis.broker_name || 'Broker', 120), proposed_time: text(analysis.human_readable_time || 'TBD', 180),
        special_instructions: text(analysis.special_instructions, 400) || null,
        proposed_datetime: hasTime ? start.toISOString() : null };
    const summary = text(analysis.summary || message.subject, 350);
    const calendarUrl = hasTime ? generateGoogleCalendarUrl({ title: tour.listing_address, startTime: start,
        endTime: new Date(start.getTime() + 45 * 60000), location: tour.listing_address,
        details: `Broker: ${tour.broker_name}\nNotes: ${tour.special_instructions || 'None'}\nSummary: ${summary}` }) : null;
    const payload = { parse_mode: 'HTML', text: `📅 <b>TOUR INVITATION RECEIVED!</b>\n\n` +
        `🏢 <b>Listing:</b> ${escape(text(tour.listing_address, 120))}\n🕒 <b>Time:</b> <code>${escape(text(tour.proposed_time, 100))}</code>\n` +
        `👤 <b>From:</b> ${escape(text(tour.broker_name, 80))}\n📝 <b>Instructions:</b> ${escape(text(tour.special_instructions || 'None', 180))}\n\n` +
        `💬 <i>"${escape(text(summary, 200))}"</i>`, reply_markup: { inline_keyboard: [
            ...(calendarUrl ? [[{ text: '📅 Add to Google Calendar', url: calendarUrl }]] : []),
            [{ text: '✅ Confirm Tour with Broker', callback_data: `confirm_tour_${tour.id}` }]
        ] } };
    return { tour, payload };
}

function nudgeEvent(listing, now) {
    const action = listing.id_hash || (listing.id.length > 50 ? crypto.createHash('md5').update(listing.id).digest('hex') : listing.id);
    const appliedAt = Date.parse(listing.applied_at);
    return { id: 'nudge:' + crypto.createHash('sha256').update(JSON.stringify([listing.id, appliedAt])).digest('hex'), kind: 'nudge',
        reference: { listingId: listing.id, appliedAt, sender: String(listing.broker_email).trim().toLowerCase() }, created_at: now,
        payload: { parse_mode: 'HTML', text: `⏰ <b>BROKER FOLLOW-UP NUDGE</b>\n\n` +
            `🏢 <b>Listing:</b> ${escape(text(listing.title, 200))}\n👤 <b>Broker:</b> ${escape(text(listing.broker_email, 254))}\n` +
            `⏳ No matching reply found since your inquiry, sent over 24 hours ago.\n\nTap below to send a follow-up.`,
        reply_markup: { inline_keyboard: [
            [{ text: '📨 Send 1-Tap Follow-Up Nudge', callback_data: `nudge_${action}` }],
            [{ text: "❌ Don't Nudge", callback_data: `skip_nudge_${action}` }]
        ] } } };
}
module.exports = { generateGoogleCalendarUrl, inspectMessage, tourProposal, nudgeEvent };
