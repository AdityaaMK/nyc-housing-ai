const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATABASE_URL = '';
process.env.DB_BACKEND = 'sqlite';
delete process.env.MAIL_BACKEND; // Fixture IMAP/SMTP, including legacy best-effort polling.
delete process.env.GMAIL_CREDENTIALS_FILE;
process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'housing-e2e-')), 'test.db');
process.env.GEMINI_API_KEY = 'fixture';
process.env.TELEGRAM_BOT_TOKEN = 'fixture';
process.env.TELEGRAM_CHAT_ID = 'fixture';
process.env.GMAIL_USER = 'tenant@example.test';
process.env.GMAIL_APP_PASSWORD = 'fixture';
const alerts = [], emails = [], flags = [];
let failAlert = false;
function mock(name, exports) { require.cache[require.resolve(name)] = { exports }; }
mock('dotenv', { config() {} });
mock('node-telegram-bot-api', { Api: class { async sendMessage(message) { if (failAlert) throw new Error('simulated outage'); alerts.push(message); } } });
mock('nodemailer', { createTransport: () => ({ sendMail: async mail => { emails.push(mail); return { messageId: 'fixture' }; } }) });
const listing = { '@type': 'Apartment', '@id': 'fixture-listing', url: 'https://example.test/listing', name: '350 W 50th St #4B', numberOfBedrooms: 1, numberOfBathroomsTotal: 1, additionalProperty: [{ name: "Monthly Rent", value: "$2,500/mo" }] };
mock('puppeteer-extra', {
 use() {}, async launch() { return {
  async newPage() { return { async goto() {}, async content() { return `<script type="application/ld+json">${JSON.stringify(listing)}</script>`; }, async evaluate() { return []; }, async $$eval() { return 'One bedroom apartment, dishwasher, no fee, gross rent $2500'; }, async setUserAgent() {}, async setViewport() {}, async close() {} }; }, async close() {}
 }; }
});
mock('../src/building_health', { checkBuildingHealth: async () => ({ grade: 'Unknown', summary: 'Fixture lookup unavailable', isHazardous: false }) });
mock('@google/generative-ai', { GoogleGenerativeAI: class { getGenerativeModel() { return { async generateContent(prompt) {
 const data = prompt.includes('parsing an inbound') ? {
  is_tour_invitation: true, proposed_datetime: '2026-10-20T17:30:00-04:00', human_readable_time: 'October 20 at 5:30 PM', listing_address: listing.name, broker_name: 'Broker & Partner', broker_email: 'wrong-address@example.test', summary: 'A tour <offered>', special_instructions: 'Buzz 4B'
 } : { suitability_score: 90, red_flags: [], pros: ['Dishwasher'], true_gross_rent: 2500, rent_terms: { concessions_mentioned: false, lease_months: null, free_months: 0, rent_credit: 0 }, is_fee: false, fee_estimate: 'None', neighborhood: "Hell's Kitchen", location_area: 'Manhattan', is_preferred_neighborhood: true, commute_minutes: 15, commute_summary: '15 minutes via subway' };
 const boundary = prompt.match(/Listing Title: Commute boundary (\d+(?:\.\d+)?)/);
 if (boundary) Object.assign(data, {
  neighborhood: 'Williamsburg', location_area: 'Brooklyn', commute_minutes: 45,
  manhattan_commute_minutes: Number(boundary[1]), manhattan_arrival_station: '1 Av',
  manhattan_commute_summary: 'Walk, typical wait, L train to 1 Av in Manhattan'
 });
 return { response: { text: () => JSON.stringify(data) } };
 } }; } } });
