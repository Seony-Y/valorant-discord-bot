module.exports = {
  apps: [
    {
      name: 'valorant-discord-bot',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
