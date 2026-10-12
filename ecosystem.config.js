module.exports = {
  apps: [
    {
      name: 'housing-daemon',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--dns-result-order=ipv4first',
        NODE_USE_ENV_PROXY: '1',
        DAEMON_MODE: 'true',
        OUTBOUND_ENABLED: 'false',
        CYCLE_INTERVAL_SECONDS: '180'
      },
      max_memory_restart: '500M',
      restart_delay: 5000,
      autorestart: true
    },
    {
      name: 'housing-api',
      script: 'src/server.js',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--dns-result-order=ipv4first',
        NODE_USE_ENV_PROXY: '1',
        OUTBOUND_ENABLED: 'false',
        PORT: 3001
      },
      max_memory_restart: '300M',
      restart_delay: 3000,
      autorestart: true
    }
  ]
};
