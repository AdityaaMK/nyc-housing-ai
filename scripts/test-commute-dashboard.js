// Fixture-only browser checks; never calls the live API or Google.
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
async function main() {
    const { createServer } = await import('../web/node_modules/vite/dist/node/index.js');
    const server = await createServer({ root: require('node:path').resolve('web'), server: { host: '127.0.0.1', port: 0 } });
    await server.listen(); let browser;
    try {
        browser = await require('puppeteer').launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage(); const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.evaluateOnNewDocument(() => {
            localStorage.setItem('housing-neighborhood-filter', 'all');
            window.testTicks = [];
            const original = window.setInterval;
            window.setInterval = (fn, ms) => ms === 15000 ? (window.testTicks.push(fn), 12345) : original(fn, ms);
        });
        let calls = 0, pending, failure = false, code = 'ready';
        const fixture = { origin: '975 Nostrand Avenue, Brooklyn, NY', destination: '620 8th Avenue, New York, NY 10018',
            requestedArrivalTime: '2026-10-13T13:00:00Z', retrievedAt: '2026-10-12T20:00:00Z', attribution: 'Google Maps',
            route: { durationSeconds: 1800, walkingSeconds: 300, transfers: 1, walkingOnly: false,
                steps: [{ mode: 'WALK', durationSeconds: 300, instruction: 'Walk to subway' }, { mode: 'TRANSIT', durationSeconds: 1500,
                    transit: { line: 'A', departureStop: 'Fixture Station', arrivalStop: '42 St', stopCount: 5, agencies: [{ name: 'MTA', uri: 'https://mta.info' }] } }] } };
        await page.setRequestInterception(true);
        page.on('request', async req => {
            const path = new URL(req.url()).pathname;
            if (!path.startsWith('/api/')) return req.continue();
            const respond = (data, status = 200) => req.respond({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data) });
            if (path.endsWith('/commute')) { calls++; pending = () => respond(failure ? { code: 'unavailable', error: 'No Google Maps route is available.' } : fixture, failure ? 404 : 200); return; }
            const data = {
                '/api/listings': [true, false].map((available, i) => ({ id: String(i), title: available ? '975 Nostrand Avenue' : 'Address missing fixture',
                    status: 'inbox', price: 2500, bedrooms: 1, bathrooms: 1, commute_address_available: available,
                    commute_minutes: 99, commute_summary: 'Saved AI fixture', suitability_score: 88, evaluation_status: 'completed' })),
                '/api/tours': [], '/api/stats': {}, '/api/preferences': { preferredNeighborhoods: [], includedAreas: [] },
                '/api/commute/status': { configured: code !== 'unconfigured', available: code === 'ready', code, remaining: { daily: 300 - calls, rolling32Days: 9000 - calls } }
            };
            await respond(data[path] || {});
        });
        const url = 'http://127.0.0.1:' + server.httpServer.address().port;
        await page.goto(url);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Get Google commute' && !b.disabled));
        const buttons = () => page.$$('section[aria-label="Google commute"] button');
        assert.equal(calls, 0); assert.equal(await (await buttons())[1].evaluate(b => b.disabled), true);
        const tick = () => page.evaluate(() => window.testTicks.forEach(fn => fn()));
        await tick(); await delay(100); assert.equal(calls, 0, 'Refresh makes no routing requests');
        await (await buttons())[0].evaluate(b => { b.click(); b.click(); });
        await page.waitForFunction(() => document.body.innerText.includes('Getting Google commute'));
        await delay(100); assert.equal(calls, 1);
        assert.equal(await (await buttons())[0].evaluate(b => b.disabled), true);
        await pending(); await page.waitForFunction(() => document.body.innerText.includes('Google Maps transit estimate'));
        const text = await page.$eval('body', e => e.innerText);
        for (const expected of ['Oct 13, 2026', '9:00 AM', 'EDT', '1 transfer', '5 stops', 'MTA', 'Saved AI fixture', '99m', '88', 'Google Maps']) assert.ok(text.includes(expected), expected);
        const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
        assert.ok(!stored.includes('Station')); assert.ok(!stored.includes('duration'));
        await tick(); await delay(100); assert.equal(calls, 1); assert.ok((await page.$eval('body', e => e.innerText)).includes('Fixture Station'));
        failure = true; await (await buttons())[0].click(); await delay(100); await pending();
        await page.waitForFunction(() => document.body.innerText.includes('No Google Maps route'));
        assert.ok(!(await page.$eval('body', e => e.innerText)).includes('Google Maps transit estimate'));
        for (const state of ['unconfigured', 'allowance_exhausted', 'rate_limited', 'configuration_error']) {
            code = state; await tick(); await delay(150);
            assert.equal(await (await buttons())[0].evaluate(b => b.disabled), true, state);
        }
        code = 'ready'; await page.reload();
        await page.waitForFunction(() => document.body.innerText.includes('Get Google commute'));
        assert.ok(!(await page.$eval('body', e => e.innerText)).includes('Fixture Station'), 'Route does not survive reload');
        assert.equal(calls, 2); assert.deepEqual(errors, []);
        console.log('Commute dashboard passed: click-only, duplicate prevention, loading, failures, disabled states, attribution, NY time, refresh and no storage.');
    } finally { await browser?.close(); await server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
