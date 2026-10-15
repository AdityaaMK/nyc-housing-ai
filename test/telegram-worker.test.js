const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openState, readStatus } = require('../src/telegram_state');
const { notificationCycle, pollOnce, runTelegramWorker } = require('../src/telegram_worker');
const { buildListingAlert, eligibleForAlert } = require('../src/telegram_messages');
const { loadPreferences } = require('../src/preferences');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-test-'));
    const file = path.join(dir, 'worker.sqlite');
    let state = openState(file, 'fixture');
    t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const rows = [], delivered = [], acknowledged = [];
    const repository = { pendingNotifications: async () => ({ rows: rows.filter(r => !acknowledged.includes(r.id)) }),
        markNotified: async id => { acknowledged.push(id); } };
    const api = { sendMessage: async payload => { delivered.push(payload); return { message_id: delivered.length }; } };
    const listing = id => ({ id, title: '350 W 50th St #4B', status: 'inbox', suitability_score: 90, price: 2500,
        location_area: 'Manhattan', neighborhood: "Hell's Kitchen", url: 'https://example.test/' + id });
    let clock = 1000000;
    return { file, rows, delivered, acknowledged, repository, api, listing, now: () => clock, advance: ms => { clock += ms; },
        get state() { return state; },
        reopen() { state.close(); state = openState(file, 'fixture'); },
        cycle: () => notificationCycle({ state, repository, api, chatId: '123', now: () => clock, wait: async () => {} }) };
}

test('startup backlog is one digest; new matches arrive individually after restart', async t => {
    const f = fixture(t);
    for (let i = 0; i < 133; i++) f.rows.push(f.listing('old-' + i));
    await f.cycle();
    assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0].text, /133 existing matches/);
    assert.equal(f.acknowledged.length, 133);
    f.reopen(); f.rows.push(f.listing('new'));
    await f.cycle();
    assert.equal(f.delivered.length, 2);
    assert.match(f.delivered[1].text, /NEW MATCH/);
    assert.ok(f.delivered[1].reply_markup.inline_keyboard.some(row => row.some(button => button.callback_data === 'apply_new')));
});

test('confirmed send plus failed database acknowledgement is reconciled without resend', async t => {
    const f = fixture(t); f.rows.push(f.listing('a'));
    f.repository.markNotified = async () => { throw new Error('database unavailable'); };
    await assert.rejects(f.cycle());
    assert.equal(f.state.status()[0].status, 'sent');
    f.reopen(); f.repository.markNotified = async id => f.acknowledged.push(id);
    await f.cycle();
    assert.equal(f.delivered.length, 1); assert.deepEqual(f.acknowledged, ['a']);
    assert.equal(f.state.status()[0].status, 'done');
});

test('ambiguous sends and crashes during send are held for review across restarts', async t => {
    const f = fixture(t); f.rows.push(f.listing('a'));
    f.api.sendMessage = async () => { throw new Error('network timeout'); };
    await f.cycle(); f.reopen(); await f.cycle();
    assert.equal(f.state.status()[0].status, 'uncertain');
    assert.equal(f.acknowledged.length, 0);
    f.rows.push(f.listing('b')); f.state.enqueue(f.rows, f.now());
    f.state.preparing('listing:b', ['b']); f.reopen();
    assert.equal(f.state.status()[0].count, 2);
    assert.equal(readStatus(f.file).needsReview.length, 2);
});

test('429 delay survives restart and later retries successfully', async t => {
    const f = fixture(t); f.rows.push(f.listing('a'));
    const send = f.api.sendMessage;
    f.api.sendMessage = async () => { throw Object.assign(new Error(), { errorCode: 429, retryAfter: 120 }); };
    await f.cycle(); f.reopen(); f.api.sendMessage = send;
    f.advance(119999); await f.cycle(); assert.equal(f.delivered.length, 0);
    f.advance(1); await f.cycle(); assert.equal(f.delivered.length, 1);
});

test('passed, contacted, low-scoring and outside-preference listings cannot notify', async t => {
    const f = fixture(t);
    f.rows.push({ ...f.listing('passed'), status: 'passed' }, { ...f.listing('contacted'), status: 'contacted' },
        { ...f.listing('low'), suitability_score: 74 }, { ...f.listing('far'), neighborhood: 'Harlem' });
    await f.cycle(); assert.equal(f.delivered.length, 0);
    assert.equal(eligibleForAlert(f.listing('yes'), loadPreferences()), true);
});

test('a queued listing passed before retry is cancelled', async t => {
    const f = fixture(t); f.rows.push(f.listing('a'));
    f.api.sendMessage = async () => { throw Object.assign(new Error(), { errorCode: 429, retryAfter: 1 }); };
    await f.cycle(); f.rows[0].status = 'passed'; f.advance(60000); await f.cycle();
    assert.equal(f.state.status()[0].status, 'cancelled');
});

