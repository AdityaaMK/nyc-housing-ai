'use strict';

// launchd runs this at login, every minute, and after a missed minute during sleep.
// Existing online processes are left alone, avoiding duplicate scraper instances.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// Follow the saved deployment, not a hard-coded legacy checkout or process name.
// An intentional `pm2 stop NAME && pm2 save` keeps that service stopped.
const managedNames = new Set(['housing-daemon', 'housing-scraper', 'housing-api', 'housing-scorer', 'housing-telegram', 'housing-inbox']);
const savedPath = path.join(process.env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'dump.pm2');
const log = message => console.log(`${new Date().toISOString()} ${message}`);
const savedApps = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
const desiredApps = savedApps.filter(app => managedNames.has(app.name) && app.status !== 'stopped');
if (!desiredApps.length) {
    log('No housing services are saved for automatic startup.');
    process.exit(0);
}
const pm2 = require(path.join(desiredApps[0].pm_cwd, 'node_modules/pm2'));
const call = (method, ...args) => new Promise((resolve, reject) => {
    pm2[method](...args, (error, result) => error ? reject(error) : resolve(result));
});

const deadline = setTimeout(() => {
    console.error(`${new Date().toISOString()} PM2 recovery check timed out; launchd will retry.`);
    pm2.disconnect();
    process.exit(1);
}, 45000);

(async () => {
    await call('connect');
    try {
        const running = await call('list');
        let changes = 0;
        for (const saved of desiredApps) {
            const existing = running.find(process => process.name === saved.name);
            if (!existing) {
                // Preserve the saved checkout and environment, including a separately hosted API.
                await call('start', {
                    name: saved.name,
                    script: saved.pm_exec_path,
                    cwd: saved.pm_cwd,
                    interpreter: saved.exec_interpreter || process.execPath,
                    env: saved.env,
                    args: saved.args,
                    node_args: saved.node_args,
                    autorestart: saved.autorestart !== false,
                    restart_delay: saved.restart_delay,
                    exp_backoff_restart_delay: saved.exp_backoff_restart_delay,
                    min_uptime: saved.min_uptime,
                    max_memory_restart: saved.max_memory_restart,
                    kill_timeout: saved.kill_timeout
                });
                log(`Started missing service: ${saved.name}`);
                changes++;
            } else if (['stopped', 'errored'].includes(existing.pm2_env.status)) {
                await call('restart', existing.pm_id);
                log(`Restarted ${existing.pm2_env.status} service: ${saved.name}`);
                changes++;
            }
        }
        log(changes ? `Recovery complete: ${changes} service(s) restored.` : 'Housing services already running.');
    } finally {
        pm2.disconnect();
    }
})().catch(error => {
    console.error(`${new Date().toISOString()} Recovery failed: ${error.message}`);
    process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
