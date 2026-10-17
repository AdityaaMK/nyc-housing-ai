const { pool } = require('./db');
const { literal } = require('./repository');
const conflict = () => Object.assign(new Error('This record changed. Reload it before saving.'), { status: 409, code: 'revision_conflict' });
function validate(collection, id, data) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(collection) || typeof id !== 'string' || !id.length || id.length > 2048) throw new Error('Invalid record key');
    if (data !== undefined && (!data || typeof data !== 'object' || JSON.stringify(data).length > 250000)) throw new Error('Invalid record data');
}
const decode = row => row ? { ...row, revision: Number(row.revision), data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data } : null;
function createFeatureStore(db = pool, now = Date.now) {
    const remote = db.backend === 'supabase';
    async function get(collection, id) {
        validate(collection, id);
        if (remote) return decode((await db.rest('feature_records', { params: { select: '*', collection: 'eq.' + literal(collection), id: 'eq.' + literal(id), limit: 1 } })).data[0]);
        return decode((await db.query('SELECT * FROM feature_records WHERE collection=$1 AND id=$2', [collection, id])).rows[0]);
    }
    async function list(collection) {
        validate(collection, '_');
        return (remote ? await db.readAll('feature_records', { select: '*', collection: 'eq.' + literal(collection), order: 'id.asc' }) :
            (await db.query('SELECT * FROM feature_records WHERE collection=$1 ORDER BY id', [collection])).rows).map(decode);
    }
    async function exchange(collection, id, data, revision, remove = false) {
        validate(collection, id, data);
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('A nonnegative record revision is required');
        if (remote) return decode(await db.rpc('housing_feature_exchange', { p_collection: collection, p_id: id,
            p_data: data === undefined ? null : JSON.stringify(data), p_revision: revision, p_remove: remove }));
        const at = new Date(now()).toISOString();
        let result;
        if (remove) result = await db.query('DELETE FROM feature_records WHERE collection=$1 AND id=$2 AND revision=$3 RETURNING *', [collection, id, revision]);
        else if (!revision) result = await db.query(`INSERT INTO feature_records (collection,id,data,revision,updated_at) VALUES ($1,$2,$3,1,$4)
            ON CONFLICT(collection,id) DO NOTHING RETURNING *`, [collection, id, JSON.stringify(data), at]);
        else result = await db.query(`UPDATE feature_records SET data=$3, revision=revision+1, updated_at=$4
            WHERE collection=$1 AND id=$2 AND revision=$5 RETURNING *`, [collection, id, JSON.stringify(data), at, revision]);
        return decode(result.rows[0]);
    }
    async function put(collection, id, data, { expectedRevision } = {}) {
        const revision = expectedRevision ?? (await get(collection, id))?.revision ?? 0;
        const result = await exchange(collection, id, data, revision);
        if (!result) throw conflict();
        return result;
    }
    async function create(collection, id, data) {
        return await exchange(collection, id, data, 0) || await get(collection, id);
    }
    async function remove(collection, id, { expectedRevision } = {}) {
        const previous = await get(collection, id);
        if (!previous) { if (expectedRevision) throw conflict(); return null; }
        const result = await exchange(collection, id, undefined, expectedRevision ?? previous.revision, true);
        if (!result) throw conflict();
        return result;
    }
    async function update(collection, id, transform) {
        for (let attempt = 0; attempt < 8; attempt++) {
            const previous = await get(collection, id);
            const result = await exchange(collection, id, transform(previous?.data ?? null, previous), previous?.revision ?? 0);
            if (result) return result;
        }
        throw conflict();
    }
    const enqueueEvent = event => create('events', event.id, { ...event, status: 'pending', created_at: event.created_at ?? now() });
    return { get, list, create, put, remove, update, enqueueEvent,
        async verify() {
            if (remote && await db.rpc('housing_feature_version') !== 1) throw new Error('Feature schema is not installed');
            if (!remote) await db.query('SELECT collection FROM feature_records LIMIT 1');
        } };
}
const featureStore = createFeatureStore();
module.exports = { createFeatureStore, featureStore, conflict };
