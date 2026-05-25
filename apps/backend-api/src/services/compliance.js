const { query } = require("../db/pool");
const config = require("../config");

function isInsideCallWindow() {
  const hour = new Date().getHours();
  return hour >= config.callWindowStart && hour < config.callWindowEnd;
}

async function isDnc(tenantId, phone) {
  const result = await query(`SELECT id FROM dnc_list WHERE tenant_id=$1 AND phone=$2`, [tenantId, phone]);
  return result.rows.length > 0;
}

async function logCompliance({ tenantId, leadId, rule, result, details = {} }) {
  await query(
    `INSERT INTO compliance_logs (tenant_id, lead_id, rule, result, details)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, leadId, rule, result, details]
  );
}

module.exports = { isInsideCallWindow, isDnc, logCompliance };
