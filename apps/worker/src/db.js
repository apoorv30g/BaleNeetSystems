const { Pool } = require("pg");
const config = require("./config");
const isLocal = (config.databaseUrl || "").includes("localhost");
const pool = new Pool({ connectionString: config.databaseUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });
// A dropped idle connection (DB restart, network blip) emits 'error' on the pool;
// without a listener that crashes the whole worker mid-call.
pool.on("error", (err) => {
  console.error("[worker db] Pool client error:", err.message);
});
async function query(sql, params = []) { return pool.query(sql, params); }
module.exports = { query };
