// Read-only deployment check. Never import db.js: SQL initialization can migrate.
const { createSupabaseClient } = require('../src/supabase_client');

const BASE_MIGRATION = 'migrations/001_https_backends.sql';
const FEATURE_MIGRATION = 'migrations/003_product_features.sql';
const TABLES = ['listings', 'tour_schedules', 'evaluation_control', 'commute_control', 'feature_records'];

function failure(error, migration) {
    if (error?.status === 404) return migration
        ? { status: 'blocked', category: 'migration_required', requiredMigration: migration }
        : { status: 'blocked', category: 'required_table_unavailable' };
    if ([401, 403].includes(error?.status)) return { status: 'blocked', category: 'database_access_denied' };
    if (error?.status === 429) return { status: 'blocked', category: 'database_rate_limited' };
    return { status: 'blocked', category: 'database_unavailable' };
}

async function check({ database, env = process.env } = {}) {
    const checks = [];
    const token = env.HOUSING_OWNER_TOKEN;
    checks.push({ id: 'owner_access', ...(typeof token === 'string' && token.length >= 24 && token.length <= 512
        ? { status: 'ready' }
        : { status: 'blocked', category: token ? 'owner_token_invalid' : 'owner_token_missing', requiredSetting: 'HOUSING_OWNER_TOKEN' }) });

    const ownsClient = !database;
    if (ownsClient) {
        try { database = createSupabaseClient({ env }); }
        catch {
            checks.push({ id: 'database_configuration', status: 'blocked', category: 'supabase_configuration_invalid',
                requiredSettings: ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] });
            return { ready: false, checks };
        }
    }

    try {
        for (const [name, migration] of [['housing_schema_version', BASE_MIGRATION], ['housing_feature_version', FEATURE_MIGRATION]]) {
            try {
                const version = await database.rpc(name);
                checks.push({ id: name, ...(version === 1 ? { status: 'ready', version: 1 }
                    : { status: 'blocked', category: 'schema_incompatible', expectedVersion: 1 }) });
            } catch (error) { checks.push({ id: name, ...failure(error, migration) }); }
        }
        for (const table of TABLES) {
            try {
                // Bounded reads verify access without retrieving message/feature bodies.
                const response = await database.rest(table, { params: {
                    select: table === 'feature_records' ? 'collection,id,revision,updated_at' : 'id',
                    order: table === 'feature_records' ? 'collection.asc,id.asc' : 'id.asc', limit: 1
                } });
                checks.push({ id: table, ...(Array.isArray(response?.data)
                    ? { status: 'ready' } : { status: 'blocked', category: 'invalid_database_response' }) });
            } catch (error) {
                const migration = table === 'feature_records' ? FEATURE_MIGRATION
                    : table === 'commute_control' ? 'migrations/002_google_commute.sql' : null;
                checks.push({ id: table, ...failure(error, migration) });
            }
        }
    } finally {
        if (ownsClient) await database.close().catch(() => {});
    }
    return { ready: checks.every(item => item.status === 'ready'), checks };
}

module.exports = { check };
if (require.main === module) {
    require('dotenv').config({ quiet: true });
    check().then(result => {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ready) process.exitCode = 1;
    }).catch(() => {
        console.error(JSON.stringify({ ready: false, checks: [{ id: 'rollout_check', status: 'blocked', category: 'check_failed' }] }));
        process.exitCode = 1;
    });
}
