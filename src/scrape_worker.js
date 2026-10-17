// Independent scraper loop; intentionally does not import evaluation or messaging.
const { run } = require('./scraper');
const { pool } = require('./db');
const { setTimeout: delay } = require('node:timers/promises');
async function main() {
    const { createWorkerReporter } = require('./health_service');
    const health = createWorkerReporter('scraper');
    const stop = new AbortController();
    const shutdown = () => stop.abort();
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    try {
        while (!stop.signal.aborted) {
            try {
                const result = await run();
                await health.report({ ...(result?.degraded ? {} : { lastSuccessAt: Date.now() }), error: result?.degraded ? 'scrape_failed' : null });
            }
            catch { await health.report({ error: 'scrape_failed' }); console.error('Scraper cycle failed; retrying next cycle.'); }
            if (stop.signal.aborted) break;
            console.log('Next scraper cycle in 180 seconds.');
            try { await delay(180000, undefined, { signal: stop.signal }); } catch { break; }
        }
    } finally {
        await health.stop();
        process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
        await pool.end();
    }
}
if (require.main === module) main().catch(() => { console.error('Scraper worker stopped.'); process.exitCode = 1; });
module.exports = { main };
