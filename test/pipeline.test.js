const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DATABASE_URL = '';
process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'housing-test-')), 'test.db');
const { initDB, pool } = require('../src/db');
after(() => pool.end());
test('fresh SQLite supports broker outreach fields and repeated numbered parameters', async () => {
  await initDB();
  await pool.query('INSERT INTO listings (id, title, broker_email) VALUES ($1, $2, $3)', ['fixture', 'Test apartment', 'broker@example.test']);
  const result = await pool.query('SELECT id FROM listings WHERE title = $1 OR id = $1', ['fixture']);
  assert.equal(result.rows[0]?.id, 'fixture');
});
test('tour schema exists at startup and retains precise time', async () => {
  await pool.query('INSERT INTO tour_schedules (id, proposed_datetime) VALUES ($1, $2)', ['tour', '2026-10-20T17:30:00-04:00']);
  const result = await pool.query('SELECT proposed_datetime FROM tour_schedules WHERE id = $1', ['tour']);
  assert.equal(result.rows[0].proposed_datetime, '2026-10-20T17:30:00-04:00');
});
test('deduplication preserves apartments and rejects vague addresses', () => {
  const { normalizeAddress } = require('../src/normalizer');
  assert.notEqual(normalizeAddress('1440 Amsterdam Avenue #903', '1440 Amsterdam Avenue'), normalizeAddress('1440 Amsterdam Avenue #917', '1440 Amsterdam Avenue'));
  assert.equal(normalizeAddress('469 Convent Avenue, Unit 6B\n\nHamilton Heights'), normalizeAddress('469 Convent Ave Apt 6B'));
  assert.equal(normalizeAddress('West 30th Street\n\nChelsea'), null);
  assert.equal(normalizeAddress('Undisclosed Address'), null);
  assert.equal(normalizeAddress('444 Manhattan Avenue #5O'), '444-MANHATTAN-AVE-5O');
  assert.equal(normalizeAddress('61 Mott Street'), null);
});
test('unparseable building health is unknown rather than clean', async () => {
  const health = await require('../src/building_health').checkBuildingHealth('Undisclosed Address');
  assert.equal(health.grade, 'Unknown');
});
