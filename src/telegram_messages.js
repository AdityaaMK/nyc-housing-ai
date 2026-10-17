const crypto = require('node:crypto');
const { matchesPreferences, loadPreferences } = require('./preferences');

function eligibleForAlert(listing, preferences) {
    return listing.status === 'inbox' && Number(listing.suitability_score) >= 75 &&
        !listing.score_outdated && !listing.assessment_outdated && listing.availability !== 'unavailable' && matchesPreferences(listing, preferences);
}

function buildListingAlert(listing) {
    listing = { ...listing };
    for (const [key, limit] of Object.entries({ title: 180, neighborhood: 80, fee_estimate: 100, commute_summary: 280, manhattan_commute_summary: 220, manhattan_arrival_station: 100 })) {
        if (listing[key] != null) listing[key] = String(listing[key]).slice(0, limit);
    }
    const score = listing.suitability_score || 0;
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

    const sourceName = ({ renthop: "RentHop", compass: "Compass", streeteasy: "StreetEasy" })[listing.source] || "Listing";
    const sourceBadge = `\n🌐 <b>Source:</b> ${sourceName}`;

    const office = esc(String(loadPreferences().officeCommute?.destination || '620 8th Ave').slice(0, 100));
    const commuteInfo = listing.commute_summary
        ? `\n🚇 <b>AI commute estimate to ${office}:</b> ${esc(listing.commute_summary)}`
        : (listing.commute_minutes ? `\n🚇 <b>AI commute estimate to ${office}:</b> ~${listing.commute_minutes} mins` : "");

    const manhattanCommute = listing.manhattan_commute_summary
        ? '\n🚉 <b>AI estimate to Manhattan:</b> ' + listing.manhattan_commute_minutes + ' min to ' + esc(listing.manhattan_arrival_station) + ' — ' + esc(listing.manhattan_commute_summary) : '';

    let buildingHealthBadge = "";
    try {
        if (listing.building_health) {
            const bh = JSON.parse(listing.building_health);
            if (bh.summary) {
                buildingHealthBadge = `\n🏥 <b>Building Health:</b> ${esc(String(bh.summary).slice(0, 240))}`;
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
                    manhattanCommute +
                    `${buildingHealthBadge}\n` +
                    `⚠️ <b>Broker Fee:</b> ${feeText}\n\n` +
                    `🚩 <b>Red Flags:</b> ${esc((redFlags || "None").slice(0, 400))}\n` +
                    `✅ <b>Pros:</b> ${esc((pros || "None").slice(0, 400))}\n\n` +
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
            for (const c of cross.slice(0, 4)) {
                const cName = c.source === 'renthop' ? 'RentHop' : 'StreetEasy';
                inlineButtons.push([{ text: `🔗 Also listed on ${cName}`, url: c.url }]);
            }
        }
    } catch(e) {}

    inlineButtons.push([
        { text: '⭐ Save apartment', callback_data: `save_${actionId}` },
        { text: 'Remove saved', callback_data: `unsave_${actionId}` }
    ]);
    inlineButtons.push([
        { text: "✉️ Send Intro Packet", callback_data: `apply_${actionId}` },
        { text: "❌ Pass", callback_data: `pass_${actionId}` }
    ]);

    const keyboard = {
        inline_keyboard: inlineButtons
    };
    return { text: message, parse_mode: 'HTML', reply_markup: keyboard };
}

function buildBacklogAlert(listings) {
    const escape = value => String(value).slice(0, 100).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const top = [...listings].sort((a, b) => b.suitability_score - a.suitability_score).slice(0, 5);
    return {
        text: `<b>Housing alerts are running</b>\n${listings.length} existing matches meet your saved preferences.\n\n` +
            top.map((l, i) => `${i + 1}. <b>${escape(l.title)}</b> · $${Number(l.price).toLocaleString()} · ${l.suitability_score}/100`).join('\n') +
            '\n\nThis is your startup summary. New matches will arrive individually; existing matches remain in your dashboard.',
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: top.map((l, i) => [{ text: `View match ${i + 1}`, url: l.url }]) }
    };
}
module.exports = { eligibleForAlert, buildListingAlert, buildBacklogAlert };
