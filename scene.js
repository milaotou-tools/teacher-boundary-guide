const { scenes, sections, sources, schoolCases, statusLabels, meta } = window.GUIDE_DATA;
const params = new URLSearchParams(window.location.search);
const scene = scenes.find((item) => item.id === params.get("id"));
const mount = document.querySelector("#scene-detail");

if (!scene) {
  document.title = `场景不存在 · ${meta.title}`;
  mount.innerHTML = `
    <section class="not-found">
      <p class="eyebrow">没有找到这个场景</p>
      <h1>链接可能不完整，或者场景已经调整。</h1>
      <a class="primary-button" href="index.html#scenes">返回全部场景</a>
    </section>
  `;
} else {
  const section = sections.find((item) => item.id === scene.section);
  const status = statusLabels[scene.status];
  document.title = `${scene.title} · ${meta.title}`;

  const renderList = (items) => items.map((item) => `<li>${item}</li>`).join("");

  mount.innerHTML = `
    <article class="detail-shell">
      <header class="detail-hero">
        <div class="detail-breadcrumb">${section.number} · ${section.title}</div>
        <span class="status status-${scene.status}">${status.label}</span>
        <h1>${scene.title}</h1>
        <p class="detail-story">${scene.story}</p>
        <div class="detail-question">
          <span>你真正想问的是</span>
          <strong>${scene.question}</strong>
        </div>
      </header>

      <section class="answer-lead">
        <p class="eyebrow">先说结论</p>
        <p>${scene.summary}</p>
        <div class="status-explanation">
          <strong>${status.label}</strong>
          <span>${status.description}</span>
        </div>
      </section>

      <div class="boundary-grid">
        <section class="content-panel teacher-panel">
          <p class="panel-index">01</p>
          <h2>班主任负责到哪里</h2>
          <ul class="check-list">${renderList(scene.teacherBoundary)}</ul>
        </section>
        <section class="content-panel school-panel">
          <p class="panel-index">02</p>
          <h2>学校及其他岗位负责什么</h2>
          <ul class="check-list">${renderList(scene.schoolDuties)}</ul>
        </section>
      </div>

      <section class="rules-block">
        <div class="rules-column">
          <p class="panel-index">03</p>
          <h2>文件明确规定了什么</h2>
          <ul>${renderList(scene.explicitRules)}</ul>
        </div>
        <div class="rules-column muted">
          <p class="panel-index">04</p>
          <h2>文件没有明确规定什么</h2>
          <ul>${renderList(scene.unclearRules)}</ul>
        </div>
      </section>

      <section class="question-block">
        <div>
          <p class="eyebrow">先不争对错</p>
          <h2>你可以要求学校说明这些问题</h2>
        </div>
        <ol>${scene.questions.map((item) => `<li>${item}</li>`).join("")}</ol>
      </section>

      <section class="practice-block">
        <div class="practice-heading">
          <p class="eyebrow">不只提出问题</p>
          <h2>学校可以怎么做</h2>
          <p>以下是根据政策方向和常见学校管理实践整理的可执行方案，不是国家强制标准。它们可以作为协商时的具体参考。</p>
        </div>
        <div class="practice-grid">
          ${scene.goodPractices
            .map(
              (practice, index) => `
                <article class="practice-card">
                  <span>参考做法 ${String(index + 1).padStart(2, "0")}</span>
                  <h3>${practice.title}</h3>
                  <p>${practice.detail}</p>
                  <small><strong>它解决：</strong>${practice.value}</small>
                </article>
              `,
            )
            .join("")}
        </div>
      </section>

      <section class="case-block">
        <div class="case-heading">
          <div>
            <p class="eyebrow">有人已经这样做</p>
            <h2>具名学校案例</h2>
          </div>
          <p>以下内容来自学校官网或政府信息公开。它们证明某种安排在现实中可以实施，但不代表其他学校必须照搬，也不直接适用于浙江。</p>
        </div>
        ${
          scene.caseIds.length
            ? `<div class="case-list">
                ${scene.caseIds
                  .map((caseId) => {
                    const item = schoolCases[caseId];
                    return `
                      <article class="school-case">
                        <div class="school-case-meta">
                          <span>${item.location}</span>
                          <span>${item.sourceType}</span>
                          <span>${item.publishedAt}</span>
                        </div>
                        <h3>${item.school}</h3>
                        <h4>${item.title}</h4>
                        <p>${item.practice}</p>
                        <div class="school-case-takeaway">
                          <strong>可借鉴点</strong>
                          <span>${item.takeaway}</span>
                        </div>
                        <a href="${item.url}" target="_blank" rel="noreferrer">查看公开原文 <span aria-hidden="true">↗</span></a>
                      </article>
                    `;
                  })
                  .join("")}
              </div>`
            : `<div class="case-empty">
                <strong>暂未找到高度匹配的公开案例</strong>
                <p>我们宁可先留空，也不拿泛泛报道、匿名经验或与问题不对应的学校宣传凑数。</p>
              </div>`
        }
      </section>

      <section class="template-block">
        <div class="template-heading">
          <div>
            <p class="eyebrow">可以直接参考</p>
            <h2>低冲突沟通模板</h2>
          </div>
          <button class="copy-button" type="button" id="copy-template">复制模板</button>
        </div>
        <blockquote id="template-text">${scene.template}</blockquote>
        <p class="template-tip">建议把空白处替换为你的真实任务、频次和时间冲突，不要加入未经核实的定性。</p>
      </section>

      <section class="sources-block">
        <div class="sources-heading">
          <div>
            <p class="eyebrow">依据从哪里来</p>
            <h2>官方文件</h2>
          </div>
          <p>最后核验：${meta.verifiedAt}</p>
        </div>
        <div class="source-list">
          ${scene.sourceIds
            .map((sourceId) => {
              const source = sources[sourceId];
              return `
                <a class="source-card" href="${source.url}" target="_blank" rel="noreferrer">
                  <div>
                    <span>${source.level}</span>
                    <h3>${source.title}</h3>
                    <p>${source.reference}</p>
                    <small>${source.note}</small>
                  </div>
                  <strong aria-hidden="true">↗</strong>
                </a>
              `;
            })
            .join("")}
        </div>
        <p class="source-note">提示：部分教育部旧文件使用官方站内检索链接。区级、校级实施细则可能影响具体执行，请继续向学校或当地教育行政部门核实。</p>
      </section>

      <nav class="detail-nav" aria-label="场景导航">
        <a href="index.html#${section.id}">← 返回“${section.title}”</a>
        ${renderNextScene(scene)}
      </nav>
    </article>
  `;

  document.querySelector("#copy-template").addEventListener("click", copyTemplate);
}

function renderNextScene(currentScene) {
  const index = scenes.findIndex((item) => item.id === currentScene.id);
  const next = scenes[(index + 1) % scenes.length];
  return `<a href="scene.html?id=${next.id}">下一个场景：${next.title} →</a>`;
}

async function copyTemplate() {
  const text = scene.template;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  const toast = document.querySelector("#toast");
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1800);
}
