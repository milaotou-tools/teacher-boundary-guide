const { loadConfig } = require("../lib/config");
const { createDatabase, cleanupExpired } = require("../lib/database");

const config = loadConfig();
const db = createDatabase(config.dbPath);
cleanupExpired(db);
db.close();
console.log("过期内容清理完成。");
