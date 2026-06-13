const token = new URLSearchParams(location.search).get("token");
const resultMessage = document.querySelector("#result-message");
let resultData = null;

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
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

function notify(text) {
  resultMessage.textContent = text;
  resultMessage.hidden = false;
}

async function loadResult() {
  try {
    resultData = await api(`/api/results/${encodeURIComponent(token || "")}`);
    const summary = resultData.summary;
    document.querySelector("#result-title").textContent = summary.title;
    document.querySelector("#result-situation").textContent = summary.situation;
    document.querySelector("#result-question").textContent = summary.coreQuestion;
    document.querySelector("#result-notice").textContent = resultData.notice;
    document.querySelector("#result-facts").innerHTML =
      summary.keyFacts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("");
    document.querySelector("#school-questions").innerHTML =
      summary.questionsToSchool.map((question) => `<li>${escapeHtml(question)}</li>`).join("");
    document.querySelector("#expression-template").textContent = resultData.expressionTemplate;
    if (resultData.matchedScene) {
      document.querySelector("#matched-block").hidden = false;
      document.querySelector("#matched-title").textContent = resultData.matchedScene.title;
      document.querySelector("#matched-question").textContent = resultData.matchedScene.question;
      document.querySelector("#matched-link").href = `scene.html?id=${resultData.matchedScene.id}`;
    }
    document.querySelector("#consent-status").textContent = resultData.consent
      ? "你已授权去标识化问题参与相似问题统计。"
      : "这份结果没有进入公共统计。";
    document.querySelector("#withdraw-button").hidden = !resultData.consent;
    document.querySelector("#result-loading").hidden = true;
    document.querySelector("#result-content").hidden = false;
  } catch (error) {
    document.querySelector("#result-loading").textContent = error.message;
  }
}

document.querySelector("#copy-result").addEventListener("click", async (event) => {
  await navigator.clipboard.writeText(document.querySelector("#expression-template").textContent);
  event.currentTarget.textContent = "已复制";
});

document.querySelectorAll("[data-helpful]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await api(`/api/results/${encodeURIComponent(token)}/feedback`, {
        method: "POST",
        body: JSON.stringify({ helpful: button.dataset.helpful === "true" }),
      });
      notify("反馈已记录，谢谢。");
    } catch (error) {
      notify(error.message);
    }
  });
});

document.querySelector("#withdraw-button").addEventListener("click", async () => {
  if (!confirm("撤回后，这份问题将不再参与相似问题统计。继续吗？")) return;
  try {
    await api(`/api/results/${encodeURIComponent(token)}/withdraw`, { method: "POST" });
    document.querySelector("#withdraw-button").hidden = true;
    document.querySelector("#consent-status").textContent = "聚合授权已撤回。私人结果仍可在有效期内查看。";
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#delete-button").addEventListener("click", async () => {
  if (!confirm("删除后无法找回，私密链接会立即失效。确定删除吗？")) return;
  try {
    await api(`/api/results/${encodeURIComponent(token)}`, { method: "DELETE" });
    document.querySelector("#result-content").hidden = true;
    notify("私人结果已删除。");
  } catch (error) {
    notify(error.message);
  }
});

loadResult();
