const { sections, scenes, statusLabels } = window.GUIDE_DATA;

const sectionList = document.querySelector("#section-list");
let sceneCounts = {};

function renderScenes() {
  sectionList.innerHTML = sections
  .map((section) => {
    const sectionScenes = scenes.filter((scene) => scene.section === section.id);
    return `
      <section class="scene-section" aria-labelledby="${section.id}-title">
        <div class="scene-section-intro">
          <span class="section-number">${section.number}</span>
          <div>
            <h3 id="${section.id}-title">${section.title}</h3>
            <p>${section.intro}</p>
          </div>
        </div>
        <div class="scene-grid">
          ${sectionScenes
            .map(
              (scene, index) => `
                <a class="scene-card" href="scene.html?id=${scene.id}" style="--delay:${index * 70}ms">
                  <div class="card-meta">
                    <span class="status status-${scene.status}">${statusLabels[scene.status].label}</span>
                    <span>约 3 分钟</span>
                  </div>
                  <h4>${scene.title}</h4>
                  <p>${scene.story}</p>
                  <span class="card-question">${scene.question}</span>
                  ${
                    sceneCounts[scene.id]
                      ? `<span class="similar-count">已有 ${sceneCounts[scene.id]} 位教师遇到类似问题</span>`
                      : ""
                  }
                  <span class="card-link">查看依据与行动建议 <span aria-hidden="true">→</span></span>
                </a>
              `,
            )
            .join("")}
        </div>
      </section>
    `;
  })
  .join("");
}

renderScenes();

fetch("/api/public/scene-counts")
  .then((response) => (response.ok ? response.json() : {}))
  .then((counts) => {
    sceneCounts = counts;
    renderScenes();
  })
  .catch(() => {});

const dialog = document.querySelector("#boundary-dialog");

document.querySelector("[data-dialog-open]").addEventListener("click", () => dialog.showModal());
document.querySelectorAll("[data-dialog-close]").forEach((button) => {
  button.addEventListener("click", () => dialog.close());
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
