// Real PM2 + worker entrypoint, with fixture mailbox/database/AI services only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { readInboxStatus } = require('../src/inbox_state');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-pm2-test-'));
process.env.PM2_HOME = path.join(dir, 'pm2');
const pm2 = require('pm2');
const root = path.resolve(__dirname, '..');
const stateDir = path.join(dir, 'state');
const counters = path.join(dir, 'counters.json');
const healthFile = path.join(dir, 'health.json');
const preload = path.join(dir, 'fixtures.cjs');
fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const mock = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
    mock(${JSON.stringify(require.resolve('dotenv'))}, { config() {} });
    const noNetwork = { request:async()=>{throw new Error('Unexpected network request in recovery fixture');}, close:async()=>{} };
    mock(${JSON.stringify(require.resolve('../src/https_client'))}, { httpsClient:noNetwork,
        createHttpsClient:()=>noNetwork, createDispatcher:()=>({close:async()=>{}}) });
    const fixtureStore = {
        async update(collection,id,transform) {
            if (collection !== 'worker_health') throw new Error('Unexpected fixture write');
            const filename = ${JSON.stringify(healthFile)};
            const previous = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : null;
            const record = {collection,id,data:transform(previous?.data),revision:(previous?.revision||0)+1};
            fs.writeFileSync(filename+'.tmp',JSON.stringify(record)); fs.renameSync(filename+'.tmp',filename); return record;
        }
    };
    mock(${JSON.stringify(require.resolve('../src/feature_store'))}, { featureStore:fixtureStore, createFeatureStore:()=>fixtureStore });
    const bump = key => {
        const filename = ${JSON.stringify(counters)};
        const counts = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : {};
        counts[key] = (counts[key] || 0) + 1;
        fs.writeFileSync(filename, JSON.stringify(counts));
    };
    mock(${JSON.stringify(require.resolve('../src/db'))}, { initDB: async () => {}, pool: { backend:'fixture', end:async()=>{} } });
    mock(${JSON.stringify(require.resolve('../src/repository'))}, { repository: {
        inboxInquiries:async()=>({rows:[]}), saveTour:async()=>bump('saves')
    } });
    mock(${JSON.stringify(require.resolve('../src/conversations'))}, { getConversationService:()=>({
        matchMessage:async()=>({candidateListingIds:[]}), recordInbound:async()=>({id:'fixture-conversation'}),
        linkTour:async()=>{}, inboundReplies:async()=>[]
    }) });
    mock(${JSON.stringify(require.resolve('../src/mailbox'))}, { openMailbox:async()=>({
        user:'tenant@example.test', identity:id=>'fixture:'+id, listMessages:async()=>['tour'],
        getMessage:async()=>({subject:'Apartment tour',from:'Broker <broker@example.test>',fromAddress:'broker@example.test',
            body:'Tour Tuesday',receivedAt:new Date().toISOString()}), close:async()=>{}
    }) });
    mock(${JSON.stringify(require.resolve('../src/inbound_listener'))}, { analyzeInboundEmail:async()=>{
        bump('analyses'); return {is_tour_invitation:true,listing_address:'Fixture apartment',human_readable_time:'Tuesday'};
    } });
`, { mode: 0o600 });
const call = (method, ...args) => new Promise((resolve, reject) => pm2[method](...args, (error, result) => error ? reject(error) : resolve(result)));
async function healthy(previousPid = 0) {
    for (let i = 0; i < 100; i++) {
        const [app] = await call('list');
        if (app?.pid && app.pid !== previousPid) {
            try {
                const status = readInboxStatus(path.join(stateDir, 'worker.sqlite'));
                if (status.healthy && status.heartbeat.pid === app.pid && status.alerts.total === 1) return app;
            } catch { /* Worker still starting. */ }
        }
        await delay(200);
    }
    throw new Error('Inbox worker did not become healthy');
}
(async () => {
    try {
        await call('connect');
        await call('start', { ...require('../ecosystem.inbox.config.cjs').apps[0], name: 'inbox-recovery-fixture', cwd: root,
            node_args: ['--require', preload], env: { INBOX_STATE_DIR: stateDir, TELEGRAM_CHAT_ID: '123',
                GMAIL_USER: 'tenant@example.test', GEMINI_API_KEY: 'fixture', DB_BACKEND: 'fixture',
                DATABASE_URL: '', SUPABASE_URL: '', MAIL_BACKEND: 'gmail-api', DOTENV_CONFIG_PATH: '/dev/null' } });
        const before = await healthy();
        process.kill(before.pid, 'SIGKILL');
        const after = await healthy(before.pid);
        assert.ok(after.pm2_env.restart_time >= 1);
        assert.deepEqual(JSON.parse(fs.readFileSync(counters)), { analyses: 1, saves: 1 });
        assert.equal(readInboxStatus(path.join(stateDir, 'worker.sqlite')).alerts.transferred, 0);
        await call('stop', 'inbox-recovery-fixture');
        assert.equal(JSON.parse(fs.readFileSync(healthFile)).data.status, 'stopped');
        assert.equal(readInboxStatus(path.join(stateDir, 'worker.sqlite')).heartbeat.status, 'stopped');
        console.log(JSON.stringify({ supervisedRestart: 'passed', journalPreserved: true, queuedAlerts: 1, repeatedAnalyses: 0, gracefulStop: 'persisted', liveSends: 0 }));
    } finally {
        await call('killDaemon').catch(() => {});
        pm2.disconnect(); fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(() => { console.error('Inbox supervised recovery test failed.'); process.exitCode = 1; })
    .finally(() => process.exit(process.exitCode || 0));
