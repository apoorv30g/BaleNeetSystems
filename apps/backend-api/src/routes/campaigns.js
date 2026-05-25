const express = require("express");
const multer = require("multer");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { parseCsv } = require("../utils/csv");
const { callQueue } = require("../queue");
const { isDnc, logCompliance } = require("../services/compliance");
const config = require("../config");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
router.use(requireAuth);

router.get("/playbooks", async (req, res) => {
  const { PLAYBOOKS } = require("../services/playbooks");
  res.json(PLAYBOOKS);
});

router.get("/", async (req, res) => {
  const result = await query(
    `SELECT c.*,
      COUNT(l.id)::int as lead_count,
      COUNT(CASE WHEN l.status='queued' THEN 1 END)::int as queued_count,
      COUNT(CASE WHEN l.status='called' THEN 1 END)::int as called_count,
      COUNT(CASE WHEN l.status='completed' THEN 1 END)::int as completed_count
     FROM campaigns c
     LEFT JOIN leads l ON l.campaign_id=c.id
     WHERE c.tenant_id=$1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [req.user.tenantId]
  );
  res.json(result.rows);
});

router.post("/", async (req, res) => {
  const { name, description, campaignType, playbookType, dailyLimit, maxAttempts, language } = req.body;
  const result = await query(
    `INSERT INTO campaigns
     (tenant_id, name, description, campaign_type, playbook_type, daily_limit, max_attempts, language, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING *`,
    [
      req.user.tenantId,
      name,
      description || "",
      campaignType || "RETARGETING",
      playbookType || "UNAPPROVED_USERS",
      dailyLimit || 200,
      maxAttempts || 3,
      language || "Hinglish"
    ]
  );
  res.json(result.rows[0]);
});

router.post("/:campaignId/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file required" });

  const campaign = await query(`SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2`, [req.params.campaignId, req.user.tenantId]);
  if (!campaign.rows[0]) return res.status(404).json({ error: "Campaign not found" });

  const rows = parseCsv(req.file.buffer.toString("utf8"));
  let inserted = 0, skipped = 0;

  for (const row of rows) {
    const phone = (row.phone || "").replace(/\D/g, "");
    if (!phone) { skipped++; continue; }

    try {
      await query(
        `INSERT INTO leads
         (tenant_id, campaign_id, name, phone, campaign_type, playbook_type, drop_stage, due_date, loan_amount, offer_amount, language)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          req.user.tenantId,
          req.params.campaignId,
          row.name || "",
          phone,
          row.campaignType || campaign.rows[0].campaign_type,
          row.playbookType || campaign.rows[0].playbook_type,
          row.dropStage || row.playbookType || campaign.rows[0].playbook_type,
          row.dueDate || null,
          row.loanAmount || null,
          row.offerAmount || null,
          row.language || campaign.rows[0].language
        ]
      );
      inserted++;
    } catch {
      skipped++;
    }
  }

  res.json({ inserted, skipped, total: rows.length });
});

router.post("/:campaignId/queue-calls", async (req, res) => {
  const leads = await query(
    `SELECT * FROM leads
     WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('pending','failed')
     AND attempt_count < $3
     LIMIT 1000`,
    [req.user.tenantId, req.params.campaignId, config.maxCallAttempts]
  );

  let queued = 0, blocked = 0;

  for (const lead of leads.rows) {
    if (await isDnc(req.user.tenantId, lead.phone)) {
      await logCompliance({ tenantId: req.user.tenantId, leadId: lead.id, rule: "DNC", result: "blocked" });
      blocked++;
      continue;
    }

    await callQueue.add("call-lead", {
      tenantId: req.user.tenantId,
      campaignId: req.params.campaignId,
      leadId: lead.id
    });

    await query(`UPDATE leads SET status='queued' WHERE id=$1`, [lead.id]);
    queued++;
  }

  await query(`UPDATE campaigns SET status='active' WHERE id=$1`, [req.params.campaignId]);
  res.json({ queued, blocked });
});

router.get("/:campaignId/leads", async (req, res) => {
  const result = await query(
    `SELECT * FROM leads WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC LIMIT 500`,
    [req.user.tenantId, req.params.campaignId]
  );
  res.json(result.rows);
});

module.exports = router;
