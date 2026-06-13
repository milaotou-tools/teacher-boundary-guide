const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("data.js", "utf8");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context);

const { sections, scenes, sources, schoolCases } = context.window.GUIDE_DATA;
const requiredSceneFields = [
  "id",
  "section",
  "title",
  "story",
  "status",
  "summary",
  "teacherBoundary",
  "schoolDuties",
  "explicitRules",
  "unclearRules",
  "questions",
  "goodPractices",
  "caseIds",
  "template",
  "sourceIds",
];

const errors = [];

if (sections.length !== 4) errors.push(`板块数量应为4，当前为${sections.length}`);
if (scenes.length < 12 || scenes.length > 17) {
  errors.push(`有限生长阶段场景数量应为12至17，当前为${scenes.length}`);
}

const sceneIds = new Set(scenes.map((scene) => scene.id));
if (sceneIds.size !== scenes.length) errors.push("场景ID存在重复");

const requiredAppFiles = [
  "submit.html",
  "submit.js",
  "result.html",
  "result.js",
  "admin.html",
  "admin.js",
  "server.js",
];
for (const file of requiredAppFiles) {
  if (!fs.existsSync(file)) errors.push(`有限生长版缺少文件：${file}`);
}

for (const scene of scenes) {
  for (const field of requiredSceneFields) {
    if (
      scene[field] === undefined ||
      scene[field] === null ||
      (field !== "caseIds" && Array.isArray(scene[field]) && scene[field].length === 0)
    ) {
      errors.push(`${scene.id || "未知场景"}缺少字段：${field}`);
    }
  }

  if (!sections.some((section) => section.id === scene.section)) {
    errors.push(`${scene.id}引用了不存在的板块：${scene.section}`);
  }

  for (const sourceId of scene.sourceIds) {
    if (!sources[sourceId]) errors.push(`${scene.id}引用了不存在的文件：${sourceId}`);
  }

  for (const caseId of scene.caseIds) {
    if (!schoolCases[caseId]) errors.push(`${scene.id}引用了不存在的学校案例：${caseId}`);
  }

  if (scene.goodPractices.length < 2) {
    errors.push(`${scene.id}至少需要2个可参考做法`);
  }
}

for (const [caseId, item] of Object.entries(schoolCases)) {
  const requiredCaseFields = [
    "school",
    "location",
    "publishedAt",
    "sourceType",
    "title",
    "practice",
    "takeaway",
    "url",
  ];

  for (const field of requiredCaseFields) {
    if (!item[field]) errors.push(`${caseId}学校案例缺少字段：${field}`);
  }

  if (!/^https?:\/\//.test(item.url)) {
    errors.push(`${caseId}学校案例链接不是HTTP或HTTPS地址`);
  }
}

for (const [sourceId, item] of Object.entries(sources)) {
  if (!item.url.startsWith("https://")) errors.push(`${sourceId}不是HTTPS官方链接`);
  if (!item.title || !item.reference || !item.level) errors.push(`${sourceId}文件信息不完整`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `内容检查通过：${sections.length}个板块，${scenes.length}个场景（新增${Math.max(0, scenes.length - 12)}个），${Object.keys(sources).length}份官方依据，${Object.keys(schoolCases).length}个具名学校案例。`,
);
