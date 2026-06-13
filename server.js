const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Fastify = require("fastify");
const cookie = require("@fastify/cookie");
const { z } = require("zod");
const { loadConfig } = require("./lib/config");
const { createDatabase, seedDevelopmentInvite, cleanupExpired } = require("./lib/database");
const { AiService, AiServiceError } = require("./lib/ai");
const { loadGuideData } = require("./lib/guide-data");
const {
  redactText,
  containsUrgentRisk,
  detectOutOfScope,
  isLikelyInScope,
} = require("./lib/redaction");
const {
  sha256,
  hmacSha256,
  createPrivateToken,
  encryptText,
  decryptText,
  safeEqual,
} = require("./lib/security");
const { addToCluster, removeFromCluster, refreshClusterCount } = require("./lib/clusters");

const ROOT = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const PUBLIC_FILES = new Set([
  "index.html",
  "scene.html",
  "submit.html",
  "result.html",
  "admin.html",
  "styles.css",
  "data.js",
  "app.js",
  "scene.js",
  "submit.js",
  "result.js",
  "admin.js",
]);

const startSchema = z.object({
  inviteCode: z.string().trim().min(4).max(80),
  text: z.string().trim().min(50).max(1500),
});
const selectSchema = z.object({ issueIndex: z.number().int().min(0).max(2) });
const answerSchema = z.object({ answer: z.string().trim().min(2).max(500) });
const confirmSchema = z.object({
  summary: z.object({
    title: z.string().trim().min(4).max(50),
    situation: z.string().trim().min(10).max(600),
    coreQuestion: z.string().trim().min(4).max(120),
    keyFacts: z.array(z.string().trim().min(2).max(100)).max(8),
  }),
  consent: z.boolean(),
});

function parseBody(schema, body, reply) {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  reply.code(400).send({ error: "提交内容格式不正确，请检查后重试。" });
  return null;
}

function isoAfterDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function joinFacts(items) {
  return items
    .map((item) => String(item).trim().replace(/[。；，,.!?！？]+$/g, ""))
    .filter(Boolean)
    .join("；");
}

function storeEncryptedMessage(db, config, submissionId, role, text) {
  const encrypted = encryptText(text, config.encryptionKey);
  db.prepare(`
    INSERT INTO submission_messages (submission_id, role, ciphertext, iv, auth_tag)
    VALUES (?, ?, ?, ?, ?)
  `).run(submissionId, role, encrypted.ciphertext, encrypted.iv, encrypted.authTag);
}

function getAnswers(db, config, submissionId) {
  return db.prepare(`
    SELECT ciphertext, iv, auth_tag FROM submission_messages
    WHERE submission_id = ? AND role = 'user_answer' ORDER BY id
  `).all(submissionId).map((row) => redactText(decryptText(row, config.encryptionKey)).text);
}

