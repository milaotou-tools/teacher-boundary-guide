const test = require("node:test");
const assert = require("node:assert/strict");
const { buildServer } = require("../server");
const { createDatabase, cleanupExpired } = require("../lib/database");
const { redactText } = require("../lib/redaction");
const { sha256 } = require("../lib/security");
const { AiServiceError } = require("../lib/ai");

class FakeAi {
  constructor({ neverReady = false } = {}) {
    this.neverReady = neverReady;
  }

  get mode() {
    return "test";
  }

  async analyzeInitial() {
    return {
      issues: [
        {
          title: "每天午管没有休息",
          situation: "数学教师每天轮流管理两个班午自习，没有完整午休。",
          coreQuestion: "午管如何计入工作量并安排轮班？",
        },
        {
          title: "晚托任务频次较高",
          situation: "教师两周参加五次晚托，仍需按固定时间上下班。",
          coreQuestion: "学校能否说明频次和弹性安排？",
        },
      ],
    };
  }

  async nextQuestion(_issue, answers) {
    if (this.neverReady) return { ready: false, question: "请再补充一个事实。" };
    return answers.length ? { ready: true, question: "" } : {
      ready: false,
      question: "每天午管多长时间？",
    };
  }

  async finalize(issue, answers) {
    const matched = issue.title.includes("午管");
    return {
      title: issue.title,
      situation: `${issue.situation}${answers.length ? `；${answers.join("；")}` : ""}`,
      coreQuestion: issue.coreQuestion,
      keyFacts: [issue.situation, ...answers],
      questionsToSchool: ["午管排班依据是什么？", "这项任务如何计入总工作量？"],
      expressionTemplate: "我想确认午管排班依据和工作量计算办法，并讨论轮班或任务置换。",
      clusterKey: issue.title,
      matchedSceneId: matched ? "noon-duty-fairness" : null,
      matchConfidence: matched ? 0.9 : 0.2,
    };
  }
}

async function makeApp(ai = new FakeAi()) {
  const db = createDatabase(":memory:");
  const app = await buildServer({ db, ai, logger: false, nodeEnv: "test" });
  return { app, db };
}

const longStory =
  "我是入职第三年的数学老师，教两个班并担任班主任。学校安排我每天轮流管理两个班的午自习，同时两周参加五次晚托，但没有公开总工作量计算办法。";

async function start(app, text = longStory) {
  const response = await app.inject({
    method: "POST",
    url: "/api/submissions/start",
    payload: { inviteCode: "TEACHER-DEMO", text },
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

async function complete(app, { issueIndex = 0, consent = true } = {}) {
  const started = await start(app);
  let response = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/select`,
    payload: { issueIndex },
  });
  if (response.json().phase === "question") {
    response = await app.inject({
      method: "POST",
      url: `/api/submissions/${started.token}/answer`,
      payload: { answer: "每天约四十分钟，由学校口头排班。" },
    });
  }
  assert.equal(response.json().phase, "confirm");
  response = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/confirm`,
    payload: { summary: response.json().summary, consent },
  });
  assert.equal(response.statusCode, 200);
  return started.token;
}

test("敏感信息遮盖但保留通用的学校表述", () => {
  const result = redactText(
    "我们学校安排午管，学生：张三来自杭州市春晓小学，电话13800138000，身份证330106199001011234。",
  );
  assert.match(result.text, /我们学校安排午管/);
  assert.doesNotMatch(result.text, /张三|春晓小学|13800138000|330106199001011234/);
  assert.ok(result.replacements.length >= 3);
});

test("静态服务器只公开前端白名单文件", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const home = await app.inject({ method: "GET", url: "/" });
  assert.equal(home.statusCode, 200);
  assert.match(home.headers["content-type"], /text\/html/);

  for (const url of [
    "/.env",
    "/server.js",
    "/storage/teacher-guide.db",
    "/package.json",
    "/node_modules/fastify/package.json",
    "/README.md",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url} 不应公开访问`);
  }
});

test("多问题最多三项且用户只能选择一个有效索引", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const started = await start(app);
  assert.equal(started.issues.length, 2);
  const invalid = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/select`,
    payload: { issueIndex: 2 },
  });
  assert.equal(invalid.statusCode, 400);
  const valid = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/select`,
    payload: { issueIndex: 1 },
  });
  assert.equal(valid.statusCode, 200);
});

test("完全不属于首轮范围的问题会停止自动梳理", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const response = await app.inject({
    method: "POST",
    url: "/api/submissions/start",
    payload: {
      inviteCode: "TEACHER-DEMO",
      text: "我想了解学校食堂本周的菜单为什么调整了，饭菜口味和价格也有变化，希望网站帮我分析应该选择哪一种午餐。",
    },
  });
  assert.equal(response.statusCode, 422);
  assert.match(response.json().error, /没有明显落在首轮/);
});

test("生产AI失败时返回可重试提示，不静默生成本地答案", async (t) => {
  const failingAi = {
    mode: "deepseek",
    async analyzeInitial() {
      throw new AiServiceError("DeepSeek API 503");
    },
  };
  const { app, db } = await makeApp(failingAi);
  t.after(async () => { await app.close(); db.close(); });
  const response = await app.inject({
    method: "POST",
    url: "/api/submissions/start",
    payload: { inviteCode: "TEACHER-DEMO", text: longStory },
  });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /AI整理服务暂时不可用/);
  const invite = db.prepare(`
    SELECT used_count FROM invite_codes WHERE label = '本地演示邀请码'
  `).get();
  assert.equal(invite.used_count, 0);
});

test("追问最多三次", async (t) => {
  const { app, db } = await makeApp(new FakeAi({ neverReady: true }));
  t.after(async () => { await app.close(); db.close(); });
  const started = await start(app);
  await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/select`,
    payload: { issueIndex: 0 },
  });
  for (let index = 0; index < 3; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/api/submissions/${started.token}/answer`,
      payload: { answer: `第${index + 1}次补充事实` },
    });
    assert.equal(response.statusCode, 200);
  }
  const fourth = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/answer`,
    payload: { answer: "第四次补充事实" },
  });
  assert.equal(fourth.statusCode, 409);
});

