const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DATABASE_URL = '';
process.env.GEMINI_API_KEY = 'fixture';
const { migrate } = require('../src/db');
const { migrateEvaluationQueue } = require('../src/evaluation_migration');
const { createQueue, LEASE_MS } = require('../src/evaluation_queue');
const { runWorker, fetchDescription } = require('../src/evaluation_worker');
const { validateEvaluation, runAIEvaluation, applyScoringRules } = require('../src/evaluator');
const { calculateRent } = require('../src/rent');
const { EvaluationError, summaries } = require('../src/evaluation_errors');
let db, admin, schema, sqlite, dir, clock;
const now = () => clock;
const valid = () => ({ suitability_score: 90, true_gross_rent: 2500, is_fee: false, fee_estimate: 'None',
    rent_terms: { concessions_mentioned: false, lease_months: null, free_months: 0, rent_credit: 0 },
    location_area: 'Manhattan', neighborhood: "Hell's Kitchen", is_preferred_neighborhood: true,
    commute_minutes: 15, commute_summary: '15 minutes via subway', pros: ['Dishwasher'], red_flags: [] });
const health = async () => ({ grade: 'Unknown', isHazardous: false, summary: 'Unverified' });
const options = extra => ({ db, now, sleep: async ms => { clock += ms; },
    describe: async () => 'A one bedroom apartment with dishwasher, no fee, $2500 gross rent.',
    evaluate: async () => valid(), healthCheck: health, log() {}, ...extra });
