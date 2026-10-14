// Fixed, one-shot rollout trial. A private audit directory cannot be reused.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { runWorker, fetchDescription } = require('../src/evaluation_worker');
const { pool } = require('../src/db');
const { EvaluationError } = require('../src/evaluation_errors');
async function main() {
    const dir = process.argv[2];
    if (!dir || !fs.existsSync(path.join(dir, 'backup.json'))) throw new Error('Private backup directory is required');
    fs.writeFileSync(path.join(dir, 'trial.started'), new Date().toISOString(), { mode: 0o600, flag: 'wx' });
    const controller = new AbortController();
    const stop = () => controller.abort(new EvaluationError('shutdown'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const append = value => fs.appendFileSync(path.join(dir, 'trial.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
    try {
        const result = await runWorker({ limit: 10, noRetries: true, signal: controller.signal,
            describe: async (listing, options) => {
                const description = await fetchDescription(listing, options);
                append({ type: 'description', id: listing.id, title: listing.title, url: listing.url, price: listing.price, description });
                return description;
            }, onResult: record => append({ type: 'result', ...record }) });
        append({ type: 'summary', ...result });
        console.log(JSON.stringify({ ...result, results: undefined }));
        if (['credentials', 'configuration'].includes(result.stopped)) process.exitCode = 1;
    } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        await pool.end();
    }
}
main().catch(() => { console.error('Scoring trial stopped. Check the private audit and database connectivity; do not repeat this trial automatically.'); process.exitCode = 1; });
