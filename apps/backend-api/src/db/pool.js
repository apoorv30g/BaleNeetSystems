const { Pool } = require("pg");
const config = require("../config");

const isLocal = (config.databaseUrl || "").includes("localhost");

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Explicit pool sizing — prevents silent exhaustion under concurrent call load
  max: Number(process.env.DB_POOL_MAX || 20),
  min: Number(process.env.DB_POOL_MIN || 2),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 3000),
  // Recycle connections periodically to avoid stale TCP state
  maxUses: Number(process.env.DB_MAX_USES || 7500)
});

pool.on("error", (err) => {
  // Unexpected errors on idle clients — log but don't crash
  console.error("[db] Pool client error:", err.message);
});

// Retries transient connection errors up to 3 times with exponential backoff.
async function query(sql, params = []) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      // Only retry on connection/socket errors, not query logic errors
      const retryable = err.code === "ECONNRESET" || err.code === "ETIMEDOUT"
        || err.code === "57P01" // admin_shutdown
        || err.code === "08006"; // connection_failure
      if (!retryable) throw err;
      lastErr = err;
      await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
    }
  }
  throw lastErr;
}

module.exports = { pool, query };
