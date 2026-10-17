const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercise the real HTTP routes and SQLite storage. Saving an application is a
// private tracking action: the fixtures reject external delivery/provider I/O.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-application-api-'));
const token = 'fixture-owner-token-application-api-2026';
Object.assign(process.env, {
    DB_BACKEND: 'sqlite', DATABASE_URL: '', SQLITE_PATH: path.join(directory, 'test.sqlite'),
    HOUSING_OWNER_TOKEN: '', TARGET_COMMUTE_ADDRESS: '620 8th Avenue, Manhattan, NY',
    TELEGRAM_STATE_DIR: path.join(directory, 'telegram'), INBOX_STATE_DIR: path.join(directory, 'inbox'),
    MAIL_BACKEND: 'smtp-imap', GMAIL_USER: 'fixture-tenant@example.test', GMAIL_APP_PASSWORD: 'fixture',
    GOOGLE_MAPS_API_KEY: '', GEMINI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
    SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: ''
});
let externalAttempts = 0;
const forbidden = async () => { externalAttempts++; throw new Error('External I/O is forbidden in application API fixtures'); };
const mock = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
mock('dotenv', { config() {} });
mock('../src/https_client', {
    createHttpsClient: () => ({ request: forbidden, close: async () => {} }),
    httpsClient: { request: forbidden, close: async () => {} },
    createDispatcher: () => { throw new Error('Unexpected external dispatcher'); }
});
mock('nodemailer', { createTransport: () => ({ sendMail: forbidden }) });
const { initDB, pool } = require('../src/db');
const { featureStore } = require('../src/feature_store');
const { createProductServices } = require('../src/product_services');
const app = require('../src/server');
let server, origin;
const privateMarkers = ['private-document-checklist-note', 'private-application-notes', 'private-negotiated-offer-source', 'private-offer-notes'];
const readListing = async id => (await pool.query('SELECT * FROM listings WHERE id=$1', [id])).rows[0];
async function request(url, { method = 'GET', body, owner = true, authorization } = {}) {
    const response = await fetch(origin + url, { method, headers: {
        ...(owner ? { Authorization: 'Bearer ' + token } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const contentType = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers,
        body: contentType.includes('application/json') ? await response.json() : await response.text() };
}
const editable = record => ({ revision: record.revision, application: structuredClone(record.application) });
before(async () => {
    await initDB();
    await pool.query(`INSERT INTO listings (id,id_hash,title,url,source,price,true_gross_rent,bedrooms,bathrooms,
        neighborhood,location_area,status,is_evaluated,is_notified,suitability_score,evaluation_status,applied_at,nudge_count)
        VALUES ('a','alias-a','20 West 34th Street','https://www.streeteasy.com/building/fixture-a','streeteasy',2500,2500,1,1,
        'Lower East Side','Manhattan','contacted',true,true,88,'completed',null,2),
        ('b','alias-b','100 West 42nd Street','https://www.streeteasy.com/building/fixture-b','streeteasy',2900,2900,1,1,
        'Lower East Side','Manhattan','inbox',true,false,80,'completed',null,0)`);
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1');
        listener.once('listening', () => resolve(listener)); listener.once('error', reject);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end(); fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(externalAttempts, 0, 'Application tracking must not send mail, submit forms or make payments');
});

test('all application routes fail closed and require a valid owner token', async () => {
    const routes = [
        ['/api/applications', 'GET'], ['/api/applications/compare?ids=a,b', 'GET'],
        ['/api/listings/a/application', 'GET'], ['/api/listings/a/application', 'PUT']
    ];
    for (const [url, method] of routes) {
        const body = method === 'PUT' ? { revision: 0, application: {} } : undefined;
        assert.equal((await request(url, { method, body })).status, 503, method + ' ' + url + ' is unavailable without owner configuration');
    }
    process.env.HOUSING_OWNER_TOKEN = token;
    for (const [url, method] of routes) {
        const body = method === 'PUT' ? { revision: 0, application: {} } : undefined;
        assert.equal((await request(url, { method, body, owner: false })).status, 401, method + ' ' + url);
        assert.equal((await request(url, { method, body, authorization: 'Bearer wrong-token' })).status, 401, method + ' ' + url);
    }
    assert.deepEqual(await featureStore.list('applications'), []);
});

test('owner previews and comparisons do not create applications or invent an offer', async () => {
    const initial = await request('/api/listings/a/application');
    assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.equal(initial.body.listingId, 'a'); assert.equal(initial.body.revision, 0);
    assert.equal(initial.body.application.stage, 'preparing');
    assert.equal(initial.body.application.offer.monthlyRent, null);
    assert.equal(initial.body.application.offer.termsConfirmed, false);
    assert.deepEqual(initial.body.activity, []);
    const alias = await request('/api/listings/alias-a/application');
    assert.equal(alias.status, 200); assert.equal(alias.body.listingId, 'a'); assert.equal(alias.body.revision, 0);
    const compared = await request('/api/applications/compare?ids=a,b');
    assert.equal(compared.status, 200); assert.equal(compared.body.currency, 'USD');
    assert.deepEqual(compared.body.applications.map(record => record.listingId), ['a', 'b']);
    assert.ok(compared.body.applications.every(record => record.revision === 0));
    assert.deepEqual((await request('/api/applications')).body.applications, []);
    assert.equal((await request('/api/listings/missing/application')).status, 404);
    assert.equal((await request('/api/applications/compare?ids=a,b,c,d,e')).status, 400);
    assert.deepEqual(await featureStore.list('applications'), [], 'GET requests must not save suggested checklists');
});

test('owner saves private application details without changing listing status or delivery receipts', async () => {
    const beforeListing = await readListing('a');
    const payload = editable((await request('/api/listings/a/application')).body);
    payload.application.notes = privateMarkers[1];
    payload.application.documents = [{ id: 'income-letter', label: 'Income verification letter', required: true,
        status: 'ready', note: privateMarkers[0] }];
    payload.application.deadlines = [{ id: 'application-due', type: 'application', label: 'Application due',
        dueAt: '2026-11-02T10:00:00-05:00', completed: false, reminderMinutes: [1440, 60] }];
    Object.assign(payload.application.offer, {
        monthlyRent: 2500, leaseMonths: 12, freeMonths: 1, rentCredit: 0, monthlyFees: 50,
        oneTimeFees: 100, refundableDeposit: 2500, upfrontRentMonths: 1, upfrontRentCredit: 0,
        leaseStart: '2026-12-01', leaseEnd: '2027-11-30', termsConfirmed: true,
        source: privateMarkers[2], notes: privateMarkers[3]
    });
    const saved = await request('/api/listings/alias-a/application', { method: 'PUT', body: payload });
    assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
    assert.equal(saved.body.listingId, 'a'); assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.application.documents[0].note, privateMarkers[0]);
    assert.equal(saved.body.application.deadlines[0].dueAt, '2026-11-02T15:00:00.000Z');
    assert.equal(saved.body.application.offer.source, privateMarkers[2]);
    assert.ok(saved.body.createdAt); assert.ok(saved.body.updatedAt); assert.ok(saved.body.activity.length > 0);
    assert.equal((await featureStore.list('applications')).length, 1, 'Aliases share the canonical record');
    assert.equal((await featureStore.list('applications'))[0].id, 'a');
    assert.deepEqual(await readListing('a'), beforeListing, 'Local preparation does not mark a listing applied or overwrite worker receipts');
    assert.deepEqual(await featureStore.list('conversation_messages'), []);
    assert.equal(externalAttempts, 0);
});

test('revision conflicts and invalid edits preserve the entire saved application', async () => {
    const initial = (await request('/api/listings/a/application')).body;
    const stale = editable(initial); stale.revision = 0; stale.application.notes = 'Stale overwrite';
    assert.equal((await request('/api/listings/a/application', { method: 'PUT', body: stale })).status, 409);
    assert.deepEqual((await request('/api/listings/a/application')).body, initial);
    const malformed = editable(initial); malformed.application.offer.monthlyRent = -5;
    assert.equal((await request('/api/listings/a/application', { method: 'PUT', body: malformed })).status, 400);
    const unsupportedRent = editable(initial); unsupportedRent.application.offer.monthlyRent = 0.5;
    assert.equal((await request('/api/listings/a/application', { method: 'PUT', body: unsupportedRent })).status, 400,
        'Unsupported sub-dollar rent is an input error, not an internal scoring failure');
    const upload = editable(initial); upload.application.documents[0].content = 'document uploads are not supported';
    assert.equal((await request('/api/listings/a/application', { method: 'PUT', body: upload })).status, 400);
    assert.deepEqual((await request('/api/listings/a/application')).body, initial);
    const first = editable(initial), second = editable(initial);
    first.application.documents[0].status = 'submitted';
    second.application.documents[0].status = 'not_needed';
    const concurrent = await Promise.all([
        request('/api/listings/a/application', { method: 'PUT', body: first }),
        request('/api/listings/a/application', { method: 'PUT', body: second })
    ]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
    const current = (await request('/api/listings/a/application')).body;
    assert.equal(current.revision, initial.revision + 1);
    assert.deepEqual(current, concurrent.find(response => response.status === 200).body);
    assert.ok(current.activity.length > initial.activity.length);
});

test('recorded submission, approval and signing stages retain history without sending or paying', async () => {
    const beforeListing = await readListing('a');
    const initial = (await request('/api/listings/a/application')).body;
    let current = initial;
    for (const stage of ['submitted', 'approved', 'lease_signed']) {
        const payload = editable(current); payload.application.stage = stage;
        const updated = await request('/api/listings/a/application', { method: 'PUT', body: payload });
        assert.equal(updated.status, 200); current = updated.body;
        assert.equal(current.application.stage, stage);
        assert.ok(current.stageTimestamps[stage]);
        assert.equal(current.application.notes, privateMarkers[1]);
    }
    assert.equal(current.revision, initial.revision + 3);
    assert.ok(current.activity.length >= initial.activity.length + 3);
    assert.deepEqual(current.activity.slice(0, initial.activity.length), initial.activity, 'Earlier audit entries remain intact');
    assert.deepEqual(await readListing('a'), beforeListing, 'Recording an application stage does not submit a broker inquiry');
    assert.deepEqual(await featureStore.list('conversation_messages'), []);
    assert.equal(externalAttempts, 0);
});

test('private application records are absent from public listing reads and survive service recreation', async () => {
    const saved = (await request('/api/listings/a/application')).body;
    const compared = await request('/api/applications/compare?ids=a,b');
    assert.equal(compared.status, 200); assert.equal(compared.body.applications[0].revision, saved.revision);
    assert.equal(compared.body.applications[0].application.offer.monthlyRent, 2500);
    assert.equal(compared.body.applications[1].application.offer.monthlyRent, null);
    assert.equal(compared.body.applications[1].revision, 0);
    assert.equal((await request('/api/applications')).body.applications.length, 1);
    const publicListings = await request('/api/listings', { owner: false });
    assert.equal(publicListings.status, 200);
    const serialized = JSON.stringify(publicListings.body);
    for (const marker of privateMarkers) assert.equal(serialized.includes(marker), false, marker + ' must remain private');
    for (const listing of publicListings.body) {
        for (const property of ['application', 'documents', 'deadlines', 'offer', 'activity', 'stageTimestamps']) {
            assert.equal(Object.hasOwn(listing, property), false, property + ' must not be added to public listings');
        }
    }
    for (const url of ['/api/preferences', '/api/health', '/api/stats', '/api/commute/status', '/api/listings/a/insights']) {
        const publicResponse = await request(url, { owner: false });
        assert.equal(publicResponse.status, 200, url + ' remains readable');
        for (const marker of privateMarkers) {
            assert.equal(JSON.stringify(publicResponse.body).includes(marker), false, url + ' must not expose ' + marker);
        }
    }
    const restarted = createProductServices({ localHealth: false });
    assert.deepEqual(await restarted.applications.get('a'), saved);
    assert.deepEqual(await restarted.applications.get('alias-a'), saved);
    assert.equal((await restarted.applications.list()).applications.length, 1);
    assert.equal((await featureStore.list('applications')).length, 1);
});
