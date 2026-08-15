const express = require("express");
const { asyncRouter } = require("../utils/asyncRouter");
const { query } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getTenantSettings } = require("../services/settings");
const { auditSummary, flaggedCalls, runComplianceAuditBatch } = require("../services/complianceAudit");
const { promisesForTenant } = require("../services/collections");

const router = asyncRouter();
router.use(requireAuth);

router.get("/settings", async (req, res) => {
  const settings = await getTenantSettings(req.user.tenantId);
  res.json({
    ...settings,
    rules: [
      "DNC check before queueing",
      "Call window enforcement",
      "No OTP/PIN/password/card/Aadhaar OTP prompts",
      "No guaranteed approval promises",
      "Respectful collections language"
    ]
  });
});

router.put("/settings", requireRole("admin"), async (req, res) => {
  const {
    callWindowStart,
    callWindowEnd,
    maxCallAttempts,
    retryDelayMinutes,
    aiDisclosure,
    smsWebhookUrl,
    whatsappWebhookUrl,
    maxContactsPerDay,
    maxContactsPerWeek
  } = req.body;

  if (Number(callWindowStart) < 0 || Number(callWindowEnd) > 24 || Number(callWindowStart) >= Number(callWindowEnd)) {
    return res.status(400).json({ error: "Invalid call window" });
  }

  // Cross-campaign contact caps. 0 means "no cap"; negative is meaningless, so reject it
  // rather than silently storing a value that disables the guardrail by accident.
  const perDay = maxContactsPerDay === undefined ? 1 : Number(maxContactsPerDay);
  const perWeek = maxContactsPerWeek === undefined ? 3 : Number(maxContactsPerWeek);
  if (!Number.isInteger(perDay) || perDay < 0 || !Number.isInteger(perWeek) || perWeek < 0) {
    return res.status(400).json({ error: "Contact caps must be whole numbers of 0 or more (0 = no cap)" });
  }

  const result = await query(
    `INSERT INTO tenant_settings
     (tenant_id, call_window_start, call_window_end, max_call_attempts, retry_delay_minutes, ai_disclosure, sms_webhook_url, whatsapp_webhook_url, max_contacts_per_day, max_contacts_per_week, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       call_window_start=EXCLUDED.call_window_start,
       call_window_end=EXCLUDED.call_window_end,
       max_call_attempts=EXCLUDED.max_call_attempts,
       retry_delay_minutes=EXCLUDED.retry_delay_minutes,
       ai_disclosure=EXCLUDED.ai_disclosure,
       sms_webhook_url=EXCLUDED.sms_webhook_url,
       whatsapp_webhook_url=EXCLUDED.whatsapp_webhook_url,
       max_contacts_per_day=EXCLUDED.max_contacts_per_day,
       max_contacts_per_week=EXCLUDED.max_contacts_per_week,
       updated_at=NOW()
     RETURNING *`,
    [
      req.user.tenantId,
      Number(callWindowStart),
      Number(callWindowEnd),
      Number(maxCallAttempts),
      Number(retryDelayMinutes),
      aiDisclosure || "",
      smsWebhookUrl || "",
      whatsappWebhookUrl || "",
      perDay,
      perWeek
    ]
  );

  await query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, details)
     VALUES ($1,$2,'settings_update',$3)`,
    [req.user.tenantId, req.user.userId, req.body]
  );

  res.json(result.rows[0]);
});

router.get("/dnc", async (req, res) => {
  const result = await query(
    `SELECT * FROM dnc_list WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500`,
    [req.user.tenantId]
  );
  res.json(result.rows);
});

router.post("/dnc", requireRole("admin"), async (req, res) => {
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  const reason = req.body.reason || "manual";

  if (!phone) return res.status(400).json({ error: "Phone is required" });

  const result = await query(
    `INSERT INTO dnc_list (tenant_id, phone, reason)
     VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET reason=EXCLUDED.reason
     RETURNING *`,
    [req.user.tenantId, phone, reason]
  );

  await query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, details)
     VALUES ($1,$2,'dnc_upsert',$3)`,
    [req.user.tenantId, req.user.userId, { phone, reason }]
  );

  res.json(result.rows[0]);
});

router.delete("/dnc/:phone", requireRole("admin"), async (req, res) => {
  const phone = String(req.params.phone || "").replace(/\D/g, "");
  await query(`DELETE FROM dnc_list WHERE tenant_id=$1 AND phone=$2`, [req.user.tenantId, phone]);
  await query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, details)
     VALUES ($1,$2,'dnc_delete',$3)`,
    [req.user.tenantId, req.user.userId, { phone }]
  );
  res.json({ ok: true });
});

router.get("/logs", async (req, res) => {
  const result = await query(
    `SELECT cl.*, l.name as lead_name, l.phone
     FROM compliance_logs cl
     LEFT JOIN leads l ON l.id=cl.lead_id
     WHERE cl.tenant_id=$1
     ORDER BY cl.created_at DESC LIMIT 500`,
    [req.user.tenantId]
  );
  res.json(result.rows);
});

// ---- Compliance autopilot ----

router.get("/audit/summary", async (req, res) => {
  res.json(await auditSummary(req.user.tenantId, { sinceDays: Number(req.query.days || 7) }));
});

router.get("/audit/flagged", async (req, res) => {
  res.json(await flaggedCalls(req.user.tenantId, { limit: Number(req.query.limit || 50) }));
});

router.post("/audit/run", requireRole("admin"), async (req, res) => {
  const result = await runComplianceAuditBatch({ sinceHours: Number(req.body?.sinceHours || 26) });
  res.json(result);
});

// ---- Promise-to-pay ----
// The working list for a collections team: who committed to pay, how much, and by when.
// Captured automatically from live calls (see routes/voicebot.js).
router.get("/promises", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);
  res.json(await promisesForTenant(req.user.tenantId, { days }));
});

// ---- Cross-client learning network opt-in ----

router.put("/share-learnings", requireRole("admin"), async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  await query(
    `INSERT INTO tenant_settings (tenant_id, share_learnings, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET share_learnings=EXCLUDED.share_learnings, updated_at=NOW()`,
    [req.user.tenantId, enabled]
  );
  await query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, details)
     VALUES ($1,$2,'share_learnings_toggle',$3)`,
    [req.user.tenantId, req.user.userId, { enabled }]
  );
  res.json({ ok: true, shareLearnings: enabled });
});

module.exports = router;
