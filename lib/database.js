const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { sha256 } = require("./security");

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 3,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT UNIQUE,
  invite_code_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  consent_aggregate INTEGER NOT NULL DEFAULT 0,
  selected_issue_index INTEGER,
  followup_count INTEGER NOT NULL DEFAULT 0,
  rewrite_count INTEGER NOT NULL DEFAULT 0,
  redaction_count INTEGER NOT NULL DEFAULT 0,
  source_ip_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id)
);
CREATE TABLE IF NOT EXISTS submission_messages (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS submission_results (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL UNIQUE,
  issues_json TEXT NOT NULL DEFAULT '[]',
  selected_issue_json TEXT,
  summary_json TEXT,
  matched_scene_id TEXT,
  match_confidence REAL,
  expression_template TEXT,
  feedback_helpful INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS issue_clusters (
  id INTEGER PRIMARY KEY,
  cluster_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  submission_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '待研究',
  linked_scene_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id INTEGER NOT NULL,
  submission_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cluster_id, submission_id),
  FOREIGN KEY (cluster_id) REFERENCES issue_clusters(id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS review_logs (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  cluster_id INTEGER,
  submission_id INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ip_daily_limits (
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  start_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_expires ON submissions(expires_at);
CREATE INDEX IF NOT EXISTS idx_clusters_status ON issue_clusters(status);
`;

function createDatabase(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

function seedDevelopmentInvite(db, production) {
  if (production) return;
  db.prepare(`
    INSERT OR IGNORE INTO invite_codes (code_hash, label, max_uses)
    VALUES (?, '本地演示邀请码', 3)
  `).run(sha256("TEACHER-DEMO"));
}

function cleanupExpired(db, now = new Date().toISOString()) {
  db.transaction(() => {
    db.prepare("DELETE FROM submissions WHERE expires_at <= ? AND consent_aggregate = 0").run(now);
    db.prepare(`
      DELETE FROM submission_messages
      WHERE submission_id IN (SELECT id FROM submissions WHERE expires_at <= ?)
    `).run(now);
    db.prepare(`
      UPDATE submissions SET token_hash = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE expires_at <= ? AND consent_aggregate = 1
    `).run(now);
    db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  })();
}

module.exports = { createDatabase, seedDevelopmentInvite, cleanupExpired };