mock('imap-simple', { connect: async () => ({
 imap: { _box: { uidvalidity: 123 } }, async openBox() {}, async search() { return [{ attributes: { uid: 42 }, parts: [{ which: '', body: 'Subject: Apartment tour\r\nFrom: Broker <broker@example.test>\r\nDate: Mon, 12 Oct 2026 12:00:00 -0400\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nTour offered October 20 at 5:30 PM' }] }]; }, async addFlags(uid) { flags.push(uid); }, end() {}
}) });
const { initDB, pool } = require('../src/db');
const app = require('../src/server');
let server;
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await pool.end(); });
test('listing ingestion → deduplication → AI → notification retry → tour → API → simulated confirmation and nudge', async () => {
 await initDB();
 await require('../src/scraper').scrapeStreetEasy();
 let rows = (await pool.query('SELECT * FROM listings')).rows;
 assert.equal(rows.length, 1);
 await require('../src/normalizer').checkOrRecordDuplicate(pool, { normalizedAddress: rows[0].normalized_address, newUrl: 'https://compass.example.test/fixture', newSource: 'compass' });
 await require('../src/evaluator').evaluateListings({ evaluate: async () => ({
  suitability_score: 90, red_flags: [], pros: ['Dishwasher'], true_gross_rent: 2500,
  rent_terms: { concessions_mentioned: false, lease_months: null, free_months: 0, rent_credit: 0 },
  is_fee: false, fee_estimate: 'None', neighborhood: "Hell's Kitchen", location_area: 'Manhattan',
  is_preferred_neighborhood: true, commute_minutes: 15, commute_summary: '15 minutes via subway'
 }) });
 rows = (await pool.query('SELECT * FROM listings')).rows;
 assert.equal(rows[0].suitability_score, 90, 'Unknown health must not give a score bonus');
 assert.equal(rows[0].is_evaluated, 1);
 assert.equal(JSON.parse(rows[0].cross_posted_sources)[0].source, 'compass');
 const { notifyHighScoringListings } = require('../src/notifier');
 failAlert = true;
 await notifyHighScoringListings();
 assert.equal((await pool.query('SELECT is_notified FROM listings')).rows[0].is_notified, 0);
 failAlert = false;
 await notifyHighScoringListings();
 assert.equal((await pool.query('SELECT is_notified FROM listings')).rows[0].is_notified, 1);
 const inbound = require('../src/inbound_listener');
 failAlert = true;
 await inbound.checkInboundReplies();
 assert.equal(flags.length, 0, 'Undelivered tour must remain unread');
 failAlert = false;
 await inbound.checkInboundReplies();
 assert.equal(flags.length, 1);
 assert.equal((await pool.query('SELECT COUNT(*) AS count FROM tour_schedules')).rows[0].count, 1);
 assert.ok(alerts.at(-1).text.includes('Broker &amp; Partner'));
 server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1'); listener.once('listening', () => resolve(listener)); listener.once('error', error => { throw error; }); });
 const base = `http://127.0.0.1:${server.address().port}`;
 const tours = await (await fetch(base + '/api/tours')).json();
 assert.match(tours[0].calendar_url, /20261020T213000Z\/20261020T221500Z/);
 assert.equal(tours[0].broker_email, 'broker@example.test', 'Use actual sender, not model-generated recipient');
 const stats = await (await fetch(base + '/api/stats')).json();
 assert.equal(stats.tours, 1);
 assert.equal(stats.total, 1);
 assert.equal((await fetch(base + '/api/listings')).status, 200);
 assert.equal((await fetch(base + '/api/listings/missing/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'passed' }) })).status, 404);
 for (let i=0; i<2; i++) assert.equal((await fetch(base + `/api/tours/${tours[0].id}/confirm`, { method: 'POST' })).status, 200);
 assert.equal(emails.length, 1, 'Repeated confirmation does not send twice');
 await pool.query("INSERT INTO tour_schedules (id, proposed_time) VALUES ('unknown-time', 'TBD')");
 const unknown = (await (await fetch(base + '/api/tours')).json()).find(t => t.id === 'unknown-time');
 assert.equal(unknown.calendar_url, null);
 await pool.query("UPDATE listings SET status = 'applied', broker_email = $1, applied_at = datetime('now', '-26 hours') WHERE id = $2", ['broker@example.test', listing['@id']]);
 const nudge = require('../src/nudge_engine');
 await nudge.checkPendingNudges();
 const actionId = (await pool.query('SELECT id_hash FROM listings')).rows[0].id_hash;
 assert.equal((await nudge.sendNudge(actionId)).success, true);
 assert.equal((await nudge.sendNudge(actionId)).success, false);
 assert.equal(emails.length, 2);
 assert.equal((await nudge.skipNudge(actionId)).success, true);
});

test('Manhattan arrival estimates survive evaluation and storage without rounding across the alert cutoff', async () => {
 for (const minutes of [20, 20.1]) {
  await pool.query('INSERT INTO listings (id, title, url, price, bedrooms, bathrooms) VALUES ($1, $2, $3, 2500, 1, 1)',
   ['boundary-' + minutes, 'Commute boundary ' + minutes, 'https://example.test/commute-' + minutes]);
 }
 await require('../src/evaluator').evaluateListings({ evaluate: async (listing, description, options) =>
  require('../src/evaluator').runAIEvaluation(listing, description, { ...options, fetchImpl: async (_url, { body }) => {
   const { GoogleGenerativeAI } = require('@google/generative-ai');
   const model = new GoogleGenerativeAI('fixture').getGenerativeModel();
   const result = await model.generateContent(JSON.parse(body).contents[0].parts[0].text);
   return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: result.response.text() }] } }] }) };
  } }) });
 const rows = (await pool.query("SELECT * FROM listings WHERE id LIKE 'boundary-%' ORDER BY id")).rows;
 assert.equal(rows[0].manhattan_commute_minutes, 20);
 assert.equal(rows[0].commute_minutes, 45, 'Office commute remains separate');
 assert.equal(rows[0].manhattan_arrival_station, '1 Av');
 assert.equal(rows[0].suitability_score, 90);
 assert.equal(rows[1].manhattan_commute_minutes, 20.1);
 assert.equal(rows[1].suitability_score, 74);
 const before = alerts.length;
 await require('../src/notifier').notifyHighScoringListings();
 assert.equal(alerts.length, before + 1);
 assert.ok(alerts.at(-1).text.includes('20 min to 1 Av'));
});
