const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let cache = null;

function loadGuideData() {
  if (cache) return cache;
  const source = fs.readFileSync(path.join(__dirname, "..", "data.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context, { filename: "data.js" });
  cache = context.window.GUIDE_DATA;
  return cache;
}

function sceneCatalog() {
  return loadGuideData().scenes.map((scene) => ({
    id: scene.id,
    title: scene.title,
    story: scene.story,
    question: scene.question,
    keywords: scene.keywords || [],
    status: scene.status,
  }));
}

module.exports = { loadGuideData, sceneCatalog };
