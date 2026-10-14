const { dayStart } = require('./commute_time');
const WINDOW_MS = 32 * 86400000;
const WINDOW_CAP = 9000, DAILY_CAP = 300;
function createAllowance(db, now = Date.now) {
    const read = async () => {
        const row = db.backend === 'supabase' ? await db.rpc('housing_commute_state') :
            (await db.query('SELECT * FROM commute_control WHERE id = 1')).rows[0];
        if (!row) throw new Error('Commute accounting unavailable');
        const attempts = JSON.parse(row.attempts);
        if (!Array.isArray(attempts) || attempts.some(t => !Number.isSafeInteger(t) || t < 0)) throw new Error('Invalid commute accounting');
        return { ...row, revision: Number(row.revision), pause_until: Number(row.pause_until), attempts };
    };
    async function exchange(previous, next) {
        const args = [previous.revision, JSON.stringify(next.attempts), next.disabled_config, next.pause_until];
        if (db.backend === 'supabase') return await db.rpc('housing_commute_exchange', {
            p_revision: args[0], p_attempts: args[1], p_disabled_config: args[2], p_pause_until: args[3]
        });
        return (await db.query(`UPDATE commute_control SET revision = revision + 1, attempts = $2,
            disabled_config = $3, pause_until = $4 WHERE id = 1 AND revision = $1`, args)).rowCount === 1;
    }
    function summary(state, config, at) {
        const attempts = state.attempts.filter(t => t > at - WINDOW_MS);
        const midnight = dayStart(at);
        const today = attempts.filter(t => t >= midnight).length;
        const remaining = { daily: Math.max(0, DAILY_CAP - today), rolling32Days: Math.max(0, WINDOW_CAP - attempts.length) };
        const code = !config ? 'unconfigured' : state.disabled_config === config ? 'configuration_error' :
            state.pause_until > at ? 'rate_limited' : !remaining.daily || !remaining.rolling32Days ? 'allowance_exhausted' : 'ready';
        return { configured: Boolean(config), available: code === 'ready', code, remaining,
            limits: { daily: DAILY_CAP, rolling32Days: WINDOW_CAP, timeZone: 'America/New_York' },
            retryAt: state.pause_until > at ? new Date(state.pause_until).toISOString() : null };
    }
    async function status(config) { return summary(await read(), config, now()); }
    async function change(update) {
        // Compare-and-swap is atomic across connections and processes on all backends.
        // Retry only a confirmed zero-row conflict, never an ambiguous network failure.
        for (let i = 0; i < 100; i++) {
            const state = await read(), at = now();
            const next = update(state, at);
            if (!next) return false;
            if (await exchange(state, next)) return true;
        }
        throw new Error('Commute accounting busy');
    }
    async function reserve(config) {
        return change((state, at) => !summary(state, config, at).available ? null :
            { ...state, attempts: [...state.attempts.filter(t => t > at - WINDOW_MS), at] });
    }
    const disable = config => change(state => ({ ...state, disabled_config: config }));
    const pause = ms => change((state, at) => ({ ...state, pause_until: Math.max(state.pause_until, at + Math.max(300000, ms || 0)) }));
    return { status, reserve, disable, pause };
}
module.exports = { createAllowance, WINDOW_CAP, DAILY_CAP, WINDOW_MS };
