const panels = [...document.querySelectorAll("[data-panel]")];
const markers = [...document.querySelectorAll("[data-step-marker]")];
const message = document.querySelector("#flow-message");
const story = document.querySelector("#story");
let token = "";
let summary = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function showPanel(name, step) {
  panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  markers.forEach((marker) => {
    marker.classList.toggle("is-active", Number(marker.dataset.stepMarker) <= step);
  });
  message.hidden = true;
  window.scrollTo({ top: 250, behavior: "smooth" });
}

function showMessage(text, type = "error") {
  message.textContent = text;
  message.className = `flow-message flow-message-${type}`;
  message.hidden = false;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "暂时无法完成，请稍后再试。");
  return data;
}

function renderQuestion(data) {
  document.querySelector("#question-number").textContent =
    `补充第 ${data.questionNumber || 1} 个关键事实（最多3次）`;
  document.querySelector("#question-text").textContent = data.question;
  document.querySelector("#answer").value = "";
  showPanel("question", 3);
}

function renderConfirmation(data) {
  summary = data.summary;
  document.querySelector("#summary-title").value = summary.title;
  document.querySelector("#summary-situation").value = summary.situation;
  document.querySelector("#summary-question").value = summary.coreQuestion;
  document.querySelector("#summary-facts").value = (summary.keyFacts || []).join("\n");
  showPanel("confirm", 3);
}

fetch("/api/meta")
  .then((response) => response.json())
  .then((meta) => {
    if (meta.aiMode === "local-rules") {
      document.querySelector("#demo-invite").textContent = "本地演示邀请码：TEACHER-DEMO";
    }
    if (meta.beta.paused) showMessage("首轮内测已达到暂停条件，正在集中复盘。", "notice");
  })
  .catch(() => {});

story.addEventListener("input", () => {
  document.querySelector("#char-count").textContent = `${story.value.length} / 1500`;
});

document.querySelector("#start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "正在去除识别信息并梳理…";
  try {
    const data = await api("/api/submissions/start", {
      method: "POST",
      body: JSON.stringify({
        inviteCode: document.querySelector("#invite-code").value,
        text: story.value,
      }),
    });
    token = data.token;
    document.querySelector("#redaction-note").textContent = data.redactionCount
      ? `系统识别并遮盖了 ${data.redactionCount} 处可能的个人或学校信息。`
      : "系统未识别到明显的姓名、学校或联系方式；仍请你再次检查。";
    document.querySelector("#issue-options").innerHTML = data.issues.map((issue, index) => `
      <label class="issue-option">
        <input type="radio" name="issue" value="${index}" ${index === 0 ? "checked" : ""}>
        <span>
          <strong>${escapeHtml(issue.title)}</strong>
          <small>${escapeHtml(issue.situation)}</small>
          <em>${escapeHtml(issue.coreQuestion)}</em>
        </span>
      </label>
    `).join("");
    showPanel("choose", 2);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "开始梳理";
  }
});

document.querySelector("#choose-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const issueIndex = Number(new FormData(event.currentTarget).get("issue"));
    const data = await api(`/api/submissions/${token}/select`, {
      method: "POST",
      body: JSON.stringify({ issueIndex }),
    });
    data.phase === "question" ? renderQuestion(data) : renderConfirmation(data);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#answer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const data = await api(`/api/submissions/${token}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: document.querySelector("#answer").value }),
    });
    data.phase === "question" ? renderQuestion(data) : renderConfirmation(data);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#rewrite-button").addEventListener("click", async () => {
  const correction = window.prompt("请只补充一个会影响判断的重要事实：");
  if (!correction) return;
  try {
    const data = await api(`/api/submissions/${token}/rewrite`, {
      method: "POST",
      body: JSON.stringify({ answer: correction }),
    });
    renderConfirmation(data);
    showMessage("已根据补充事实重写。结果只能补充修改1次。", "notice");
  } catch (error) {
    showMessage(error.message);
  }
});

document.querySelector("#confirm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const data = await api(`/api/submissions/${token}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        summary: {
          title: document.querySelector("#summary-title").value,
          situation: document.querySelector("#summary-situation").value,
          coreQuestion: document.querySelector("#summary-question").value,
          keyFacts: document.querySelector("#summary-facts").value
            .split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 8),
        },
        consent: document.querySelector("#aggregate-consent").checked,
      }),
    });
    const fullUrl = new URL(data.resultUrl, location.href).href;
    document.querySelector("#result-link").href = fullUrl;
    const urlInput = document.querySelector("#result-url-text");
    urlInput.value = fullUrl;
    // Save token so user can return from other pages
    const resultToken = new URLSearchParams(data.resultUrl.split("?")[1] || "").get("token");
    if (resultToken) {
      try { localStorage.setItem("teacher-guide-last-result", resultToken); } catch (e) {}
    }
    showPanel("finish", 4);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#copy-result-url").addEventListener("click", async () => {
  const input = document.querySelector("#result-url-text");
  try {
    await navigator.clipboard.writeText(input.value);
    const btn = document.querySelector("#copy-result-url");
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = "复制链接"; }, 2000);
  } catch {
    input.select();
  }
});