test('singleton lock rejects a second worker, then allows reopening', t => {
    const f = fixture(t);
    assert.throws(() => openState(f.file, 'fixture'), /locked/);
    f.reopen(); assert.equal(f.state.get('identity'), 'fixture');
});

test('poll checkpoint prevents replaying a broker-producing callback after interruption', async t => {
    const f = fixture(t); let calls = 0;
    const api = { getUpdates: async ({ offset }) => { assert.ok(offset === 0 || offset === 43); return [{ update_id: 42 }]; } };
    const bot = { handleUpdate: async () => { calls++; throw new Error('interrupted after email'); } };
    await assert.rejects(pollOnce({ api, bot, state: f.state })); f.reopen();
    await pollOnce({ api, bot, state: f.state });
    assert.equal(calls, 1); assert.equal(f.state.get('offset'), 43);
    assert.equal(f.state.get('last_action').status, 'started');
});

test('polling recovers from network errors and persists heartbeat on shutdown', async t => {
    const f = fixture(t); const stop = new AbortController(); let polls = 0;
    const api = { ...f.api, getUpdates: async () => {
        if (++polls === 1) throw new Error('connection lost');
        stop.abort(); return [];
    } };
    const waits = [];
    await runTelegramWorker({ api, bot: { handleUpdate() {} }, state: f.state, repository: f.repository,
        chatId: '123', signal: stop.signal, now: f.now, log() {}, wait: async ms => { waits.push(ms); f.advance(ms); await new Promise(resolve => setImmediate(resolve)); } });
    assert.equal(polls, 2); assert.ok(waits.some(ms => ms >= 2000));
    assert.equal(f.state.get('heartbeat').status, 'stopping');
});

test('a conflicting poller pauses delivery and persists a one-minute retry', async t => {
    const f = fixture(t); f.rows.push(f.listing('a')); const stop = new AbortController();
    const api = { ...f.api, getUpdates: async () => { throw Object.assign(new Error('conflict'), { errorCode: 409 }); } };
    await runTelegramWorker({ api, bot: {}, state: f.state, repository: f.repository, chatId: '123',
        signal: stop.signal, now: f.now, log() {}, wait: async ms => { if (ms >= 60000) stop.abort(); await new Promise(resolve => setImmediate(resolve)); } });
    assert.equal(f.delivered.length, 0);
    assert.equal(f.state.get('poll_retry_at'), f.now() + 60000);
    assert.equal(f.state.get('heartbeat').pollError, 'telegram_409');
});

test('alert formatting bounds provider text and labels AI commute estimates', () => {
    const message = buildListingAlert({ id: 'x', title: 'x'.repeat(10000), price: 2500,
        pros: JSON.stringify(['x'.repeat(10000)]), red_flags: JSON.stringify(['x'.repeat(10000)]),
        commute_summary: 'x'.repeat(10000), url: 'https://example.test/x' });
    assert.ok(message.text.length < 4096);
    assert.match(message.text, /AI commute estimate/);
});

test('OS releases singleton lock after SIGKILL; interrupted dispatch remains uncertain', async t => {
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-crash-'));
    const file = path.join(dir, 'worker.sqlite');
    const child = spawn(process.execPath, ['-e', `
        const state = require(${JSON.stringify(require.resolve('../src/telegram_state'))}).openState(${JSON.stringify(file)}, 'fixture');
        state.enqueue([{id:'a'}], Date.now()); state.preparing('backlog', ['a']);
        process.send('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
    await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    const state = openState(file, 'fixture');
    try { assert.equal(state.status()[0].status, 'uncertain'); }
    finally { state.close(); }
});

test('bot callbacks from other chats cannot mutate listings or send outreach', async () => {
    const vm = require('node:vm');
    let callback, changes = 0, replies = 0;
    const module = { exports: {} };
    const mocks = {
        './repository': { repository: { passListing: async () => { changes++; } } },
        dotenv: { config() {} }, 'node-telegram-bot-api': {}, '@google/generative-ai': {},
        './db': {}, './auto_inquire': {}, './inbound_listener': {}, './nudge_engine': {}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/bot.js'), 'utf8'), {
        require: name => mocks[name], module, process: { env: {} }, console: { log() {}, error() {} }
    });
    module.exports.setupBotHandlers({ on(_name, fn) { callback = fn; }, catch() {} }, { chatId: '123' });
    const ctx = id => ({ chat: { id }, callbackQuery: { data: 'pass_a' },
        answerCallbackQuery: async () => { replies++; }, reply: async () => { replies++; } });
    await callback(ctx(456)); assert.equal(changes, 0); assert.equal(replies, 0);
    await callback(ctx(123)); assert.equal(changes, 1); assert.equal(replies, 2);
});
