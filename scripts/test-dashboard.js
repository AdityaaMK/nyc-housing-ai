// Browser regression checks with isolated fixture responses. No live API mutations.
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
async function main() {
    const { createServer } = await import('../web/node_modules/vite/dist/node/index.js');
    const server = await createServer({ root: require('node:path').resolve('web'), server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    let browser;
    try {
        browser = await require('puppeteer').launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const consoleErrors = []; page.on('pageerror', e => consoleErrors.push(e.message));
        await page.evaluateOnNewDocument(() => {
            localStorage.setItem('housing-neighborhood-filter', 'all');
            window.testHidden = false;
            Object.defineProperty(document, 'hidden', { get: () => window.testHidden });
            const original = window.setInterval;
            window.testIntervals = new Map();
            window.setInterval = (fn, ms, ...args) => {
                if (ms === 15000) { const id = Math.random(); window.testIntervals.set(id, fn); return id; }
                return original(fn, ms, ...args);
            };
            const clear = window.clearInterval;
            window.clearInterval = id => { window.testIntervals.delete(id); clear(id); };
        });
        let generation = 0, fail = false, hold = false, held, calls = 0;
        const states = ['pending', 'processing', 'completed', 'retry_wait', 'failed'];
        const responses = () => ({
            '/api/listings': states.map((state, i) => ({ id: String(i), title: 'Fixture ' + state + ' ' + generation, status: 'inbox',
                evaluation_status: state, evaluation_attempts: 1, price: 2500, bedrooms: 1, bathrooms: 1,
                ...(state === 'completed' ? { true_gross_rent: 5225, effective_monthly_rent: '4644.44', rent_terms: JSON.stringify({ gross_monthly_rent: 5225, concessions_mentioned: true, lease_months: 18, free_months: 2, rent_credit: 0 }) } : {}),
                suitability_score: state === 'completed' ? 0 : null, commute_minutes: 20, commute_summary: 'Subway',
                commute_maps_url: state === 'completed' ? require('../src/commute_links').commuteMapsUrl({ title: '975 Nostrand Avenue, Apt 346', location_area: 'Brooklyn' }) : null,
                evaluation_last_error: state === 'failed' ? 'Evaluation temporarily unavailable.' : null,
                evaluation_next_at: state === 'retry_wait' ? new Date().toISOString() : null })),
            '/api/tours': [], '/api/preferences': { preferredNeighborhoods: [], includedAreas: [] },
            '/api/stats': { evaluation: Object.fromEntries(states.map(s => [s, 1])) }
        });
        await page.setRequestInterception(true);
        page.on('request', async req => {
            const path = new URL(req.url()).pathname;
            if (!path.startsWith('/api/')) return req.continue();
            if (path === '/api/listings') calls++;
            const respond = () => req.respond({ status: fail && path === '/api/listings' ? 500 : 200,
                contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
                body: JSON.stringify(fail && path === '/api/listings' ? { error: 'Fixture refresh failure' } : responses()[path]) });
            if (hold && path === '/api/listings') held = respond;
            else await respond();
        });
        await page.goto('http://127.0.0.1:' + server.httpServer.address().port);
        await page.waitForFunction(() => document.body.innerText.includes('Fixture completed 0'));
        const text = await page.$eval('body', el => el.innerText);
        for (const label of ['Pending', 'Processing', 'Scored', 'Retrying', 'Failed', 'AI commute estimate']) assert.ok(text.includes(label), label);
        assert.match(text, /Score\s*0/i);
        const mapsLinks = await page.$$eval('a[href^="https://www.google.com/maps/dir/"]', links => links.map(a => ({ href: a.href, text: a.textContent, target: a.target })));
        assert.equal(mapsLinks.length, 1);
        assert.equal(mapsLinks[0].text.trim(), 'Check office commute in Google Maps');
        assert.equal(mapsLinks[0].target, '_blank');
        assert.equal(new URL(mapsLinks[0].href).searchParams.get('travelmode'), 'transit');
        assert.ok(text.includes('weekday arrival time'));
        for (const label of ['$4,644.44', 'net effective /mo', 'Gross monthly rent: $5,225', '2 months free', 'Averaged over 18 months', 'advertised /mo']) assert.ok(text.includes(label), label);
        assert.ok(!text.includes('Score\n?\nFixture completed'));
        const tick = () => page.evaluate(() => window.testIntervals.forEach(fn => fn()));
        hold = true; const before = calls;
        await tick(); await delay(100); await tick(); await tick(); await delay(100);
        assert.equal(calls, before + 1, 'No overlapping refreshes');
        generation++; hold = false; await held();
        await page.waitForFunction(() => document.body.innerText.includes('Fixture completed 1'));
        fail = true; await tick();
        await page.waitForFunction(() => document.body.innerText.includes('Fixture refresh failure'));
        assert.ok((await page.$eval('body', e => e.innerText)).includes('Fixture completed 1'), 'Retains last successful data');
        const visibleCalls = calls;
        await page.evaluate(() => { window.testHidden = true; }); await tick(); await delay(100);
        assert.equal(calls, visibleCalls, 'Hidden dashboard does not poll');
        fail = false; generation++;
        await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForFunction(() => document.body.innerText.includes('Fixture completed 2'));
        assert.deepEqual(consoleErrors, []);
        console.log('Dashboard checks passed: all states, zero score, refresh, overlap prevention, failure retention, visibility.');
    } finally { await browser?.close(); await server.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
