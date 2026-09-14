module.exports = {
  apps: [
    {
      name: 'housing-daemon',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
        DAEMON_MODE: 'true',
        CYCLE_INTERVAL_SECONDS: '180'
      },
      max_memory_restart: '500M',
      restart_delay: 5000,
      autorestart: true
    }
  ]
};
