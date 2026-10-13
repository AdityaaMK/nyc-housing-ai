const { summaries } = require('../evaluation_errors');
function createSupabaseQueue(db) {
    const rpc = (name, args) => db.rpc('housing_queue_' + name, args);
    const lease = listing => ({ p_id: listing.id, p_token: listing.evaluation_claim_token });
    const count = rowCount => ({ rows: [], rowCount });
    return {
        recoverExpired: () => rpc('recover'),
        pauseUntil: async () => { const value = await rpc('pause_until'); return value ? new Date(value).getTime() : 0; },
        claim: async ({ exclude = [], noRetries = false } = {}) => (await rpc('claim', { p_exclude: exclude, p_no_retries: noRetries }))[0] || null,
        fail: async (listing, code) => count(await rpc('fail', { ...lease(listing), p_error: summaries[code] || summaries.transient })),
        release: async (listing, code, nextAt = null) => count(await rpc('release', { ...lease(listing),
            p_error: summaries[code] || summaries.transient, p_next_at: nextAt ? new Date(nextAt).toISOString() : null })),
        complete: async (listing, evaluation, health) => await rpc('complete', { ...lease(listing),
            p_price: listing.price ?? null, p_evaluation: { ...evaluation,
                red_flags: JSON.stringify(evaluation.red_flags), pros: JSON.stringify(evaluation.pros),
                rent_terms: evaluation.rent_terms ? JSON.stringify(evaluation.rent_terms) : null },
            p_health: JSON.stringify(health) }) === 1,
        pause: async ms => new Date(await rpc('pause', { p_ms: Math.max(300000, ms || 0) })).getTime(),
        reserveRequest: () => rpc('reserve')
    };
}
module.exports = { createSupabaseQueue };
