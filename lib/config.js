const crypto = require("node:crypto");
const path = require("node:path");

try {
  process.loadEnvFile?.(path.join(__dirname, "..", ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function parseKey(value) {
  if (!value) return null;
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function loadConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv || process.env.NODE_ENV || "development";
  const production = nodeEnv === "production";
  const encryptionKey =
    overrides.encryptionKey ||
    parseKey(process.env.APP_ENCRYPTION_KEY) ||
    (production ? null : crypto.createHash("sha256").update("teacher-guide-local-development").digest());
  const adminPassword =
    overrides.adminPassword ||
    process.env.ADMIN_PASSWORD ||
    (production ? null : "admin-demo");
  const deepseekApiKey = overrides.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? "";

  if (!encryptionKey) {
    throw new Error("生产环境必须设置有效的 APP_ENCRYPTION_KEY（32 字节）。");
  }
  if (!adminPassword) {
    throw new Error("生产环境必须设置 ADMIN_PASSWORD。");
  }
  if (production && !deepseekApiKey) {
    throw new Error("生产环境必须设置 DEEPSEEK_API_KEY。");
  }

  return {
    nodeEnv,
    production,
    port: Number(overrides.port || process.env.PORT || 4173),
    host: overrides.host || process.env.HOST || "127.0.0.1",
    trustProxy: String(overrides.trustProxy ?? process.env.TRUST_PROXY ?? "false") === "true",
    dbPath:
      overrides.dbPath ||
      process.env.DB_PATH ||
      path.join(__dirname, "..", "storage", "teacher-guide.db"),
    encryptionKey,
    adminPassword,
    deepseekApiKey,
    deepseekModel: overrides.deepseekModel || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    baseUrl: overrides.baseUrl || process.env.BASE_URL || "",
    cookieSecure: overrides.cookieSecure ?? (
      typeof process.env.COOKIE_SECURE !== "undefined"
        ? process.env.COOKIE_SECURE === "true"
        : production
    ),
  };
}

module.exports = { loadConfig };
