module.exports = {
  apps: [
    {
      name: "teacher-boundary-guide",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      time: true,
      max_memory_restart: "350M",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4173",
        TRUST_PROXY: "true",
      },
    },
  ],
};
