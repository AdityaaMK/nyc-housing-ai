/**
 * Address Normalizer & Cross-Site Deduplication Engine
 */

function normalizeAddress(title, rawAddress) {
    const raw = (rawAddress || title || "").toUpperCase().trim();
    if (!raw) return null;

    let text = raw;
    let unit = "";

    // Extract unit identifier if present (#4B, Apt 07P, Unit 2, Suite 3, Penthouse 8)
    const unitMatch = text.match(/(?:#|APT\.?|UNIT\.?|SUITE\.?|PH|PENTHOUSE|,)\s*([0-9A-Z-]+)$/i) || text.match(/#\s*([0-9A-Z-]+)/i);
    if (unitMatch) {
        unit = unitMatch[1].replace(/^0+([1-9A-Z])/, "$1"); // Normalize 07P -> 7P
        text = text.replace(unitMatch[0], "").trim();
    }

    // Standardize NYC street, directional, and borough abbreviations
    text = text
        .replace(/\bWEST\b/g, "W")
        .replace(/\bEAST\b/g, "E")
        .replace(/\bNORTH\b/g, "N")
        .replace(/\bSOUTH\b/g, "S")
        .replace(/\bSTREET\b/g, "ST")
        .replace(/\bAVENUE\b/g, "AVE")
        .replace(/\bBOULEVARD\b/g, "BLVD")
        .replace(/\bPLACE\b/g, "PL")
        .replace(/\bROAD\b/g, "RD")
        .replace(/\bDRIVE\b/g, "DR")
        .replace(/\bLANE\b/g, "LN")
        .replace(/\bSQUARE\b/g, "SQ")
        .replace(/\bPARK\b/g, "PK")
        .replace(/\bNEW YORK\b/g, "")
        .replace(/\bMANHATTAN\b/g, "")
        .replace(/\bNY\b/g, "")
        .replace(/[^A-Z0-9]/g, " ")
        .trim()
        .replace(/\s+/g, "-");

    return unit ? `${text}-${unit}` : text;
}

/**
 * Checks if a listing at this normalized address already exists in the database.
 * If found, records the new source URL under cross_posted_sources.
 */
async function checkOrRecordDuplicate(pool, { normalizedAddress, newUrl, newSource }) {
    if (!normalizedAddress) return null;

    const res = await pool.query(
        `SELECT id, source, url, cross_posted_sources, is_evaluated, is_notified FROM listings WHERE normalized_address = $1 LIMIT 1`,
        [normalizedAddress]
    );

    if (res.rows.length === 0) {
        return null; // Not a duplicate
    }

    const existing = res.rows[0];

    // If it's from the same URL, it's already indexed
    if (existing.url === newUrl) {
        return existing;
    }

    // Parse existing cross-posted sources
    let sources = [];
    try {
        if (existing.cross_posted_sources) {
            sources = JSON.parse(existing.cross_posted_sources);
        }
    } catch(e) {}

    const alreadyLinked = sources.some(s => s.url === newUrl);
    if (!alreadyLinked) {
        sources.push({ source: newSource, url: newUrl, discovered_at: new Date().toISOString() });
        await pool.query(
            `UPDATE listings SET cross_posted_sources = $1 WHERE id = $2`,
            [JSON.stringify(sources), existing.id]
        );
        console.log(`🔁 Linked cross-posted source for "${normalizedAddress}": ${newSource} (${newUrl})`);
    }

    return existing;
}

module.exports = { normalizeAddress, checkOrRecordDuplicate };