function getSubmissionByToken(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT s.*, r.issues_json, r.selected_issue_json, r.summary_json,
           r.matched_scene_id, r.match_confidence, r.expression_template,
           r.feedback_helpful
    FROM submissions s
    JOIN submission_results r ON r.submission_id = s.id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
  `).get(sha256(token));
}

function betaState(db) {
  const submissions = db.prepare(`
    SELECT COALESCE(SUM(used_count), 0) AS count FROM invite_codes
  `).get().count;
  const newScenes = Math.max(0, loadGuideData().scenes.length - 12);
  return { submissions, newScenes, paused: submissions >= 30 || newScenes >= 5 };
}

function logReview(db, action, clusterId = null, submissionId = null, detail = {}) {
  db.prepare(`
    INSERT INTO review_logs (action, cluster_id, submission_id, detail_json)
    VALUES (?, ?, ?, ?)
  `).run(action, clusterId, submissionId, JSON.stringify(detail));
}

async function buildServer(overrides = {}) {
  const config = loadConfig(overrides);
  const db = overrides.db || createDatabase(config.dbPath);
  const ai = overrides.ai || new AiService(config);
  const app = Fastify({
    logger: overrides.logger ?? true,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });
  const activeAiRequests = new Set();
  const adminFailures = new Map();
  seedDevelopmentInvite(db, config.production);
  cleanupExpired(db);
  await app.register(cookie);

  app.decorate("guideDb", db);
  app.decorate("guideConfig", config);
  app.decorate("guideAi", ai);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (error instanceof AiServiceError) {
      return reply.code(503).send({ error: "AI整理服务暂时不可用，请稍后重试。" });
    }
    return reply.code(error.statusCode || 500).send({
      error: error.statusCode && error.statusCode < 500
        ? error.message
        : "服务器暂时无法完成请求，请稍后重试。",
    });
  });

  async function withAiLock(request, reply, task) {
    const key = hmacSha256(request.ip, config.encryptionKey);
    if (activeAiRequests.has(key)) {
      return reply.code(429).send({ error: "上一项整理仍在进行，请稍后再试。" });
    }
    activeAiRequests.add(key);
    try {
      return await task();
    } finally {
      activeAiRequests.delete(key);
    }
  }

  function requirePrivate(request, reply) {
    const row = getSubmissionByToken(db, request.params.token);
    if (!row) {
      reply.code(404).send({ error: "私密链接不存在或已过期。" });
      return null;
    }
    return row;
  }

  function requireAdmin(request, reply) {
    const token = request.cookies.teacher_admin;
    if (!token) {
      reply.code(401).send({ error: "请先登录管理后台。" });
      return null;
    }
    const session = db.prepare(`
      SELECT id FROM admin_sessions WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP
    `).get(sha256(token));
    if (!session) {
      reply.code(401).send({ error: "管理会话已过期，请重新登录。" });
      return null;
    }
    return session;
  }

  app.get("/api/meta", async () => ({
    beta: betaState(db),
    aiMode: ai.mode,
    scope: "浙江省公办小学、入职1—5年的班主任",
  }));

  app.post("/api/submissions/start", async (request, reply) => {
    const body = parseBody(startSchema, request.body, reply);
    if (!body) return;
    const beta = betaState(db);
    if (beta.paused) {
      return reply.code(503).send({ error: "首轮内测已达到暂停条件，正在集中复盘。" });
    }
    if (containsUrgentRisk(body.text)) {
      return reply.code(422).send({
        stopped: true,
        error: "这可能涉及正在发生的安全风险或明确期限，不适合由本工具继续自动梳理。请立即联系学校负责人、教育行政部门、公安或专业法律渠道。",
      });
    }
    const outOfScope = detectOutOfScope(body.text);
    if (outOfScope) {
      return reply.code(422).send({
        stopped: true,
        error: `这次问题主要属于“${outOfScope}”，超出首轮范围。当前工具只处理班主任职责、工作量、学校支持、午管晚托和低冲突表达。`,
      });
    }
    if (!isLikelyInScope(body.text)) {
      return reply.code(422).send({
        stopped: true,
        error: "这项问题没有明显落在首轮的五类范围内。当前只处理班主任职责、工作量、学生行为支持、午管晚托和任务表达。",
      });
    }

    const invite = db.prepare(`
      SELECT * FROM invite_codes
      WHERE code_hash = ? AND disabled_at IS NULL
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `).get(sha256(body.inviteCode));
    if (!invite || invite.used_count >= invite.max_uses) {
      return reply.code(403).send({ error: "邀请码无效、已过期或使用次数已满。" });
    }

    const ipHash = hmacSha256(request.ip, config.encryptionKey);
    const day = new Date().toISOString().slice(0, 10);
    const ipUsage = db.prepare(`
      SELECT start_count FROM ip_daily_limits WHERE day = ? AND ip_hash = ?
    `).get(day, ipHash);
    if ((ipUsage?.start_count || 0) >= 5) {
      return reply.code(429).send({ error: "今天从当前网络启动的投稿已达5次，请明天再试。" });
    }

    return withAiLock(request, reply, async () => {
      const redacted = redactText(body.text);
      const analyzed = await ai.analyzeInitial(redacted.text);
      const token = createPrivateToken();
      const result = db.transaction(() => {
        const created = db.prepare(`
          INSERT INTO submissions (
            token_hash, invite_code_id, status, redaction_count, source_ip_hash, expires_at
          ) VALUES (?, ?, '整理中', ?, ?, ?)
        `).run(
          sha256(token),
          invite.id,
          redacted.replacements.length,
          ipHash,
          isoAfterDays(90),
        );
        const submissionId = Number(created.lastInsertRowid);
        storeEncryptedMessage(db, config, submissionId, "user_initial", body.text);
        db.prepare(`
          INSERT INTO submission_results (submission_id, issues_json)
          VALUES (?, ?)
        `).run(submissionId, JSON.stringify(analyzed.issues));
        db.prepare("UPDATE submissions SET status = '待确认' WHERE id = ?").run(submissionId);
        db.prepare("UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?").run(invite.id);
        db.prepare(`
          INSERT INTO ip_daily_limits (day, ip_hash, start_count) VALUES (?, ?, 1)
          ON CONFLICT(day, ip_hash) DO UPDATE SET start_count = start_count + 1
        `).run(day, ipHash);
        return submissionId;
      })();
      return {
        token,
        submissionId: result,
        phase: "choose",
        issues: analyzed.issues,
        redactionCount: redacted.replacements.length,
        expiresAt: isoAfterDays(90),
      };
    });
  });

  async function buildConfirmation(row) {
    const issue = JSON.parse(row.selected_issue_json);
    const answers = getAnswers(db, config, row.id);
    const generated = await ai.finalize(issue, answers);
    const validScene = loadGuideData().scenes.some(
      (scene) => scene.id === generated.matchedSceneId,
    );
    const matchedSceneId =
      validScene && generated.matchConfidence >= 0.65 ? generated.matchedSceneId : null;
    const final = matchedSceneId
      ? { ...generated, matchedSceneId }
      : {
          ...generated,
          matchedSceneId: null,
          matchConfidence: Math.min(generated.matchConfidence, 0.49),
          questionsToSchool: [
            "这项任务对应的岗位职责、校内制度或上级方案是什么？",
            "学校如何统计这项任务所占时间，并与现有任务一起评估总工作量？",
            "相关岗位如何分工，能否讨论频次调整、轮班或任务置换？",
          ],
          expressionTemplate:
            `我想先确认一下“${generated.title}”的具体安排。按目前情况，` +
            `${joinFacts(generated.keyFacts)}。我不是想简单拒绝工作，而是希望先了解职责分工、` +
            "工作量计算和支持安排。能否请学校说明现行规则，并结合我的总任务量讨论可执行的调整方案？",
        };
    db.prepare(`
      UPDATE submission_results
      SET summary_json = ?, matched_scene_id = ?, match_confidence = ?,
          expression_template = ?, updated_at = CURRENT_TIMESTAMP
      WHERE submission_id = ?
    `).run(
      JSON.stringify(final),
      final.matchedSceneId,
      final.matchConfidence,
      final.expressionTemplate,
      row.id,
    );
    return {
      phase: "confirm",
      summary: {
        title: final.title,
        situation: final.situation,
        coreQuestion: final.coreQuestion,
        keyFacts: final.keyFacts,
      },
    };
  }

  app.post("/api/submissions/:token/select", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    const body = parseBody(selectSchema, request.body, reply);
    if (!body) return;
    const issues = JSON.parse(row.issues_json);
    const issue = issues[body.issueIndex];
    if (!issue) return reply.code(400).send({ error: "请选择有效的问题。" });
    db.prepare(`
      UPDATE submissions SET selected_issue_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(body.issueIndex, row.id);
    db.prepare(`
      UPDATE submission_results SET selected_issue_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE submission_id = ?
    `).run(JSON.stringify(issue), row.id);

    return withAiLock(request, reply, async () => {
      const next = await ai.nextQuestion(issue, []);
      if (next.ready) return buildConfirmation({ ...row, selected_issue_json: JSON.stringify(issue) });
      return { phase: "question", question: next.question, questionNumber: 1 };
    });
  });

  app.post("/api/submissions/:token/answer", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    const body = parseBody(answerSchema, request.body, reply);
    if (!body) return;
    if (!row.selected_issue_json) {
      return reply.code(409).send({ error: "请先选择当前最想解决的一项。" });
    }
    if (row.followup_count >= 3) {
      return reply.code(409).send({ error: "追问已达到3次上限。" });
    }
    storeEncryptedMessage(db, config, row.id, "user_answer", body.answer);
    db.prepare(`
      UPDATE submissions SET followup_count = followup_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id);

    return withAiLock(request, reply, async () => {
      const issue = JSON.parse(row.selected_issue_json);
      const answers = getAnswers(db, config, row.id);
      const next = answers.length >= 3 ? { ready: true } : await ai.nextQuestion(issue, answers);
      if (next.ready) return buildConfirmation(row);
      return { phase: "question", question: next.question, questionNumber: answers.length + 1 };
    });
  });

  app.post("/api/submissions/:token/rewrite", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    const body = parseBody(answerSchema, request.body, reply);
    if (!body) return;
    if (row.rewrite_count >= 1) {
      return reply.code(409).send({ error: "结果只能补充修改1次。" });
    }
    storeEncryptedMessage(db, config, row.id, "user_answer", body.answer);
    db.prepare(`
      UPDATE submissions SET rewrite_count = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(row.id);
    return withAiLock(request, reply, () => buildConfirmation(row));
  });

  app.post("/api/submissions/:token/confirm", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    const body = parseBody(confirmSchema, request.body, reply);
    if (!body) return;
    const stored = row.summary_json ? JSON.parse(row.summary_json) : null;
    if (!stored) return reply.code(409).send({ error: "请先完成问题梳理。" });
    const fields = [
      redactText(body.summary.title),
      redactText(body.summary.situation),
      redactText(body.summary.coreQuestion),
    ];
    const factFields = body.summary.keyFacts.map((fact) => redactText(fact));
    const summary = {
      ...stored,
      title: fields[0].text,
      situation: fields[1].text,
      coreQuestion: fields[2].text,
      keyFacts: factFields.map((item) => item.text),
    };
    const additionalRedactions =
      fields.reduce((count, item) => count + item.replacements.length, 0) +
      factFields.reduce((count, item) => count + item.replacements.length, 0);
    const status = body.consent ? "已授权聚合" : "私人结果";
    db.transaction(() => {
      if (!body.consent) removeFromCluster(db, row.id);
      db.prepare(`
        UPDATE submissions
        SET status = ?, consent_aggregate = ?, redaction_count = redaction_count + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, body.consent ? 1 : 0, additionalRedactions, row.id);
      db.prepare(`
        UPDATE submission_results SET summary_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE submission_id = ?
      `).run(JSON.stringify(summary), row.id);
      if (body.consent) addToCluster(db, row.id, summary, stored.matchedSceneId);
    })();
    return {
      phase: "result",
      resultUrl: `/result.html?token=${encodeURIComponent(request.params.token)}`,
      consent: body.consent,
    };
  });

  app.get("/api/results/:token", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    if (!["私人结果", "已授权聚合", "待研究", "已关联", "已撤回"].includes(row.status)) {
      return reply.code(409).send({ error: "结果尚未确认。" });
    }
    const summary = JSON.parse(row.summary_json);
    const scene = row.matched_scene_id
      ? loadGuideData().scenes.find((item) => item.id === row.matched_scene_id)
      : null;
    return {
      status: row.status,
      expiresAt: row.expires_at,
      consent: Boolean(row.consent_aggregate),
      summary,
      matchedScene: scene
        ? { id: scene.id, title: scene.title, question: scene.question, status: scene.status }
        : null,
      expressionTemplate: row.expression_template,
      feedbackHelpful: row.feedback_helpful,
      notice: scene
        ? "已匹配到经过人工核验的公开场景。个性化表达只根据你的事实调整措辞。"
        : "暂未匹配到已有场景。以下内容只帮助梳理问题和表达，不生成新的政策结论。",
    };
  });

  app.post("/api/results/:token/feedback", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    const schema = z.object({ helpful: z.boolean() });
    const body = parseBody(schema, request.body, reply);
    if (!body) return;
    db.prepare("UPDATE submission_results SET feedback_helpful = ? WHERE submission_id = ?")
      .run(body.helpful ? 1 : 0, row.id);
    return { ok: true };
  });

  app.post("/api/results/:token/withdraw", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    db.transaction(() => {
      removeFromCluster(db, row.id);
      db.prepare(`
        UPDATE submissions
        SET consent_aggregate = 0, status = '已撤回', withdrawn_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.id);
    })();
    return { ok: true, status: "已撤回" };
  });

  app.delete("/api/results/:token", async (request, reply) => {
    const row = requirePrivate(request, reply);
    if (!row) return;
    db.transaction(() => {
      removeFromCluster(db, row.id);
      db.prepare("DELETE FROM submissions WHERE id = ?").run(row.id);
    })();
    return { ok: true };
  });

  app.get("/api/public/scene-counts", async () => {
    const rows = db.prepare(`
      SELECT linked_scene_id AS sceneId, submission_count AS count
      FROM issue_clusters
      WHERE linked_scene_id IS NOT NULL AND submission_count > 0
    `).all();
    return Object.fromEntries(rows.map((row) => [row.sceneId, row.count]));
  });

  app.post("/api/admin/login", async (request, reply) => {
    const schema = z.object({ password: z.string().min(1).max(200) });
    const body = parseBody(schema, request.body, reply);
    if (!body) return;
    const loginKey = hmacSha256(request.ip, config.encryptionKey);
    const recent = adminFailures.get(loginKey);
    if (recent && recent.count >= 10 && recent.until > Date.now()) {
      return reply.code(429).send({ error: "登录失败次数过多，请15分钟后再试。" });
    }
    if (!safeEqual(body.password, config.adminPassword)) {
      adminFailures.set(loginKey, {
        count: (recent?.until > Date.now() ? recent.count : 0) + 1,
        until: Date.now() + 15 * 60 * 1000,
      });
      return reply.code(401).send({ error: "管理员密码不正确。" });
    }
    adminFailures.delete(loginKey);
    const token = createPrivateToken();
    db.prepare(`
      INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)
    `).run(sha256(token), isoAfterDays(0.5));
    reply.setCookie("teacher_admin", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      path: "/",
      maxAge: 43200,
    });
    return { ok: true };
  });

  app.post("/api/admin/logout", async (request, reply) => {
    const token = request.cookies.teacher_admin;
    if (token) db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(sha256(token));
    reply.clearCookie("teacher_admin", { path: "/" });
    return { ok: true };
  });

  app.get("/api/admin/dashboard", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const clusters = db.prepare(`
      SELECT c.*,
        CASE WHEN c.submission_count >= 3 THEN 1 ELSE 0 END AS research_eligible
      FROM issue_clusters c ORDER BY c.submission_count DESC, c.updated_at DESC
    `).all();
    const submissions = db.prepare(`
      SELECT s.id, s.status, s.created_at, s.expires_at, s.redaction_count,
             r.summary_json, r.matched_scene_id, cm.cluster_id
      FROM submissions s
      JOIN submission_results r ON r.submission_id = s.id
      LEFT JOIN cluster_members cm ON cm.submission_id = s.id
      WHERE s.consent_aggregate = 1
      ORDER BY s.created_at DESC
    `).all().map((row) => ({ ...row, summary: JSON.parse(row.summary_json) }));
    const feedback = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN feedback_helpful = 1 THEN 1 ELSE 0 END) AS helpful
      FROM submission_results WHERE feedback_helpful IS NOT NULL
    `).get();
    return {
      beta: betaState(db),
      feedback,
      clusters,
      submissions,
      scenes: loadGuideData().scenes.map(({ id, title }) => ({ id, title })),
    };
  });

  app.post("/api/admin/invites", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const schema = z.object({
      label: z.string().trim().max(80).default(""),
      maxUses: z.number().int().min(1).max(30).default(30),
      expiresInDays: z.number().int().min(1).max(365).default(30),
    });
    const body = parseBody(schema, request.body, reply);
    if (!body) return;
    const code = `TCH-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    db.prepare(`
      INSERT INTO invite_codes (code_hash, label, max_uses, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(sha256(code), body.label, body.maxUses, isoAfterDays(body.expiresInDays));
    return { code, maxUses: body.maxUses, expiresAt: isoAfterDays(body.expiresInDays) };
  });

  app.patch("/api/admin/clusters/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const schema = z.object({
      status: z.enum(["待研究", "已关联", "超出范围", "不研究"]).optional(),
      linkedSceneId: z.string().max(100).nullable().optional(),
      markNewScene: z.boolean().optional(),
    });
    const body = parseBody(schema, request.body, reply);
    if (!body) return;
    const id = Number(request.params.id);
    const cluster = db.prepare("SELECT * FROM issue_clusters WHERE id = ?").get(id);
    if (!cluster) return reply.code(404).send({ error: "聚合不存在。" });
    if (body.status) {
      db.prepare("UPDATE issue_clusters SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(body.status, id);
    }
    if (Object.prototype.hasOwnProperty.call(body, "linkedSceneId")) {
      db.prepare(`
        UPDATE issue_clusters SET linked_scene_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(body.linkedSceneId, id);
    }
    logReview(db, body.markNewScene ? "新场景发布" : "更新聚合", id, null, body);
    return { ok: true };
  });

  app.post("/api/admin/clusters/:id/merge", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const schema = z.object({ targetClusterId: z.number().int().positive() });
    const body = parseBody(schema, request.body, reply);
    if (!body) return;
    const sourceId = Number(request.params.id);
    if (sourceId === body.targetClusterId) {
      return reply.code(400).send({ error: "不能合并到自身。" });
    }
    db.transaction(() => {
      db.prepare(`
        UPDATE OR REPLACE cluster_members SET cluster_id = ? WHERE cluster_id = ?
      `).run(body.targetClusterId, sourceId);
      db.prepare("DELETE FROM issue_clusters WHERE id = ?").run(sourceId);
      refreshClusterCount(db, body.targetClusterId);
      logReview(db, "合并聚合", body.targetClusterId, null, { sourceId });
    })();
    return { ok: true };
  });

  app.post("/api/admin/clusters/:id/split", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const schema = z.object({
      submissionId: z.number().int().positive(),
      title: z.string().trim().min(4).max(50),
    });
    const body = parseBody(schema, request.body, reply);
    if (!body) return;
    const sourceId = Number(request.params.id);
    const key = `manual:${sha256(`${body.title}:${Date.now()}`).slice(0, 20)}`;
    const created = db.prepare(`
      INSERT INTO issue_clusters (cluster_key, title, status) VALUES (?, ?, '待研究')
    `).run(key, body.title);
    const targetId = Number(created.lastInsertRowid);
    db.prepare(`
      UPDATE cluster_members SET cluster_id = ?
      WHERE cluster_id = ? AND submission_id = ?
    `).run(targetId, sourceId, body.submissionId);
    refreshClusterCount(db, sourceId);
    refreshClusterCount(db, targetId);
    logReview(db, "拆分聚合", targetId, body.submissionId, { sourceId });
    return { ok: true, clusterId: targetId };
  });

  app.get("/api/admin/clusters/:id/export", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const id = Number(request.params.id);
    const cluster = db.prepare("SELECT * FROM issue_clusters WHERE id = ?").get(id);
    if (!cluster) return reply.code(404).send({ error: "聚合不存在。" });
    const members = db.prepare(`
      SELECT s.created_at, r.summary_json, r.matched_scene_id
      FROM cluster_members cm
      JOIN submissions s ON s.id = cm.submission_id
      JOIN submission_results r ON r.submission_id = s.id
      WHERE cm.cluster_id = ? ORDER BY s.created_at
    `).all(id);
    const lines = [
      `# 候选问题研究简报：${cluster.title}`,
      "",
      `- 授权投稿数：${members.length}`,
      `- 当前状态：${cluster.status}`,
      `- 已关联场景：${cluster.linked_scene_id || "无"}`,
      "",
      "## 去标识化事实",
      "",
    ];
    members.forEach((member, index) => {
      const summary = JSON.parse(member.summary_json);
      lines.push(`### 投稿 ${index + 1}`, "", summary.situation, "");
      summary.keyFacts.forEach((fact) => lines.push(`- ${fact}`));
      lines.push("");
    });
    lines.push(
      "## 研究边界",
      "",
      "- 仅核验国家及浙江省官方文件。",
      "- 查找具名学校公开实践，但不把案例写成普遍法定义务。",
      "- 不判断具体学校违法，不承诺教师可以直接拒绝任务。",
      "",
    );
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="cluster-${id}.md"`);
    return lines.join("\n");
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "接口不存在。" });
    }
    const rawPath = request.url.split("?")[0];
    const requested = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
    if (!PUBLIC_FILES.has(requested)) {
      return reply.code(404).type("text/plain; charset=utf-8").send("页面不存在");
    }
    const resolved = path.resolve(ROOT, requested);
    const insideRoot = resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`);
    if (!insideRoot || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return reply.code(404).type("text/plain; charset=utf-8").send("页面不存在");
    }
    const ext = path.extname(resolved).toLowerCase();
    reply.type(MIME[ext] || "application/octet-stream");
    reply.header("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=300");
    return reply.send(fs.createReadStream(resolved));
  });

  app.addHook("onClose", async () => {
    if (!overrides.db) db.close();
  });

  return app;
}

if (require.main === module) {
  buildServer()
    .then((app) => app.listen({ port: app.guideConfig.port, host: app.guideConfig.host }))
    .then((address) => console.log(`教师权益场景网站已启动：${address}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { buildServer };
