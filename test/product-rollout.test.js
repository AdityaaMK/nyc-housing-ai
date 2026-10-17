const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('../scripts/check-product-rollout');

const env = { HOUSING_OWNER_TOKEN: 'fixture-owner-token-is-long-enough' };
function fixture({ versions = {}, errors = {}, responses = {} } = {}) {
    const calls = [];
    return { calls,
        async rpc(name) {
            calls.push({ method: 'rpc', name });
            if (errors[name]) throw errors[name];
            return Object.hasOwn(versions, name) ? versions[name] : 1;
        },
        async rest(name, options) {
            calls.push({ method: 'rest', name, options });
            if (errors[name]) throw errors[name];
            return Object.hasOwn(responses, name) ? responses[name] : { data: [] };
        },
        async close() { throw new Error('Injected clients belong to their caller'); }
    };
}
const error = status => Object.assign(new Error('Sensitive provider body and credential must not appear'), { status });

test('rollout check uses only version reads and bounded table reads, accepts empty tables, and never returns rows', async () => {
    const database = fixture({ responses: { feature_records: { data: [{ id: 'private-id', collection: 'private-collection', revision: 3, updated_at: 'private-date' }] } } });
    const result = await check({ database, env });
    assert.equal(result.ready, true);
    assert.equal(result.checks.length, 8);
    assert.deepEqual(database.calls.filter(call => call.method === 'rpc').map(call => call.name), ['housing_schema_version', 'housing_feature_version']);
    const reads = database.calls.filter(call => call.method === 'rest');
    assert.deepEqual(reads.map(call => call.name), ['listings', 'tour_schedules', 'evaluation_control', 'commute_control', 'feature_records']);
    for (const call of reads) {
        assert.equal(call.options.params.limit, 1);
        assert.equal(call.options.method, undefined);
        assert.equal(call.options.json, undefined);
        assert.ok(!call.options.params.select.includes('*'));
    }
    assert.doesNotMatch(JSON.stringify(result), /private-|fixture-owner-token/);
});

test('missing feature RPC and table explicitly require migration 003 while other checks continue', async () => {
    const database = fixture({ errors: { housing_feature_version: error(404), feature_records: error(404) } });
    const result = await check({ database, env });
    assert.equal(result.ready, false);
    for (const id of ['housing_feature_version', 'feature_records']) {
        assert.deepEqual(result.checks.find(item => item.id === id), { id, status: 'blocked', category: 'migration_required', requiredMigration: 'migrations/003_product_features.sql' });
    }
    assert.equal(result.checks.find(item => item.id === 'listings').status, 'ready');
    assert.doesNotMatch(JSON.stringify(result), /Sensitive|credential/);
});

test('owner configuration validates the process token without returning it or preventing database diagnostics', async () => {
    for (const [token, category] of [[undefined, 'owner_token_missing'], ['', 'owner_token_missing'], ['short', 'owner_token_invalid'], ['x'.repeat(513), 'owner_token_invalid']]) {
        const database = fixture();
        const result = await check({ database, env: { HOUSING_OWNER_TOKEN: token } });
        assert.equal(result.ready, false);
        assert.deepEqual(result.checks[0], { id: 'owner_access', status: 'blocked', category, requiredSetting: 'HOUSING_OWNER_TOKEN' });
        assert.equal(database.calls.length, 7);
    }
});

test('database failures and incompatible schemas are categorized without exposing errors', async () => {
    const database = fixture({ versions: { housing_schema_version: 2 }, errors: {
        housing_feature_version: error(401), listings: error(403), tour_schedules: error(429),
        evaluation_control: error(503), commute_control: error(404)
    }, responses: { feature_records: { data: { private: true } } } });
    const result = await check({ database, env });
    assert.equal(result.ready, false);
    const categories = Object.fromEntries(result.checks.map(item => [item.id, item.category]));
    assert.equal(categories.housing_schema_version, 'schema_incompatible');
    assert.equal(categories.housing_feature_version, 'database_access_denied');
    assert.equal(categories.listings, 'database_access_denied');
    assert.equal(categories.tour_schedules, 'database_rate_limited');
    assert.equal(categories.evaluation_control, 'database_unavailable');
    assert.equal(categories.commute_control, 'migration_required');
    assert.equal(categories.feature_records, 'invalid_database_response');
    assert.doesNotMatch(JSON.stringify(result), /Sensitive|credential|private/);
});

test('missing Supabase configuration is reported safely before any network request', async () => {
    const result = await check({ env: {} });
    assert.equal(result.ready, false);
    assert.deepEqual(result.checks[1], { id: 'database_configuration', status: 'blocked', category: 'supabase_configuration_invalid', requiredSettings: ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] });
});
