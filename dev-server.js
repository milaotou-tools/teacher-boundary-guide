// Compatibility entry point for older local commands.
const { buildServer } = require("./server");

buildServer()
  .then((app) => app.listen({ port: app.guideConfig.port, host: app.guideConfig.host }))
  .then((address) => console.log(`教师权益场景网站已启动：${address}`))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
