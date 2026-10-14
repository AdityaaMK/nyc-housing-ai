// Integration tests create/drop only a randomly named, disposable PostgreSQL schema.
require('dotenv').config({ quiet: true });
const { spawnSync } = require('node:child_process');
if (!process.env.QUEUE_TEST_DATABASE_URL || !['localhost', '127.0.0.1'].includes(new URL(process.env.QUEUE_TEST_DATABASE_URL).hostname)) throw new Error('QUEUE_TEST_DATABASE_URL must point to disposable localhost PostgreSQL');
const result = spawnSync(process.execPath, ['--test', 'test/evaluation.test.js'], {
    stdio: 'inherit', env: { ...process.env, DATABASE_URL: '', QUEUE_TEST_DATABASE_URL: process.env.QUEUE_TEST_DATABASE_URL }
});
process.exitCode = result.status || (result.error ? 1 : 0);
