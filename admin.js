const loginPanel = document.querySelector("#login-panel");
const dashboard = document.querySelector("#dashboard");
const adminMessage = document.querySelector("#admin-message");
let dashboardData = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败。");
    error.status = response.status;
    throw error;
  }
  return data;
}

function notify(text) {
  adminMessage.textContent = text;
  adminMessage.hidden = false;
}

function renderDashboard(data) {
  dashboardData = data;
  loginPanel.hidden = true;
  dashboard.hidden = false;
  document.querySelector("#logout-button").hidden = false;
  document.querySelector("#beta-meter").innerHTML = `
    <strong>${data.beta.submissions} / 30</strong><span>投稿</span>
    <strong>${data.beta.newScenes} / 5</strong><span>新增场景</span>
    ${data.beta.paused ? "<em>已暂停，等待复盘</em>" : "<em>内测进行中</em>"}
  `;
  const total = Number(data.feedback.total || 0);
  const helpful = Number(data.feedback.helpful || 0);
  document.querySelector("#feedback-metric").textContent = total
    ? `${helpful} / ${total} 人认为系统帮助其说清问题（${Math.round(helpful / total * 100)}%）`
    : "尚无提交者反馈";

  document.querySelector("#cluster-list").innerHTML = data.clusters.length
    ? data.clusters.map((cluster) => `
      <article class="cluster-card" data-cluster-id="${cluster.id}">
        <div class="cluster-head">
          <div>
            <span class="status ${cluster.research_eligible ? "status-policy" : "status-explain"}">
              ${cluster.submission_count} 份授权投稿
            </span>
            <h3>${escapeHtml(cluster.title)}</h3>
            <p>${escapeHtml(cluster.description || "尚无补充说明")}</p>
          </div>
          <strong>${cluster.research_eligible ? "达到研究门槛" : `还差 ${3 - cluster.submission_count} 份`}</strong>
        </div>
        <div class="cluster-actions">
          <select data-field="status" aria-label="处理状态">
            ${["待研究", "已关联", "超出范围", "不研究"].map((status) =>
              `<option ${cluster.status === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
          <select data-field="scene" aria-label="关联场景">
            <option value="">不关联已有场景</option>
            ${data.scenes.map((scene) =>
              `<option value="${scene.id}" ${cluster.linked_scene_id === scene.id ? "selected" : ""}>${escapeHtml(scene.title)}</option>`).join("")}
          </select>
          <button class="small-button" data-action="save" type="button">保存</button>
          <a class="small-button" href="/api/admin/clusters/${cluster.id}/export">导出研究简报</a>
          <button class="text-button" data-action="merge" type="button">合并</button>
          <button class="text-button" data-action="split" type="button">拆分投稿</button>
        </div>
      </article>
    `).join("")
    : "<p class='empty-state'>还没有经授权进入聚合的问题。</p>";

  document.querySelector("#submission-list").innerHTML = data.submissions.length
    ? data.submissions.map((submission) => `
      <article class="submission-card">
        <div>
          <span>投稿 #${submission.id} · ${escapeHtml(submission.created_at)}</span>
          <strong>${escapeHtml(submission.summary.title)}</strong>
        </div>
        <p>${escapeHtml(submission.summary.situation)}</p>
        <small>聚合 #${submission.cluster_id || "未分组"} · ${submission.matched_scene_id ? "已匹配场景" : "未匹配"}</small>
      </article>
    `).join("")
    : "<p class='empty-state'>还没有授权投稿。</p>";
}

async function loadDashboard() {
  try {
    renderDashboard(await api("/api/admin/dashboard"));
  } catch (error) {
    if (error.status !== 401) notify(error.message);
  }
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: document.querySelector("#admin-password").value }),
    });
    await loadDashboard();
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST" });
  location.reload();
});

document.querySelector("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify({
        label: document.querySelector("#invite-label").value,
        maxUses: 30,
        expiresInDays: 30,
      }),
    });
    document.querySelector("#invite-output").textContent =
      `邀请码：${result.code}（最多30次，30天有效；关闭后无法再次查看明文）`;
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#cluster-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest("[data-cluster-id]");
  const id = Number(card.dataset.clusterId);
  try {
    if (button.dataset.action === "save") {
      const linkedSceneId = card.querySelector("[data-field='scene']").value;
      await api(`/api/admin/clusters/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: card.querySelector("[data-field='status']").value,
          linkedSceneId: linkedSceneId || null,
        }),
      });
    }
    if (button.dataset.action === "merge") {
      const targetClusterId = Number(prompt("请输入要合并到的聚合编号："));
      if (!targetClusterId) return;
      await api(`/api/admin/clusters/${id}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetClusterId }),
      });
    }
    if (button.dataset.action === "split") {
      const submissionId = Number(prompt("请输入要拆出的投稿编号："));
      const title = prompt("新聚合标题：");
      if (!submissionId || !title) return;
      await api(`/api/admin/clusters/${id}/split`, {
        method: "POST",
        body: JSON.stringify({ submissionId, title }),
      });
    }
    notify("操作已保存。");
    renderDashboard(await api("/api/admin/dashboard"));
  } catch (error) {
    notify(error.message);
  }
});

loadDashboard();
