require('dotenv').config({ quiet: true });
const { runWorker } = require('./evaluation_worker');
const { pool } = require('./db');
const { EvaluationError, errorCode, summaries } = require('./evaluation_errors');
function parseArgs(args) {
    const options = { limit: 10, continuous: false, noRetries: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--continuous') options.continuous = true;
        else if (args[i] === '--no-retries') options.noRetries = true;
        else if (args[i] === '--limit' && /^\d+$/.test(args[i + 1] || '')) options.limit = Number(args[++i]);
        else throw new Error('Usage: npm run evaluate -- [--limit N] [--no-retries] or npm run evaluate:worker');
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('limit must be a positive integer');
    if (options.continuous && args.includes('--limit')) throw new Error('--continuous cannot be combined with --limit');
    return options;
}
async function main() {
    const { createWorkerReporter } = require('./health_service');
    const health = createWorkerReporter('scorer');
    const controller = new AbortController();
    const shutdown = () => controller.abort(new EvaluationError('shutdown'));
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    try {
        const result = await runWorker({ ...parseArgs(process.argv.slice(2)), signal: controller.signal,
            onHeartbeat: value => health.report(value), onResult: record => health.report(record.status === 'completed' ?
                { lastSuccessAt: Date.now(), error: null } : { error: record.status === 'stale' ? null : 'scoring_failed' }) });
        console.log(JSON.stringify({ ...result, results: undefined }));
        if (['credentials', 'configuration'].includes(result.stopped)) process.exitCode = 1;
    } catch (error) {
        await health.report({ error: 'scoring_failed' });
        console.error(error instanceof EvaluationError ? summaries[errorCode(error)] : 'Evaluation worker failed. Check arguments and database connectivity.');
        process.exitCode = 1;
    } finally {
        await health.stop();
        process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
        await pool.end();
    }
}
module.exports = { main, parseArgs };
if (require.main === module) main();
