const { randomUUID, createHash } = require('node:crypto');
const { summaries } = require('../evaluation_errors');
const LEASE_MS = 5 * 60_000;
const iso = ms => new Date(ms).toISOString();
const retryDelay = attempts => attempts === 1 ? 60_000 : 300_000;

function createQueue(db, now = Date.now) {
    async function recoverExpired() {
        const at = now();
        await db.query(`UPDATE listings SET
            evaluation_status = CASE WHEN evaluation_attempts >= 3 THEN 'failed' ELSE 'retry_wait' END,
            evaluation_next_at = CASE WHEN evaluation_attempts >= 3 THEN NULL
                WHEN evaluation_attempts = 1 THEN $2 WHEN evaluation_attempts < 3 THEN $3 ELSE evaluation_next_at END,
            evaluation_last_error = $4, evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL
            WHERE evaluation_status = 'processing' AND evaluation_claim_expires_at <= $1 AND is_evaluated = false`,
        [iso(at), iso(at + 60_000), iso(at + 300_000), summaries.expired]);
    }
    async function pauseUntil() {
        const { rows } = await db.query('SELECT pause_until FROM evaluation_control WHERE id = 1');
        return rows[0]?.pause_until ? new Date(rows[0].pause_until).getTime() : 0;
    }
    async function claim({ exclude = [], noRetries = false } = {}) {
        await recoverExpired();
        if (await pauseUntil() > now()) return null;
        const at = now(), token = randomUUID();
        const params = [iso(at), token, iso(at + LEASE_MS), ...exclude];
        const eligible = `is_evaluated = false AND COALESCE(status, 'inbox') <> 'passed'
            AND evaluation_status IN ('pending', 'retry_wait') AND evaluation_attempts < 3
            AND (evaluation_next_at IS NULL OR evaluation_next_at <= $1)
            ${noRetries ? 'AND evaluation_attempts = 0' : ''}
            ${exclude.length ? `AND id NOT IN (${exclude.map((_, i) => '$' + (i + 4)).join(',')})` : ''}`;
        // The conditional UPDATE is the claim, never a preceding SELECT. Re-checks
        // eligibility after a competing transaction changes the selected row.
        const { rows } = await db.query(`UPDATE listings SET evaluation_status = 'processing',
            evaluation_attempts = evaluation_attempts + 1, evaluation_claim_token = $2,
            evaluation_claim_expires_at = $3, evaluation_next_at = NULL
            WHERE id = (SELECT id FROM listings WHERE ${eligible}
                ORDER BY COALESCE(evaluation_next_at, discovered_at), discovered_at, id LIMIT 1)
            AND ${eligible} RETURNING *`, params);
        return rows[0] || null;
    }
    const owned = `id = $1 AND evaluation_claim_token = $2 AND evaluation_status = 'processing'
        AND evaluation_claim_expires_at > $3 AND is_evaluated = false`;
    async function fail(listing, code) {
        const attempts = listing.evaluation_attempts, at = now();
        return db.query(`UPDATE listings SET evaluation_status = $4, evaluation_next_at = $5,
            evaluation_last_error = $6, evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL
            WHERE ${owned}`, [listing.id, listing.evaluation_claim_token, iso(at), attempts >= 3 ? 'failed' : 'retry_wait',
            attempts >= 3 ? null : iso(at + retryDelay(attempts)), summaries[code] || summaries.transient]);
    }
    async function release(listing, code, nextAt = null) {
        return db.query(`UPDATE listings SET evaluation_status = $4, evaluation_next_at = $5,
            evaluation_attempts = evaluation_attempts - 1, evaluation_last_error = $6,
            evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL WHERE ${owned}`,
        [listing.id, listing.evaluation_claim_token, iso(now()), nextAt ? 'retry_wait' : 'pending',
            nextAt ? iso(nextAt) : null, summaries[code] || summaries.transient]);
    }
    async function complete(listing, evaluation, health) {
        const fields = {
            id_hash: listing.id_hash || createHash('md5').update(listing.id).digest('hex'),
            price: listing.price ?? null, true_gross_rent: Math.round(evaluation.true_gross_rent), is_fee: evaluation.is_fee,
            effective_monthly_rent: evaluation.effective_monthly_rent ?? null,
            rent_terms: evaluation.rent_terms ? JSON.stringify(evaluation.rent_terms) : null,
            fee_estimate: evaluation.fee_estimate, red_flags: JSON.stringify(evaluation.red_flags),
            pros: JSON.stringify(evaluation.pros), suitability_score: Math.round(evaluation.suitability_score),
            neighborhood: evaluation.neighborhood, is_preferred: evaluation.is_preferred_neighborhood,
            commute_minutes: evaluation.commute_minutes === null ? null : Math.round(evaluation.commute_minutes),
            commute_summary: evaluation.commute_summary, building_health: JSON.stringify(health),
            location_area: evaluation.location_area,
            manhattan_commute_minutes: evaluation.manhattan_commute_minutes,
            manhattan_arrival_station: evaluation.manhattan_arrival_station,
            manhattan_commute_summary: evaluation.manhattan_commute_summary
        };
        const at = iso(now());
        const result = await db.query(`UPDATE listings SET ${Object.keys(fields).map((name, i) => `${name} = $${i + 4}`).join(', ')},
            is_evaluated = true, evaluation_status = 'completed', evaluation_completed_at = $3,
            evaluation_next_at = NULL, evaluation_last_error = NULL,
            evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL WHERE ${owned}`,
        [listing.id, listing.evaluation_claim_token, at, ...Object.values(fields)]);
        return result.rowCount === 1;
    }
    async function pause(ms) {
        const until = iso(now() + Math.max(300_000, ms || 0));
        await db.query(`UPDATE evaluation_control SET pause_until = CASE
            WHEN pause_until IS NULL OR pause_until < $1 THEN $1 ELSE pause_until END WHERE id = 1`, [until]);
        return pauseUntil();
    }
    // Shared across processes: no two workers can start AI calls in the same 5s window.
    async function reserveRequest() {
        const at = now();
        const result = await db.query(`UPDATE evaluation_control SET next_request_at = $2
            WHERE id = 1 AND (next_request_at IS NULL OR next_request_at <= $1)
            AND (pause_until IS NULL OR pause_until <= $1)`, [iso(at), iso(at + 5000)]);
        return result.rowCount === 1;
    }
    return { claim, fail, release, complete, recoverExpired, pause, pauseUntil, reserveRequest };
}
module.exports = { createQueue, LEASE_MS };
