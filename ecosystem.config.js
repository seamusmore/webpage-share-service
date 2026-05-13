module.exports = {
  apps: [{
    name: 'webpage-share',
    script: './services/auth-server.js',
    cwd: './',
    env_file: './.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 9080
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    restart_delay: 3000,
    max_restarts: 10,
    min_uptime: '30s'
  }]
};
