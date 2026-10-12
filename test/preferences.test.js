const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadPreferences, matchesLocation, enforceLocation, scopedAddress } = require('../src/preferences');
const { getSearchFeeds } = require('../src/search_feeds');

test('saved preferences include the original neighborhoods, Williamsburg, and the four broad areas', () => {
    const preferences = loadPreferences();
    assert.deepEqual(preferences.preferredNeighborhoods.map(n => n.name), ['Lower East Side', 'Financial District', 'East Village', "Hell's Kitchen", 'Williamsburg']);
    assert.deepEqual(preferences.includedAreas, ['Queens', 'Brooklyn', 'Jersey City', 'Hoboken']);
    for (const neighborhood of ['LES', 'FiDi', 'East Village', 'Hell’s Kitchen', 'Williamsburg']) {
        assert.equal(matchesLocation({ neighborhood }), true, neighborhood);
    }
    for (const [neighborhood, location_area] of [['Astoria', 'Queens'], ['Park Slope', 'Brooklyn'], ['Journal Square', 'Jersey City'], ['Uptown', 'Hoboken']]) {
        assert.equal(matchesLocation({ neighborhood, location_area }), true, neighborhood);
    }
    for (const neighborhood of ['Harlem', 'Central Harlem', 'East Harlem', 'Chelsea', 'Unknown', 'Near Williamsburg']) {
        assert.equal(matchesLocation({ neighborhood }), false, neighborhood);
    }
    assert.equal(matchesLocation({ neighborhood: 'Financial District', location_area: 'San Francisco' }), false);
});

test('location cap applies even after a clean-building bonus and a wrong AI preference flag', () => {
    const evaluation = enforceLocation({ neighborhood: 'Harlem', location_area: 'Manhattan', suitability_score: 77, is_preferred_neighborhood: true, red_flags: [] });
    assert.equal(evaluation.is_preferred_neighborhood, false);
    assert.equal(evaluation.suitability_score, 74);
    assert.equal(enforceLocation({ neighborhood: 'Williamsburg', suitability_score: 90, red_flags: [] }).suitability_score, 90);
    assert.equal(enforceLocation({ neighborhood: 'Williamsburg', location_area: 'Unknown', suitability_score: 90, red_flags: [] }).is_preferred_neighborhood, false);
});

test('regional feeds include the added areas and preserve both budget/layout choices', () => {
    for (const source of ['streetEasy', 'compass']) {
        const feeds = getSearchFeeds(source);
        for (const area of ['Manhattan', 'Brooklyn', 'Queens', 'Jersey City', 'Hoboken']) {
            const pair = feeds.filter(f => f.area === area);
            assert.equal(pair.length, 2, `${source}: ${area}`);
            assert.ok(pair.some(f => f.match(1, 1, 2700)));
            assert.ok(pair.some(f => f.match(2, 2, 5000)));
            assert.ok(pair.every(f => !f.match(1, 1, 2701) && !f.match(2, 1, 4000) && !f.match(1, 1, 1799)));
        }
    }
    assert.ok(getSearchFeeds('renthop').some(f => f.area === 'Jersey City'));
    assert.notEqual(scopedAddress('100-WASHINGTON-ST-4A', 'Hoboken'), scopedAddress('100-WASHINGTON-ST-4A', 'Manhattan'));
});

