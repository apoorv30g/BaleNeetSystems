const { query } = require("../db/pool");
const config = require("../config");

async function getTenantSettings(tenantId) {
  try {
    const result = await query(`SELECT * FROM tenant_settings WHERE tenant_id=$1`, [tenantId]);
    if (result.rows[0]) return normalize(result.rows[0]);

    await query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenantId]);
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) throw err;
  }

  return {
    tenantId,
    callWindowStart: config.callWindowStart,
    callWindowEnd: config.callWindowEnd,
    maxCallAttempts: config.maxCallAttempts,
    retryDelayMinutes: config.retryDelayMinutes,
    aiDisclosure: `This is ${config.assistantName} calling from ${config.brandName} about your loan application.`,
    smsWebhookUrl: "",
    whatsappWebhookUrl: ""
  };
}

function normalize(row) {
  return {
    tenantId: row.tenant_id,
    callWindowStart: Number(row.call_window_start),
    callWindowEnd: Number(row.call_window_end),
    maxCallAttempts: Number(row.max_call_attempts),
    retryDelayMinutes: Number(row.retry_delay_minutes),
    aiDisclosure: normalizeAiDisclosure(row.ai_disclosure),
    smsWebhookUrl: row.sms_webhook_url || "",
    whatsappWebhookUrl: row.whatsapp_webhook_url || ""
  };
}

function normalizeAiDisclosure(value) {
  const disclosure = String(value || "").trim();
  if (!disclosure || /LoanConnect/i.test(disclosure)) {
    return `This is ${config.assistantName} calling from ${config.brandName} about your loan application.`;
  }
  return disclosure;
}

module.exports = { getTenantSettings };