test("未匹配问题只给梳理和表达，不生成新政策结论", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const token = await complete(app, { issueIndex: 1, consent: false });
  const response = await app.inject({ method: "GET", url: `/api/results/${token}` });
  const result = response.json();
  assert.equal(result.matchedScene, null);
  assert.match(result.notice, /不生成新的政策结论/);
  assert.ok(result.expressionTemplate);
});

test("授权、撤回和删除均立即生效", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const token = await complete(app, { consent: true });
  let counts = (await app.inject({ method: "GET", url: "/api/public/scene-counts" })).json();
  assert.equal(counts["noon-duty-fairness"], 1);
  const withdrawn = await app.inject({
    method: "POST",
    url: `/api/results/${token}/withdraw`,
  });
  assert.equal(withdrawn.statusCode, 200);
  counts = (await app.inject({ method: "GET", url: "/api/public/scene-counts" })).json();
  assert.equal(counts["noon-duty-fairness"], undefined);
  const deleted = await app.inject({ method: "DELETE", url: `/api/results/${token}` });
  assert.equal(deleted.statusCode, 200);
  const missing = await app.inject({ method: "GET", url: `/api/results/${token}` });
  assert.equal(missing.statusCode, 404);
});

test("最终确认时再次遮盖用户重新写入的识别信息", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  const started = await start(app);
  let response = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/select`,
    payload: { issueIndex: 0 },
  });
  response = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/answer`,
    payload: { answer: "每天约四十分钟，由学校口头排班。" },
  });
  const summary = response.json().summary;
  summary.situation += "，我在杭州市春晓小学，手机号13800138000。";
  const confirmed = await app.inject({
    method: "POST",
    url: `/api/submissions/${started.token}/confirm`,
    payload: { summary, consent: true },
  });
  assert.equal(confirmed.statusCode, 200);
  const result = (await app.inject({
    method: "GET",
    url: `/api/results/${started.token}`,
  })).json();
  assert.doesNotMatch(result.summary.situation, /春晓小学|13800138000/);
});

test("三份相似授权投稿达到研究门槛", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  await complete(app);
  await complete(app);
  await complete(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { password: "admin-demo" },
  });
  const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const dashboardResponse = await app.inject({
    method: "GET",
    url: "/api/admin/dashboard",
    headers: { cookie },
  });
  const cluster = dashboardResponse.json().clusters[0];
  assert.equal(cluster.submission_count, 3);
  assert.equal(cluster.research_eligible, 1);
});

