const { required } = require('./backend_config');
const { httpsClient } = require('./https_client');
const SCHEMA_VERSION = 1;
const dateColumns = new Set(['discovered_at', 'applied_at', 'nudged_at', 'created_at', 'evaluation_next_at',
    'evaluation_completed_at', 'evaluation_claim_expires_at', 'next_request_at', 'pause_until']);
function normalizeRow(row) {
    // Match node-postgres' Date and NUMERIC values, including JSON serialization
    // through the unchanged dashboard routes. proposed_datetime remains TEXT.
    const result = { ...row };
    for (const [key, value] of Object.entries(result)) {
        if (value != null && dateColumns.has(key)) result[key] = new Date(value);
        if (value != null && key === 'effective_monthly_rent') result[key] = Number(value).toFixed(2);
    }
    return result;
}
function createSupabaseClient({ env = process.env, client = httpsClient } = {}) {
    required(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'], 'supabase');
    let base;
    try { base = new URL(env.SUPABASE_URL); } catch { throw new Error('SUPABASE_URL must be a project HTTPS origin'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.port && base.port !== '443')) {
        throw new Error('SUPABASE_URL must be a project HTTPS origin on port 443');
    }
    const headers = { apikey: env.SUPABASE_SECRET_KEY };
    async function rest(path, { method = 'GET', params = {}, json, prefer } = {}) {
        const url = new URL('/rest/v1/' + path, base);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const result = await client.request(url, { method, json, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, service: 'Supabase' });
        if (Array.isArray(result.data)) result.data = result.data.map(normalizeRow);
        return result;
    }
    async function rpc(name, args = {}) { return (await rest('rpc/' + name, { method: 'POST', json: args })).data; }
    async function readAll(table, params = {}) {
        const rows = [];
        // Use Content-Range rather than assuming the requested page size was honored.
        // Every caller supplies a unique final ordering key. Empty datasets return */0.
        for (let offset = 0; ;) {
            const response = await rest(table, { params: { ...params, limit: 1000, offset }, prefer: 'count=exact' });
            if (!Array.isArray(response.data)) throw new Error('Supabase returned invalid rows');
            rows.push(...response.data);
            const total = response.headers.get('content-range')?.split('/')[1];
            offset += response.data.length;
            if (total && total !== '*' && offset >= Number(total)) return rows;
            if (!response.data.length) return rows;
        }
    }
    async function verifySchema() {
        let version;
        try { version = await rpc('housing_schema_version'); }
        catch { throw new Error('Supabase schema check failed; check backend key access and apply migrations/001_https_backends.sql through PostgreSQL'); }
        if (version !== SCHEMA_VERSION) throw new Error(`Supabase schema incompatible; expected HTTPS schema version ${SCHEMA_VERSION}`);
    }
    return { rest, rpc, readAll, verifySchema, close: () => client.close() };
}
module.exports = { createSupabaseClient, SCHEMA_VERSION, normalizeRow };
