const { Pool } = require("pg");
const config = require("../config");

const isLocal = (config.databaseUrl || "").includes("localhost");

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

async function query(sql, params = []) {
  return pool.query(sql, params);
}

module.exports = { pool, query };