test("管理员可以拆分、合并、导出并关联聚合", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  await complete(app, { issueIndex: 0 });
  await complete(app, { issueIndex: 1 });
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { password: "admin-demo" },
  });
  const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  let dashboardResponse = await app.inject({
    method: "GET",
    url: "/api/admin/dashboard",
    headers: { cookie },
  });
  let dashboard = dashboardResponse.json();
  assert.equal(dashboard.clusters.length, 2);
  const source = dashboard.clusters.find((cluster) => cluster.linked_scene_id);
  const target = dashboard.clusters.find((cluster) => !cluster.linked_scene_id);

  const linked = await app.inject({
    method: "PATCH",
    url: `/api/admin/clusters/${target.id}`,
    headers: { cookie },
    payload: { status: "已关联", linkedSceneId: "after-school-flex" },
  });
  assert.equal(linked.statusCode, 200);

  const member = dashboard.submissions.find((item) => item.cluster_id === source.id);
  const split = await app.inject({
    method: "POST",
    url: `/api/admin/clusters/${source.id}/split`,
    headers: { cookie },
    payload: { submissionId: member.id, title: "拆出的午管问题" },
  });
  assert.equal(split.statusCode, 200);
  const splitId = split.json().clusterId;

  const merged = await app.inject({
    method: "POST",
    url: `/api/admin/clusters/${splitId}/merge`,
    headers: { cookie },
    payload: { targetClusterId: source.id },
  });
  assert.equal(merged.statusCode, 200);

  const exported = await app.inject({
    method: "GET",
    url: `/api/admin/clusters/${source.id}/export`,
    headers: { cookie },
  });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.body, /候选问题研究简报/);
});

test("邀请码最多提交三次，单IP每天最多启动五次", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  await start(app);
  await start(app);
  await start(app);
  const fourth = await app.inject({
    method: "POST",
    url: "/api/submissions/start",
    payload: { inviteCode: "TEACHER-DEMO", text: longStory },
  });
  assert.equal(fourth.statusCode, 403);

  const insert = db.prepare(`
    INSERT INTO invite_codes (code_hash, label, max_uses) VALUES (?, '频控测试', 10)
  `);
  insert.run(sha256("RATE-LIMIT"));
  await startWithCode(app, "RATE-LIMIT");
  await startWithCode(app, "RATE-LIMIT");
  const sixth = await app.inject({
    method: "POST",
    url: "/api/submissions/start",
    payload: { inviteCode: "RATE-LIMIT", text: longStory },
  });
  assert.equal(sixth.statusCode, 429);
});

test("累计30份投稿后自动暂停，即使结果后来删除也不回退", async (t) => {
  const { app, db } = await makeApp();
  t.after(async () => { await app.close(); db.close(); });
  db.prepare("UPDATE invite_codes SET used_count = 30 WHERE label = '本地演示邀请码'").run();
  const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json();
  assert.equal(meta.beta.submissions, 30);
  assert.equal(meta.beta.paused, true);
  const blocked = await app.inject({
    method: "POST",
    url: "/api/submissions/start",
    payload: { inviteCode: "TEACHER-DEMO", text: longStory },
  });
  assert.equal(blocked.statusCode, 503);
});

async function startWithCode(app, inviteCode) {
  const response = await app.inject({
    method: "POST",
    url: "/api/submissions/start",
    payload: { inviteCode, text: longStory },
  });
  assert.equal(response.statusCode, 200);
}

test("过期未授权内容删除，已授权聚合只保留去标识化结果", () => {
  const db = createDatabase(":memory:");
  db.prepare(`
    INSERT INTO invite_codes (code_hash, label, max_uses) VALUES ('x', 'test', 3)
  `).run();
  const unauthorized = db.prepare(`
    INSERT INTO submissions
      (token_hash, invite_code_id, status, source_ip_hash, expires_at)
    VALUES ('a', 1, '私人结果', 'ip', '2020-01-01T00:00:00.000Z')
  `).run().lastInsertRowid;
  const authorized = db.prepare(`
    INSERT INTO submissions
      (token_hash, invite_code_id, status, consent_aggregate, source_ip_hash, expires_at)
    VALUES ('b', 1, '已授权聚合', 1, 'ip', '2020-01-01T00:00:00.000Z')
  `).run().lastInsertRowid;
  const message = db.prepare(`
    INSERT INTO submission_messages (submission_id, role, ciphertext, iv, auth_tag)
    VALUES (?, 'user_initial', 'secret', 'iv', 'tag')
  `);
  message.run(unauthorized);
  message.run(authorized);
  cleanupExpired(db, "2026-06-13T00:00:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM submissions WHERE id = ?").get(unauthorized).count, 0);
  assert.equal(db.prepare("SELECT token_hash FROM submissions WHERE id = ?").get(authorized).token_hash, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM submission_messages").get().count, 0);
  db.close();
});
