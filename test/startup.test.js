const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startupPaths, renderLaunchAgent } = require('../scripts/macos/install.cjs');
const source = fs.readFileSync(path.join(__dirname, '../scripts/macos/ensure-running.cjs'), 'utf8');
const saved = ['housing-api', 'housing-scraper'].map(name => ({ name, status: 'online', pm_exec_path: `/current/${name}.js`, pm_cwd: '/current', exec_interpreter: process.execPath, env: { FIXTURE: 'preserved' }, autorestart: true }));

async function recovery(running, snapshots = saved) {
    const actions = [];
    const pm2 = {
        connect: cb => cb(null), list: cb => cb(null, running),
        start(config, cb) { actions.push(['start', config]); cb(null); },
        restart(id, cb) { actions.push(['restart', id]); cb(null); }, disconnect() {}
    };
    try {
        await vm.runInNewContext(source, {
            require(name) {
                if (name === 'node:fs') return { readFileSync: () => JSON.stringify(snapshots) };
                if (name.endsWith('/node_modules/pm2')) return pm2;
                return require(name);
            },
            console: { log() {}, error(message) { throw Error(message); } },
            process: { env: {}, execPath: process.execPath, exit(code) { throw Object.assign(Error('exit'), { testExit: code }); } },
            setTimeout, clearTimeout, Set, Date, Promise
        });
    } catch (error) { if (error.testExit !== 0) throw error; }
    return actions;
}

test('startup restores only saved housing services with their current checkout and environment', async () => {
    const actions = await recovery([], [...saved, { name: 'unrelated-service', status: 'online' }]);
    assert.deepEqual(actions.map(action => action[1].name), ['housing-api', 'housing-scraper']);
    assert.equal(actions[0][1].cwd, '/current');
    assert.equal(actions[0][1].env.FIXTURE, 'preserved');
    assert.equal(actions[1][1].script, '/current/housing-scraper.js');
});

test('healthy services are not restarted and stopped/errored services are recovered', async () => {
    const active = saved.map((app, i) => ({ name: app.name, pm_id: i, pm2_env: { status: 'online' } }));
    assert.equal((await recovery(active)).length, 0);
    active[1].pm2_env.status = 'stopped';
    assert.deepEqual(await recovery(active), [['restart', 1]]);
    active[1].pm2_env.status = 'errored';
    assert.deepEqual(await recovery(active), [['restart', 1]]);
});

test('deleted and deliberately saved stopped services are not resurrected', async () => {
    assert.equal((await recovery([], [])).length, 0);
    assert.equal((await recovery([], saved.map(app => ({ ...app, status: 'stopped' })))).length, 0);
    assert.deepEqual((await recovery([], saved.filter(app => app.name === 'housing-api'))).map(action => action[1].name), ['housing-api']);
});

test('launch-agent generation is portable and safely escapes paths', () => {
    const paths = startupPaths({ home: '/Users/tenant & family', username: 'tenant', pm2Home: '/Users/tenant & family/.pm2' });
    const plist = renderLaunchAgent(paths, '/Users/tenant & family/node/bin/node');
    assert.ok(plist.includes('tenant &amp; family'));
    assert.ok(!plist.includes('/Users/adityaamk'));
    assert.ok(plist.includes('<key>StartCalendarInterval</key><dict/>'));
    assert.ok(plist.includes('<key>RunAtLoad</key><true/>'));
    assert.equal(paths.label, 'com.tenant.nyc-housing-ai');
});