const row = async id => (await db.query('SELECT * FROM listings WHERE id = $1', [id])).rows[0];
async function insert(id, status = 'inbox') {
    await db.query(`INSERT INTO listings (id, title, url, price, bedrooms, bathrooms, status, discovered_at)
        VALUES ($1, $2, $3, 2500, 1, 1, $4, $5)`, [id, '350 West 50th Street #4B', 'https://example.test/' + id, status, new Date(clock).toISOString()]);
}
before(async () => {
    if (process.env.QUEUE_TEST_DATABASE_URL) {
        assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.QUEUE_TEST_DATABASE_URL).hostname), 'PostgreSQL tests require a disposable local database');
        const { Pool } = require('pg');
        const config = { connectionString: process.env.QUEUE_TEST_DATABASE_URL, ssl: ['localhost', '127.0.0.1'].includes(new URL(process.env.QUEUE_TEST_DATABASE_URL).hostname) ? false : { rejectUnauthorized: false } };
        schema = 'housing_queue_test_' + require('node:crypto').randomBytes(8).toString('hex');
        admin = new Pool(config);
        await admin.query(`CREATE SCHEMA ${schema}`);
        db = new Pool({ ...config, options: '-c search_path=' + schema });
    } else {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-queue-'));
        const sqlite3 = require('sqlite3');
        sqlite = await new Promise((resolve, reject) => { const d = new sqlite3.Database(path.join(dir, 'test.db'), e => e ? reject(e) : resolve(d)); });
        sqlite.configure('busyTimeout', 10000);
        db = { query(sql, params = []) {
            const values = [];
            sql = sql.replace(/\$(\d+)/g, (_, n) => { const v = params[n - 1]; values.push(typeof v === 'boolean' ? Number(v) : v); return '?'; });
            return new Promise((resolve, reject) => {
                if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) sqlite.all(sql, values, (e, rows) => e ? reject(e) : resolve({ rows, rowCount: rows.length }));
                else sqlite.run(sql, values, function(e) { e ? reject(e) : resolve({ rows: [], rowCount: this.changes }); });
            });
        } };
    }
    await migrate(db.query.bind(db), sqlite ? 'sqlite' : 'pg');
});
beforeEach(async () => {
    clock = Date.parse('2026-10-12T20:00:00Z');
    await db.query('DELETE FROM listings');
    await db.query('UPDATE evaluation_control SET pause_until = NULL, next_request_at = NULL');
});
after(async () => {
    if (db?.end) await db.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
    if (sqlite) await new Promise(resolve => sqlite.close(resolve));
    if (dir) fs.rmSync(dir, { recursive: true });
});
test('additive migration backfills scores including zero and preserves user fields; idempotent', async () => {
    await insert('scored'); await insert('zero'); await insert('pending');
    await db.query(`UPDATE listings SET is_evaluated = true, suitability_score = 0, status = 'applied',
        is_notified = true, is_preferred = true, red_flags = '[]', pros = '["saved"]' WHERE id = 'zero'`);
    await db.query("UPDATE listings SET is_evaluated = true, suitability_score = 89 WHERE id = 'scored'");
    const before = await row('zero');
    // Exercise the upgrade from an actual pre-queue schema.
    await db.query('DROP INDEX listings_evaluation_queue_idx');
    for (const name of Object.keys(require('../src/evaluation_migration').evaluationColumns)) await db.query(`ALTER TABLE listings DROP COLUMN ${name}`);
    await migrateEvaluationQueue(db.query.bind(db), sqlite ? 'sqlite' : 'pg');
    const once = await row('zero');
    await migrateEvaluationQueue(db.query.bind(db), sqlite ? 'sqlite' : 'pg');
    assert.deepEqual(await row('zero'), once);
    for (const key of ['suitability_score', 'status', 'is_notified', 'is_preferred', 'red_flags', 'pros']) assert.equal(once[key], before[key]);
    assert.equal(once.evaluation_status, 'completed');
    assert.equal((await row('scored')).evaluation_status, 'completed');
    assert.equal((await row('pending')).evaluation_status, 'pending');
});
test('successful evaluation, zero score, location enforcement, and Unknown health', async () => {
    await insert('a'); await insert('b'); await insert('c');
    await db.query("UPDATE listings SET price = 1700 WHERE id = 'a'");
    const result = await runWorker(options({ limit: 3, evaluate: async l => ({ ...valid(), true_gross_rent: l.price, neighborhood: l.id === 'c' ? 'Harlem' : "Hell's Kitchen" }) }));
    assert.equal(result.completed, 3);
    assert.equal((await row('a')).suitability_score, 0);
    assert.equal((await row('b')).suitability_score, 90);
    assert.equal((await row('c')).suitability_score, 74);
    assert.equal(JSON.parse((await row('b')).building_health).grade, 'Unknown');
});
test('rent migration preserves scored records and leaves historical rent unverified', async () => {
    const { migrateRentTerms, rentColumns } = require('../src/rent_migration');
    await insert('old');
    await db.query("UPDATE listings SET is_evaluated = true, suitability_score = 87, true_gross_rent = 5225, price = 4644 WHERE id = 'old'");
    for (const name of Object.keys(rentColumns)) await db.query(`ALTER TABLE listings DROP COLUMN ${name}`);
    const before = await row('old');
    await migrateRentTerms(db.query.bind(db), sqlite ? 'sqlite' : 'pg');
    const after = await row('old');
    for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key]);
    assert.equal(after.effective_monthly_rent, null); assert.equal(after.rent_terms, null);
    await migrateRentTerms(db.query.bind(db), sqlite ? 'sqlite' : 'pg');
    assert.deepEqual(await row('old'), after);
});
test('concession rent is calculated, persisted, and used for budget rather than advertised or gross rent', async () => {
    await insert('concession');
    await db.query("UPDATE listings SET price = 5225, bedrooms = 2, bathrooms = 2 WHERE id = 'concession'");
    const result = { ...valid(), true_gross_rent: 5225, effective_monthly_rent: 1,
        rent_terms: { concessions_mentioned: true, lease_months: 18, free_months: 2, rent_credit: 0 } };
    await runWorker(options({ evaluate: async () => result }));
    const saved = await row('concession');
    assert.equal(saved.suitability_score, 90);
    assert.equal(Number(saved.effective_monthly_rent), 4644.44);
    assert.equal(saved.true_gross_rent, 5225);
    assert.deepEqual(JSON.parse(saved.red_flags), []);
    assert.deepEqual(JSON.parse(saved.rent_terms), { ...result.rent_terms, gross_monthly_rent: 5225 });
    const { evaluation } = await applyScoringRules({ price: 2000, bedrooms: 2, bathrooms: 2 },
        { ...result, true_gross_rent: 6000 }, { healthCheck: async () => ({ grade: 'A' }) });
    assert.equal(evaluation.effective_monthly_rent, 5333.33);
    assert.equal(evaluation.suitability_score, 40, 'Health bonus cannot defeat budget cap');
});
test('rent credits, fractional free months, missing terms, and studio limits', async () => {
    const terms = { concessions_mentioned: true, lease_months: 12, free_months: 1.5, rent_credit: 600 };
    assert.equal(calculateRent(3000, terms).effective_monthly_rent, 2575);
    assert.equal(calculateRent(2500.50, { ...terms, concessions_mentioned: false, free_months: 0, rent_credit: 0 }).effective_monthly_rent, 2500.50);
    for (const rent_terms of [terms, { ...terms, free_months: 0, rent_credit: 0 }, { ...terms, lease_months: null }]) {
        const { evaluation } = await applyScoringRules({ price: 2500, bedrooms: 0, bathrooms: 1 },
            { ...valid(), true_gross_rent: 3000, rent_terms }, { healthCheck: health });
        assert.equal(evaluation.suitability_score, rent_terms === terms ? 90 : 40);
        if (rent_terms.lease_months === null) {
            assert.equal(evaluation.effective_monthly_rent, null);
            assert.ok(evaluation.red_flags.some(s => s.includes('terms incomplete')));
        }
    }
    for (const patch of [{ lease_months: 0 }, { lease_months: 12.5 }, { lease_months: '12' },
        { free_months: -1 }, { free_months: 12 }, { rent_credit: 50000 }, { rent_credit: NaN },
        { concessions_mentioned: false }, { concessions_mentioned: 'true' }]) {
        assert.throws(() => calculateRent(3000, { ...terms, ...patch }), /invalid evaluation/);
    }
    assert.throws(() => validateEvaluation({ ...valid(), rent_terms: undefined }), /invalid evaluation/);
});
test('missing description and malformed responses retry later and do not starve later rows', async () => {
    for (const id of ['a', 'b', 'c']) await insert(id);
    const result = await runWorker(options({ limit: 3, describe: async l => l.id === 'a' ? '' : 'Apartment description',
        evaluate: async l => l.id === 'b' ? { ...valid(), pros: [123] } : valid() }));
    assert.equal(result.claimed, 3); assert.equal(result.aiCalls, 2); assert.equal(result.completed, 1);
    assert.equal((await row('a')).evaluation_status, 'retry_wait');
    assert.equal((await row('b')).evaluation_last_error, summaries.invalid);
    assert.equal((await row('c')).evaluation_status, 'completed');
});
test('one-minute/five-minute retry delays, three-attempt exhaustion, and passed rows skipped', async () => {
    await insert('a'); await insert('passed', 'passed');
    const q = createQueue(db, now);
    let claim = await q.claim(); await q.fail(claim, 'description');
    clock += 59999; assert.equal(await q.claim(), null);
    clock++; claim = await q.claim(); assert.equal(claim.evaluation_attempts, 2); await q.fail(claim, 'invalid');
    clock += 299999; assert.equal(await q.claim(), null);
    clock++; claim = await q.claim(); assert.equal(claim.evaluation_attempts, 3); await q.fail(claim, 'transient');
    assert.equal((await row('a')).evaluation_status, 'failed');
    clock += LEASE_MS; assert.equal(await q.claim(), null);
    assert.equal((await row('passed')).evaluation_attempts, 0);
});
test('competing claims cannot evaluate the same listing; old results cannot overwrite a newer lease', async () => {
    await insert('a');
    const q = createQueue(db, now), other = createQueue(db, now);
    const claims = await Promise.all([q.claim(), other.claim()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const old = claims.find(Boolean);
    clock += LEASE_MS;
    assert.equal(await q.complete(old, valid(), await health()), false);
    await q.recoverExpired();
    assert.equal((await row('a')).evaluation_status, 'retry_wait');
    clock += 60000;
    const next = await other.claim(); assert.notEqual(next.evaluation_claim_token, old.evaluation_claim_token);
    assert.equal((await q.fail(old, 'invalid')).rowCount, 0);
    assert.equal(await q.complete(old, { ...valid(), suitability_score: 1 }, await health()), false);
    assert.equal(await other.complete(next, valid(), await health()), true);
    assert.equal((await row('a')).suitability_score, 90);
});
test('missing credentials fail before any claim; authentication releases and halts', async () => {
    await insert('a'); await insert('b');
    delete process.env.GEMINI_API_KEY;
    try { await assert.rejects(runWorker(options()), /credentials are missing/); }
    finally { process.env.GEMINI_API_KEY = 'fixture'; }
    assert.equal((await row('a')).evaluation_attempts, 0);
    const result = await runWorker(options({ evaluate: async () => { throw new EvaluationError('configuration'); } }));
    assert.equal(result.stopped, 'configuration'); assert.equal(result.claimed, 1);
    assert.equal((await row('a')).evaluation_attempts, 0);
    assert.equal((await row('a')).evaluation_claim_token, null);
});
test('rate limits persist a shared pause, respect longer Retry-After and do not spend retry budgets', async () => {
    await insert('a'); await insert('b');
    const result = await runWorker(options({ evaluate: async () => { throw new EvaluationError('rate_limit', 900000); } }));
    assert.equal(result.aiCalls, 1); assert.equal(result.stopped, 'rate_limit');
    assert.equal((await row('a')).evaluation_attempts, 0);
    const q = createQueue(db, now);
    assert.equal(await q.pauseUntil(), clock + 900000);
    assert.equal(await q.claim(), null); assert.equal(await q.reserveRequest(), false);
    clock += 900000; assert.ok(await q.claim());
});
test('10 listing / 10 AI call cap, distinct rows only and shared five-second spacing', async () => {
    for (let i = 0; i < 12; i++) await insert(String(i).padStart(2, '0'));
    const starts = [];
    const result = await runWorker(options({ limit: 10, noRetries: true, evaluate: async () => { starts.push(clock); return valid(); } }));
    assert.equal(result.claimed, 10); assert.equal(result.aiCalls, 10); assert.equal(result.completed, 10);
    assert.equal(new Set(result.results.map(r => r.id)).size, 10);
    assert.ok(starts.slice(1).every((at, i) => at - starts[i] >= 5000));
    assert.equal((await row('10')).evaluation_attempts, 0);
});
test('no-retries trial skips previously attempted rows', async () => {
    await insert('a'); await insert('b'); const q = createQueue(db, now);
    await q.fail(await q.claim(), 'description'); clock += 60000;
    const result = await runWorker(options({ noRetries: true }));
    assert.deepEqual(result.results.map(r => r.id), ['b']);
    assert.equal((await row('a')).evaluation_attempts, 1);
});
test('shutdown aborts work and releases the claim without saving late results', async () => {
    await insert('a'); const controller = new AbortController(); let aborted = false, finish;
    const result = await runWorker(options({ signal: controller.signal, evaluate: async (_, __, { signal }) => {
        signal.addEventListener('abort', () => { aborted = true; });
        setTimeout(() => controller.abort(new EvaluationError('shutdown')), 5);
        return new Promise(resolve => { finish = resolve; });
    } }));
    assert.ok(aborted); assert.equal(result.stopped, 'shutdown');
    assert.equal((await row('a')).evaluation_attempts, 0);
    finish(valid()); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await row('a')).evaluation_status, 'pending');
});
test('AI timeout cancels request and retries; whole-attempt timeout closes browser', async () => {
    await insert('a'); let aborted = false;
    await runWorker(options({ aiTimeoutMs: 10, evaluate: async (_, __, { signal }) => new Promise(() => {
        signal.addEventListener('abort', () => { aborted = true; });
    }) }));
    assert.ok(aborted); assert.equal((await row('a')).evaluation_last_error, summaries.timeout);
    await insert('b'); let closed = false;
    await runWorker(options({ attemptTimeoutMs: 10, describe: (l, opts) => fetchDescription(l, { ...opts, launch: async () => ({
        newPage: async () => ({ goto: async () => new Promise(() => {}) }), close: async () => { closed = true; }
    }) }) }));
    assert.ok(closed); assert.equal((await row('b')).evaluation_status, 'retry_wait');
});
test('provider transport calls once, honors override, sanitizes errors, and parses retry instructions', async () => {
    let calls = 0; process.env.GEMINI_MODEL = 'fixture-model';
    try {
        const result = await runAIEvaluation({ title: 'Fixture' }, 'Description', { fetchImpl: async (url, opts) => {
            calls++; assert.ok(url.endsWith('/fixture-model:generateContent')); assert.equal(opts.headers['x-goog-api-key'], 'fixture');
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(valid()) }] } }] }), { status: 200 });
        } });
        assert.equal(result.suitability_score, 90); assert.equal(calls, 1);
        for (const status of [400, 401, 403, 404, 429, 503]) {
            await assert.rejects(runAIEvaluation({}, '', { fetchImpl: async () => new Response(JSON.stringify({ error: {
                message: 'secret-key in private provider output', details: [{ retryDelay: '1000s' }]
            } }), { status, headers: { 'retry-after': '900' } }) }), err => {
                assert.ok(!err.message.includes('secret-key'));
                if (status === 429) assert.equal(err.retryAfterMs, 1000000);
                return err.code === (status === 429 ? 'rate_limit' : status === 503 ? 'transient' : 'configuration');
            });
        }
    } finally { delete process.env.GEMINI_MODEL; }
});
test('strict response validation rejects invalid rents, scores and typed fields', () => {
    for (const patch of [{ suitability_score: NaN }, { suitability_score: 101 }, { suitability_score: -1 },
        { true_gross_rent: 0 }, { true_gross_rent: '2500' }, { is_fee: 'false' }, { pros: [null] },
        { red_flags: [123] }, { commute_minutes: -1 }, { neighborhood: null }, { location_area: 'Made up' }]) {
        assert.throws(() => validateEvaluation({ ...valid(), ...patch }), /invalid evaluation/);
    }
});
test('continuous worker polls empty queue every 30 seconds and stops on shutdown', async () => {
    const controller = new AbortController(), sleeps = [];
    await runWorker(options({ continuous: true, signal: controller.signal, sleep: async ms => { sleeps.push(ms); controller.abort(); } }));
    assert.deepEqual(sleeps, [30000]);
});
