const { sha256 } = require("./security");

function refreshClusterCount(db, clusterId) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM cluster_members WHERE cluster_id = ?")
    .get(clusterId).count;
  db.prepare(`
    UPDATE issue_clusters
    SET submission_count = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(count, clusterId);
}

function addToCluster(db, submissionId, summary, matchedSceneId) {
  const normalized = String(summary.clusterKey || summary.title).trim().toLowerCase();
  const clusterKey = matchedSceneId
    ? `scene:${matchedSceneId}`
    : `issue:${sha256(normalized).slice(0, 20)}`;
  const existing = db.prepare("SELECT id FROM issue_clusters WHERE cluster_key = ?").get(clusterKey);
  let clusterId = existing?.id;
  if (!clusterId) {
    const result = db.prepare(`
      INSERT INTO issue_clusters (cluster_key, title, description, linked_scene_id)
      VALUES (?, ?, ?, ?)
    `).run(clusterKey, summary.title, summary.coreQuestion, matchedSceneId || null);
    clusterId = Number(result.lastInsertRowid);
  }
  db.prepare(`
    INSERT OR REPLACE INTO cluster_members (cluster_id, submission_id)
    VALUES (?, ?)
  `).run(clusterId, submissionId);
  refreshClusterCount(db, clusterId);
  return clusterId;
}

function removeFromCluster(db, submissionId) {
  const member = db.prepare("SELECT cluster_id FROM cluster_members WHERE submission_id = ?")
    .get(submissionId);
  if (!member) return;
  db.prepare("DELETE FROM cluster_members WHERE submission_id = ?").run(submissionId);
  refreshClusterCount(db, member.cluster_id);
}

module.exports = { addToCluster, removeFromCluster, refreshClusterCount };
