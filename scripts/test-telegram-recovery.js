// Exercises the real worker entrypoint and PM2 supervisor using fixture services.
// No Telegram, database, or broker requests are made.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-pm2-test-'));
process.env.PM2_HOME = path.join(dir, 'pm2');
const pm2 = require('pm2');
const { readStatus } = require('../src/telegram_state');
const root = path.resolve(__dirname, '..');
const preload = path.join(dir, 'fixtures.cjs');
const stateDir = path.join(dir, 'state');
const script = `
    const mock = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
    mock(${JSON.stringify(require.resolve('node-telegram-bot-api'))}, { Bot: class {
        constructor() { this.api = {
            getMe: async () => ({id:123}), getWebhookInfo: async () => ({}),
            getUpdates: async () => { await new Promise(r=>setTimeout(r,50)); return []; },
            sendMessage: async () => { throw new Error('Unexpected send in recovery test'); }
        }; }
        command() {} async handleUpdate() {}
    }});
    mock(${JSON.stringify(require.resolve('../src/db'))}, { initDB: async () => {}, pool: { backend:'fixture', end:async()=>{} } });
    mock(${JSON.stringify(require.resolve('../src/repository'))}, { repository: {pendingNotifications:async()=>({rows:[]})} });
    mock(${JSON.stringify(require.resolve('../src/bot'))}, { setupBotHandlers() {} });
`;
fs.writeFileSync(preload, script, { mode: 0o600 });
const call = (method, ...args) => new Promise((resolve, reject) => pm2[method](...args, (e, result) => e ? reject(e) : resolve(result)));
async function healthy(differentPid = 0) {
    for (let i = 0; i < 100; i++) {
        const [app] = await call('list');
        if (app?.pid && app.pid !== differentPid) {
            try {
                const status = readStatus(path.join(stateDir, 'worker.sqlite'));
                if (status.healthy && status.heartbeat.pid === app.pid) return app;
            } catch { /* Still starting. */ }
        }
        await delay(200);
    }
    throw new Error('Worker did not become healthy');
}
(async () => {
    try {
        await call('connect');
        await call('start', { ...require('../ecosystem.telegram.config.cjs').apps[0],
            name: 'telegram-recovery-fixture', cwd: root, node_args: ['--require', preload],
            env: { TELEGRAM_BOT_TOKEN: 'fixture', TELEGRAM_CHAT_ID: '123', TELEGRAM_STATE_DIR: stateDir,
                DB_BACKEND: 'fixture', DATABASE_URL: '', SUPABASE_URL: '', DOTENV_CONFIG_PATH: '/dev/null' } });
        const before = await healthy();
        process.kill(before.pid, 'SIGKILL');
        const after = await healthy(before.pid);
        assert.ok(after.pm2_env.restart_time >= 1);
        assert.equal(readStatus(path.join(stateDir, 'worker.sqlite')).deliveries.length, 0);
        console.log(JSON.stringify({ supervisedRestart: 'passed', newPid: after.pid !== before.pid, heartbeat: 'healthy', liveSends: 0 }));
    } finally {
        await call('killDaemon').catch(() => {});
        pm2.disconnect();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(() => { console.error('Telegram supervised recovery test failed.'); process.exitCode = 1; })
    // PM2's client can retain metrics timers after disconnect. All owned processes
    // and temporary files have been cleaned up before this standalone test exits.
    .finally(() => process.exit(process.exitCode || 0));
