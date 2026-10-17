const path = require('node:path');
module.exports = { apps: [{
    name: 'housing-inbox',
    script: 'src/inbox_worker.js',
    cwd: path.resolve(__dirname),
    interpreter: process.execPath,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    min_uptime: 0,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: '350M',
    kill_timeout: 20000,
    time: true,
    env: { NODE_ENV: 'production', NODE_USE_ENV_PROXY: '1' }
}] };