test('notifier rejects high-scoring Harlem while allowing Williamsburg, Queens, and New Jersey', async () => {
    const alerts = [], updates = [];
    const rows = [
        { id: 'harlem', neighborhood: 'Harlem', location_area: 'Manhattan', is_preferred: true },
        { id: 'williamsburg', neighborhood: 'Williamsburg', location_area: 'Brooklyn', is_preferred: false },
        { id: 'queens', neighborhood: 'Astoria', location_area: 'Queens', is_preferred: false },
        { id: 'jc', neighborhood: 'Journal Square', location_area: 'Jersey City', is_preferred: false },
        { id: 'hoboken', neighborhood: 'Uptown', location_area: 'Hoboken', is_preferred: false },
        { id: 'unknown', neighborhood: 'Unknown', location_area: null, is_preferred: true }
    ].map(l => ({ ...l, title: l.id, suitability_score: 99, price: 2500, url: 'https://example.test/' + l.id }));
    const mocks = {
        dotenv: { config() {} },
        'node-telegram-bot-api': { Api: class { async sendMessage(message) { alerts.push(message); } } },
        '../src/db': { initDB() {}, pool: { async query(sql, params) { if (sql.startsWith('SELECT')) return { rows }; updates.push(params[0]); return { rows: [] }; } } }
    };
    const originals = Object.entries(mocks).map(([name, exports]) => {
        const id = require.resolve(name), old = require.cache[id];
        require.cache[id] = { id, exports };
        return [id, old];
    });
    const oldToken = process.env.TELEGRAM_BOT_TOKEN, oldChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'fixture'; process.env.TELEGRAM_CHAT_ID = 'fixture';
    try {
        await require('../src/notifier').notifyHighScoringListings();
        assert.equal(alerts.length, 4);
        assert.deepEqual(updates, ['williamsburg', 'queens', 'jc', 'hoboken']);
    } finally {
        for (const [id, old] of originals) { if (old) require.cache[id] = old; else delete require.cache[id]; }
        delete require.cache[require.resolve('../src/notifier')];
        if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
        if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = oldChat;
    }
});

test('health requests use Queens/Brooklyn geography and skip NYC lookups for New Jersey', async () => {
    const https = require('node:https'), original = https.get, urls = [];
    https.get = (url, options, callback) => {
        urls.push(url);
        const request = new EventEmitter();
        queueMicrotask(() => {
            const response = new EventEmitter(); response.statusCode = 200;
            callback(response); response.emit('data', '[]'); response.emit('end');
        });
        return request;
    };
    try {
        const { checkBuildingHealth } = require('../src/building_health');
        await checkBuildingHealth('100 Main Street', 'Queens');
        assert.ok(urls.some(url => url.includes('boroid=4')));
        assert.ok(urls.some(url => url.includes('borough=QUEENS')));
        await checkBuildingHealth('100 Main Street', 'Brooklyn');
        assert.ok(urls.some(url => url.includes('boroid=3')));
        assert.ok(urls.some(url => url.includes('borough=BROOKLYN')));
        const count = urls.length;
        assert.equal((await checkBuildingHealth('100 Main Street', 'Jersey City')).grade, 'Unknown');
        assert.equal((await checkBuildingHealth('100 Main Street', 'Hoboken')).grade, 'Unknown');
        assert.equal(urls.length, count);
    } finally { https.get = original; }
});

test('dashboard API serves saved preferences and recalculates stale location flags', async () => {
    const rows = [
        { id: 'harlem', neighborhood: 'Harlem', is_preferred: true },
        { id: 'williamsburg', neighborhood: 'Williamsburg', is_preferred: false },
        { id: 'queens', neighborhood: 'Astoria', location_area: 'Queens', is_preferred: false }
    ];
    const mocks = {
        dotenv: { config() {} },
        '../src/db': { initDB() {}, pool: { async query() { return { rows }; } } },
        '../src/inbound_listener': { confirmTourBooking() {}, generateGoogleCalendarUrl() {} }
    };
    const originals = Object.entries(mocks).map(([name, exports]) => {
        const id = require.resolve(name), old = require.cache[id];
        require.cache[id] = { id, exports };
        return [id, old];
    });
    try {
        const app = require('../src/server');
        async function get(route) {
            let result;
            const handler = app.router.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
            await handler({}, { json(value) { result = value; }, status(code) { throw new Error(`Unexpected HTTP ${code}`); } });
            return result;
        }
        assert.deepEqual(await get('/api/preferences'), loadPreferences());
        const listings = await get('/api/listings');
        assert.deepEqual(listings.map(l => l.is_preferred), [false, true, true]);
        assert.equal(listings[1].location_area, 'Brooklyn');
    } finally {
        for (const [id, old] of originals) { if (old) require.cache[id] = old; else delete require.cache[id]; }
        delete require.cache[require.resolve('../src/server')];
    }
});
