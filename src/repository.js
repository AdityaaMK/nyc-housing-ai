const { pool } = require('./db');
const listingFields = new Set(['id', 'url', 'title', 'price', 'bedrooms', 'bathrooms', 'source', 'normalized_address', 'neighborhood', 'location_area']);
const tourFields = new Set(['id', 'listing_address', 'broker_email', 'broker_name', 'proposed_time', 'special_instructions', 'proposed_datetime']);
function checkedFields(data, allowed) {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined);
    if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error('Invalid repository fields');
    return Object.fromEntries(entries);
}
function createSqlRepository(db) {
    const q = (sql, params) => db.query(sql, params);
    const insert = (table, values, allowed) => {
        const data = checkedFields(values, allowed), keys = Object.keys(data);
        return q(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT (id) DO NOTHING`, Object.values(data));
    };
    return {
        listListings: () => q('SELECT * FROM listings ORDER BY suitability_score DESC NULLS LAST, discovered_at DESC, id'),
        listingExists: id => q('SELECT id FROM listings WHERE id = $1', [id]),
        insertListing: data => insert('listings', data, listingFields),
        getListing: action => q('SELECT * FROM listings WHERE id = $1 OR id_hash = $1 ORDER BY id LIMIT 1', [action]),
        setListingStatus: (id, status) => q('UPDATE listings SET status = $1 WHERE id = $2', [status, id]),
        passListing: action => q("UPDATE listings SET status = 'passed' WHERE id = $1 OR id_hash = $1", [action]),
        markApplied: action => q("UPDATE listings SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = $1 OR id_hash = $1", [action]),
        setBrokerEmail: (action, email) => q('UPDATE listings SET broker_email = $1 WHERE id = $2 OR id_hash = $2', [email, action]),
        pendingNotifications: () => q('SELECT * FROM listings WHERE is_evaluated = true AND is_notified = false ORDER BY id'),
        markNotified: id => q('UPDATE listings SET is_notified = true WHERE id = $1', [id]),
        statsRows: () => q('SELECT status, suitability_score, building_health, price, evaluation_status FROM listings ORDER BY id'),
        listTours: () => q('SELECT * FROM tour_schedules ORDER BY created_at DESC, id'),
        countTours: () => q('SELECT COUNT(*) AS count FROM tour_schedules'),
        saveTour: data => insert('tour_schedules', data, tourFields),
        getTour: id => q('SELECT * FROM tour_schedules WHERE id = $1 LIMIT 1', [id]),
        confirmTour: id => q("UPDATE tour_schedules SET status = 'confirmed' WHERE id = $1", [id]),
        pendingNudges: () => q(`SELECT * FROM listings WHERE status = 'applied' AND broker_email IS NOT NULL
            AND (nudge_notified IS NULL OR nudge_notified = false) AND (nudge_count IS NULL OR nudge_count = 0)
            AND applied_at IS NOT NULL AND ${db.backend === 'sqlite' ? "datetime(applied_at) <= datetime($1)" : 'applied_at <= $1'}
            ORDER BY applied_at, id LIMIT 5`, [new Date(Date.now() - 86400000).toISOString()]),
        markNudgeNotified: id => q('UPDATE listings SET nudge_notified = true WHERE id = $1', [id]),
        recordNudge: id => q('UPDATE listings SET nudged_at = CURRENT_TIMESTAMP, nudge_count = COALESCE(nudge_count, 0) + 1 WHERE id = $1', [id]),
        skipNudge: action => q('UPDATE listings SET nudge_count = 1 WHERE id = $1 OR id_hash = $1', [action]),
        async recordDuplicate({ normalizedAddress, newUrl, newSource }) {
            if (!normalizedAddress) return null;
            // A compare-and-swap retries only a known zero-row conflict, never an
            // ambiguous network result. Parsing in JS also repairs old invalid JSON.
            for (let attempt = 0; attempt < 10; attempt++) {
                const existing = (await q('SELECT id, source, url, cross_posted_sources, is_evaluated, is_notified FROM listings WHERE normalized_address = $1 ORDER BY id LIMIT 1', [normalizedAddress])).rows[0];
                if (!existing || existing.url === newUrl) return existing || null;
                let sources = [];
                try { const parsed = JSON.parse(existing.cross_posted_sources || '[]'); if (Array.isArray(parsed)) sources = parsed; } catch {}
                if (sources.some(source => source.url === newUrl)) return existing;
                sources.push({ source: newSource, url: newUrl, discovered_at: new Date().toISOString() });
                const result = await q('UPDATE listings SET cross_posted_sources = $1 WHERE id = $2 AND (cross_posted_sources = $3 OR (cross_posted_sources IS NULL AND $3 IS NULL))',
                    [JSON.stringify(sources), existing.id, existing.cross_posted_sources]);
                if (result.rowCount) return existing;
            }
            throw new Error('Concurrent deduplication update did not settle');
        }
    };
}
// Quoting is required even after URL encoding: commas, quotes, and parentheses
// have meaning in PostgREST's filter grammar.
const literal = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function createSupabaseRepository(db) {
    const rows = data => ({ rows: data, rowCount: data.length });
    const read = async (table, params = {}) => rows(await db.readAll(table, { select: '*', order: 'id.asc', ...params }));
    const one = async (table, params) => rows((await db.rest(table, { params: { select: '*', order: 'id.asc', ...params, limit: 1 } })).data);
    const eq = value => 'eq.' + literal(value);
    const action = value => ({ or: `(id.${eq(value)},id_hash.${eq(value)})` });
    const mutate = async (table, method, params, json, extra = '') => {
        const result = await db.rest(table, { method, params, json, prefer: `return=representation,count=exact${extra}` });
        const total = result.headers.get('content-range')?.split('/')[1];
        if (!total || total === '*') throw new Error('Supabase mutation returned no affected-row count; verify PostgREST configuration before retrying');
        return { rows: result.data || [], rowCount: Number(total) };
    };
    const patch = (table, params, json) => mutate(table, 'PATCH', params, json);
    const countResult = count => ({ rows: [], rowCount: count });
    return {
        listListings: () => read('listings', { order: 'suitability_score.desc.nullslast,discovered_at.desc,id.asc' }),
        listingExists: id => one('listings', { select: 'id', id: eq(id) }),
        insertListing: data => mutate('listings', 'POST', { on_conflict: 'id' }, checkedFields(data, listingFields), ',resolution=ignore-duplicates'),
        getListing: id => one('listings', action(id)),
        setListingStatus: (id, status) => patch('listings', { id: eq(id) }, { status }),
        passListing: id => patch('listings', action(id), { status: 'passed' }),
        markApplied: async id => countResult(await db.rpc('housing_mark_applied', { p_action: id })),
        setBrokerEmail: (id, email) => patch('listings', action(id), { broker_email: email }),
        pendingNotifications: () => read('listings', { is_evaluated: 'eq.true', is_notified: 'eq.false' }),
        markNotified: id => patch('listings', { id: eq(id) }, { is_notified: true }),
        statsRows: () => read('listings', { select: 'status,suitability_score,building_health,price,evaluation_status' }),
        listTours: () => read('tour_schedules', { order: 'created_at.desc,id.asc' }),
        async countTours() {
            const response = await db.rest('tour_schedules', { params: { select: 'id', limit: 1 }, prefer: 'count=exact' });
            const count = response.headers.get('content-range')?.split('/')[1];
            if (!count || count === '*') throw new Error('Supabase did not return an exact tour count');
            return { rows: [{ count: Number(count) }], rowCount: 1 };
        },
        saveTour: data => mutate('tour_schedules', 'POST', { on_conflict: 'id' }, checkedFields(data, tourFields), ',resolution=ignore-duplicates'),
        getTour: id => one('tour_schedules', { id: eq(id) }),
        confirmTour: id => patch('tour_schedules', { id: eq(id) }, { status: 'confirmed' }),
        pendingNudges: async () => rows(await db.rpc('housing_pending_nudges')),
        markNudgeNotified: id => patch('listings', { id: eq(id) }, { nudge_notified: true }),
        recordNudge: async id => countResult(await db.rpc('housing_record_nudge', { p_id: id })),
        skipNudge: id => patch('listings', action(id), { nudge_count: 1 }),
        recordDuplicate: async ({ normalizedAddress, newUrl, newSource }) => !normalizedAddress ? null :
            (await db.rpc('housing_record_duplicate', { p_address: normalizedAddress, p_url: newUrl, p_source: newSource }))[0] || null
    };
}
const createRepository = db => db.backend === 'supabase' ? createSupabaseRepository(db) : createSqlRepository(db);
const repository = createRepository(pool);
module.exports = { repository, createRepository, createSqlRepository, createSupabaseRepository, literal };
