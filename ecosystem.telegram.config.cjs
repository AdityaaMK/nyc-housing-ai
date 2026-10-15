const path = require('node:path');

module.exports = {
    apps: [{
        name: 'housing-telegram',
        cwd: __dirname,
        script: path.join(__dirname, 'src/telegram_worker.js'),
        interpreter: process.execPath,
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        // Keep restarting after configuration/network recovery, even if startup failed.
        min_uptime: 0,
        exp_backoff_restart_delay: 1000,
        max_memory_restart: '350M',
        kill_timeout: 20000,
        time: true,
        env: { NODE_ENV: 'production', NODE_USE_ENV_PROXY: '1' }
    }]
};
