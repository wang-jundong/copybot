// One process owns the shared gRPC stream and journal lock.
module.exports = {
  apps: [{
    name: 'copybot',
    script: 'src/bot.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: true,
    restart_delay: 5000,
    min_uptime: '10s',
    max_restarts: 5,
    // Let in-flight trades finish or reconcile on SIGINT/SIGTERM.
    kill_timeout: 180000,
  }],
};
