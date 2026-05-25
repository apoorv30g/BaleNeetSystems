const express = require("express");
const multer = require("multer");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { parseCsv } = require("../utils/csv");
const { callQueue } = require("../queue");
const { isDnc, logCompliance } = require("../services/compliance");
const { getTenantSettings } = require("../services/settings");
const { OUTCOMES } = require("../services/outcomes");
const { sendLeadLink } = require("../providers/notifications");
const { listPlaybooks } = require("../services/playbooks");
const config = require("../config");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
router.use(requireAuth);

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(res, filename, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(rows.map(row => row.map(csvEscape).join(",")).join("\n"));
}

async function removeQueuedJobsForLead({ tenantId, campaignId, leadId }) {
  let removedJobs = 0;
  for (const status of ["waiting", "delayed", "prioritized", "paused"]) {
    const jobs = await callQueue.getJobs([status], 0, -1, false);
    for (const job of jobs) {
      if (job.data?.tenantId === tenantId && job.data?.campaignId === campaignId && (!leadId || job.data?.leadId === leadId)) {
        await job.remove();
        removedJobs++;
      }
    }
  }
  return removedJobs;
}

async function enqueueLeads({ tenantId, campaignId, leadIds, resetAttempts = false }) {
  const settings = await getTenantSettings(tenantId);
  const params = [tenantId, campaignId];
  let where = `tenant_id=$1 AND campaign_id=$2 AND status IN ('pending','failed','queued')`;
  if (!resetAttempts) {
    params.push(settings.maxCallAttempts);
    where += ` AND attempt_count < $${params.length}`;
  }
  if (leadIds?.length) {
    params.push(leadIds);
    where += ` AND id = ANY($${params.length}::uuid[])`;
  }

  const leads = await query(`SELECT * FROM leads WHERE ${where} LIMIT 1000`, params);
  let queued = 0, blocked = 0;
  const jobs = [];
  const queuedLeadIds = [];

  for (const lead of leads.rows) {
    if (await isDnc(tenantId, lead.phone)) {
      try {
        await logCompliance({ tenantId, leadId: lead.id, rule: "DNC", result: "blocked" });
      } catch {}
      blocked++;
      continue;
    }

    jobs.push({
      name: "call-lead",
      data: { tenantId, campaignId, leadId: lead.id },
      opts: {
        jobId: `lead-call_${tenantId}_${campaignId}_${lead.id}`,
        attempts: settings.maxCallAttempts,
        backoff: { type: "fixed", delay: settings.retryDelayMinutes * 60 * 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000
      }
    });
    queuedLeadIds.push(lead.id);
  }

  if (jobs.length) {
    await withTimeout(callQueue.addBulk(jobs), 10000, "Queue operation timed out");
    const updateSql = resetAttempts
      ? `UPDATE leads SET status='queued', attempt_count=0 WHERE id = ANY($1::uuid[])`
      : `UPDATE leads SET status='queued' WHERE id = ANY($1::uuid[])`;
    await query(updateSql, [queuedLeadIds]);
    await query(`UPDATE campaigns SET status='active' WHERE id=$1 AND tenant_id=$2`, [campaignId, tenantId]);
    queued = jobs.length;
  }

  return { queued, blocked, eligible: leads.rows.length };
}

router.get("/playbooks", async (req, res) => {
  res.json(await listPlaybooks(req.user.tenantId));
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

router.get("/:campaignId", async (req, res) => {
  const campaign = await query(
    `SELECT c.*,
      COUNT(l.id)::int as lead_count,
      COUNT(CASE WHEN l.status='pending' THEN 1 END)::int as pending_count,
      COUNT(CASE WHEN l.status='queued' THEN 1 END)::int as queued_count,
      COUNT(CASE WHEN l.status='called' THEN 1 END)::int as called_count,
      COUNT(CASE WHEN l.status='completed' THEN 1 END)::int as completed_count,
      COUNT(CASE WHEN l.status='failed' THEN 1 END)::int as failed_count
     FROM campaigns c
     LEFT JOIN leads l ON l.campaign_id=c.id
     WHERE c.id=$1 AND c.tenant_id=$2
     GROUP BY c.id`,
    [req.params.campaignId, req.user.tenantId]
  );

  if (!campaign.rows[0]) return res.status(404).json({ error: "Campaign not found" });
  res.json(campaign.rows[0]);
});

router.post("/", async (req, res) => {
  const { name, description, campaignType, playbookType, dailyLimit, maxAttempts, language } = req.body;
  const playbooks = await listPlaybooks(req.user.tenantId);
  const selectedPlaybook = playbookType || "UNAPPROVED_USERS";
  if (!playbooks[selectedPlaybook]) return res.status(400).json({ error: "Invalid playbookType" });

  const result = await query(
    `INSERT INTO campaigns
     (tenant_id, name, description, campaign_type, playbook_type, daily_limit, max_attempts, language, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING *`,
    [
      req.user.tenantId,
      name,
      description || "",
      campaignType || "RETARGETING",
      selectedPlaybook,
      dailyLimit || 200,
      maxAttempts || 3,
      language || "Hinglish"
    ]
  );
  res.json(result.rows[0]);
});

router.put("/:campaignId", async (req, res) => {
  const { name, description, campaignType, playbookType, dailyLimit, maxAttempts, language, status } = req.body;
  if (playbookType) {
    const playbooks = await listPlaybooks(req.user.tenantId);
    if (!playbooks[playbookType]) return res.status(400).json({ error: "Invalid playbookType" });
  }

  const result = await query(
    `UPDATE campaigns SET
       name=COALESCE($1,name),
       description=COALESCE($2,description),
       campaign_type=COALESCE($3,campaign_type),
       playbook_type=COALESCE($4,playbook_type),
       daily_limit=COALESCE($5,daily_limit),
       max_attempts=COALESCE($6,max_attempts),
       language=COALESCE($7,language),
       status=COALESCE($8,status)
     WHERE id=$9 AND tenant_id=$10
     RETURNING *`,
    [name, description, campaignType, playbookType, dailyLimit, maxAttempts, language, status, req.params.campaignId, req.user.tenantId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Campaign not found" });
  res.json(result.rows[0]);
});

router.delete("/:campaignId", async (req, res) => {
  await query(`DELETE FROM campaigns WHERE id=$1 AND tenant_id=$2`, [req.params.campaignId, req.user.tenantId]);
  res.json({ ok: true });
});

router.post("/:campaignId/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file required" });

  const campaign = await query(`SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2`, [req.params.campaignId, req.user.tenantId]);
  if (!campaign.rows[0]) return res.status(404).json({ error: "Campaign not found" });

  const rows = parseCsv(req.file.buffer.toString("utf8"));
  const playbooks = await listPlaybooks(req.user.tenantId);
  let inserted = 0, skipped = 0;
  const errors = [];

  for (const row of rows) {
    const phone = (row.phone || "").replace(/\D/g, "");
    if (!phone) {
      skipped++;
      if (errors.length < 20) errors.push({ row: inserted + skipped, error: "Missing phone" });
      continue;
    }

    const playbookType = row.playbookType || campaign.rows[0].playbook_type;
    if (!playbooks[playbookType]) {
      skipped++;
      if (errors.length < 20) errors.push({ row: inserted + skipped, phone, error: `Unknown playbookType ${playbookType}` });
      continue;
    }

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
          playbookType,
          row.dropStage || playbookType,
          row.dueDate || null,
          row.loanAmount || null,
          row.offerAmount || null,
          row.language || campaign.rows[0].language
        ]
      );
      inserted++;
    } catch {
      skipped++;
      if (errors.length < 20) errors.push({ row: inserted + skipped, phone, error: "Duplicate or invalid row" });
    }
  }

  res.json({ inserted, skipped, total: rows.length, errors });
});

router.post("/:campaignId/queue-calls", async (req, res) => {
  try {
    const result = await enqueueLeads({ tenantId: req.user.tenantId, campaignId: req.params.campaignId });
    res.json(result);
  } catch (err) {
    console.error("queue-calls failed", err);
    res.status(503).json({ error: "Queue calls failed", detail: err.message });
  }
});

router.post("/:campaignId/leads/:leadId/queue-call", async (req, res) => {
  try {
    const result = await enqueueLeads({
      tenantId: req.user.tenantId,
      campaignId: req.params.campaignId,
      leadIds: [req.params.leadId]
    });
    if (!result.eligible) return res.status(404).json({ error: "Lead not found or max attempts reached" });
    res.json({ ...result, leadId: req.params.leadId });
  } catch (err) {
    console.error("queue single call failed", err);
    res.status(503).json({ error: "Queue call failed", detail: err.message });
  }
});

router.post("/:campaignId/clear-queue", async (req, res) => {
  const campaignResult = await query(
    `SELECT id FROM campaigns WHERE id=$1 AND tenant_id=$2`,
    [req.params.campaignId, req.user.tenantId]
  );
  if (!campaignResult.rows[0]) return res.status(404).json({ error: "Campaign not found" });

  const queuedLeads = await query(
    `SELECT id FROM leads WHERE tenant_id=$1 AND campaign_id=$2 AND status='queued'`,
    [req.user.tenantId, req.params.campaignId]
  );

  const leadIds = new Set(queuedLeads.rows.map(row => row.id));
  let removedJobs = 0;

  removedJobs = await removeQueuedJobsForLead({ tenantId: req.user.tenantId, campaignId: req.params.campaignId });

  if (leadIds.size) {
    await query(
      `UPDATE leads SET status='pending' WHERE tenant_id=$1 AND campaign_id=$2 AND status='queued'`,
      [req.user.tenantId, req.params.campaignId]
    );
  }

  await query(`UPDATE campaigns SET status='paused' WHERE id=$1 AND tenant_id=$2`, [req.params.campaignId, req.user.tenantId]);

  res.json({ ok: true, removedJobs, resetLeads: leadIds.size });
});

router.delete("/:campaignId/leads/:leadId", async (req, res) => {
  const leadResult = await query(
    `SELECT * FROM leads WHERE id=$1 AND campaign_id=$2 AND tenant_id=$3`,
    [req.params.leadId, req.params.campaignId, req.user.tenantId]
  );
  const lead = leadResult.rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  await removeQueuedJobsForLead({ tenantId: req.user.tenantId, campaignId: req.params.campaignId, leadId: req.params.leadId });

  await query(`DELETE FROM leads WHERE id=$1 AND campaign_id=$2 AND tenant_id=$3`, [req.params.leadId, req.params.campaignId, req.user.tenantId]);
  res.json({ ok: true });
});

router.post("/:campaignId/leads/bulk-queue", async (req, res) => {
  try {
    const leadIds = Array.isArray(req.body.leadIds) ? req.body.leadIds : [];
    if (!leadIds.length) return res.status(400).json({ error: "leadIds are required" });
    const result = await enqueueLeads({ tenantId: req.user.tenantId, campaignId: req.params.campaignId, leadIds });
    res.json(result);
  } catch (err) {
    console.error("bulk queue failed", err);
    res.status(503).json({ error: "Bulk queue failed", detail: err.message });
  }
});

router.post("/:campaignId/leads/bulk-delete", async (req, res) => {
  const leadIds = Array.isArray(req.body.leadIds) ? req.body.leadIds : [];
  if (!leadIds.length) return res.status(400).json({ error: "leadIds are required" });

  let removedJobs = 0;
  for (const leadId of leadIds) {
    removedJobs += await removeQueuedJobsForLead({ tenantId: req.user.tenantId, campaignId: req.params.campaignId, leadId });
  }

  const result = await query(
    `DELETE FROM leads WHERE tenant_id=$1 AND campaign_id=$2 AND id = ANY($3::uuid[]) RETURNING id`,
    [req.user.tenantId, req.params.campaignId, leadIds]
  );
  res.json({ ok: true, deleted: result.rows.length, removedJobs });
});

router.post("/:campaignId/retry-failed", async (req, res) => {
  try {
    const resetAttempts = Boolean(req.body?.resetAttempts);
    const failed = await query(
      `SELECT id FROM leads WHERE tenant_id=$1 AND campaign_id=$2 AND status='failed' LIMIT 1000`,
      [req.user.tenantId, req.params.campaignId]
    );
    const result = await enqueueLeads({
      tenantId: req.user.tenantId,
      campaignId: req.params.campaignId,
      leadIds: failed.rows.map(row => row.id),
      resetAttempts
    });
    res.json(result);
  } catch (err) {
    console.error("retry failed calls failed", err);
    res.status(503).json({ error: "Retry failed calls failed", detail: err.message });
  }
});

router.get("/:campaignId/queue-status", async (req, res) => {
  const campaignResult = await query(`SELECT id FROM campaigns WHERE id=$1 AND tenant_id=$2`, [req.params.campaignId, req.user.tenantId]);
  if (!campaignResult.rows[0]) return res.status(404).json({ error: "Campaign not found" });

  const counts = await callQueue.getJobCounts("waiting", "active", "delayed", "completed", "failed", "paused");
  const jobs = await callQueue.getJobs(["waiting", "active", "delayed", "paused"], 0, -1, false);
  const campaignJobs = jobs.filter(job => job.data?.tenantId === req.user.tenantId && job.data?.campaignId === req.params.campaignId);
  res.json({
    queue: counts,
    campaignQueued: campaignJobs.length,
    workerHint: counts.active > 0 || counts.waiting > 0 || counts.delayed > 0 ? "Queue has active work" : "No queued work"
  });
});

router.get("/:campaignId/leads", async (req, res) => {
  const result = await query(
    `SELECT * FROM leads WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC LIMIT 500`,
    [req.user.tenantId, req.params.campaignId]
  );
  res.json(result.rows);
});

router.get("/:campaignId/export/leads", async (req, res) => {
  const result = await query(
    `SELECT name, phone, campaign_type, playbook_type, drop_stage, status, attempt_count, due_date, loan_amount, offer_amount, language, created_at
     FROM leads WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC`,
    [req.user.tenantId, req.params.campaignId]
  );
  sendCsv(res, "leads.csv", [
    ["name", "phone", "campaign_type", "playbook_type", "drop_stage", "status", "attempt_count", "due_date", "loan_amount", "offer_amount", "language", "created_at"],
    ...result.rows.map(row => [row.name, row.phone, row.campaign_type, row.playbook_type, row.drop_stage, row.status, row.attempt_count, row.due_date, row.loan_amount, row.offer_amount, row.language, row.created_at])
  ]);
});

router.get("/:campaignId/export/calls", async (req, res) => {
  const result = await query(
    `SELECT c.created_at, l.name, l.phone, c.call_sid, c.status, c.outcome, c.summary, c.duration_seconds, c.error
     FROM calls c
     LEFT JOIN leads l ON l.id=c.lead_id
     WHERE c.tenant_id=$1 AND c.campaign_id=$2
     ORDER BY c.created_at DESC`,
    [req.user.tenantId, req.params.campaignId]
  );
  sendCsv(res, "calls.csv", [
    ["created_at", "name", "phone", "call_sid", "status", "outcome", "summary", "duration_seconds", "error"],
    ...result.rows.map(row => [row.created_at, row.name, row.phone, row.call_sid, row.status, row.outcome, row.summary, row.duration_seconds, row.error])
  ]);
});

router.get("/:campaignId/export/transcripts", async (req, res) => {
  const result = await query(
    `SELECT t.created_at, l.name, l.phone, t.speaker, t.text
     FROM transcripts t
     JOIN calls c ON c.id=t.call_id
     LEFT JOIN leads l ON l.id=c.lead_id
     WHERE c.tenant_id=$1 AND c.campaign_id=$2
     ORDER BY t.created_at DESC`,
    [req.user.tenantId, req.params.campaignId]
  );
  sendCsv(res, "transcripts.csv", [
    ["created_at", "name", "phone", "speaker", "text"],
    ...result.rows.map(row => [row.created_at, row.name, row.phone, row.speaker, row.text])
  ]);
});

router.get("/:campaignId/calls", async (req, res) => {
  const result = await query(
    `SELECT c.*, l.name as lead_name, l.phone, l.playbook_type, l.drop_stage
     FROM calls c
     LEFT JOIN leads l ON l.id=c.lead_id
     WHERE c.tenant_id=$1 AND c.campaign_id=$2
     ORDER BY c.created_at DESC LIMIT 200`,
    [req.user.tenantId, req.params.campaignId]
  );
  res.json(result.rows);
});

router.patch("/:campaignId/calls/:callId/outcome", async (req, res) => {
  const { outcome, summary } = req.body;
  if (!OUTCOMES.includes(outcome)) return res.status(400).json({ error: "Invalid outcome" });

  const result = await query(
    `UPDATE calls SET outcome=$1, summary=COALESCE($2,summary), updated_at=NOW()
     WHERE id=$3 AND campaign_id=$4 AND tenant_id=$5 RETURNING *`,
    [outcome, summary || null, req.params.callId, req.params.campaignId, req.user.tenantId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Call not found" });
  res.json(result.rows[0]);
});

router.post("/:campaignId/leads/:leadId/send-link", async (req, res) => {
  const { channel = "sms", link } = req.body;
  if (!["sms", "whatsapp"].includes(channel)) return res.status(400).json({ error: "Invalid channel" });

  const leadResult = await query(
    `SELECT * FROM leads WHERE id=$1 AND campaign_id=$2 AND tenant_id=$3`,
    [req.params.leadId, req.params.campaignId, req.user.tenantId]
  );
  const lead = leadResult.rows[0];
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const event = await sendLeadLink({ tenantId: req.user.tenantId, lead, channel, link: link || config.loanAppUrl });
  res.json(event);
});

router.get("/:campaignId/transcripts", async (req, res) => {
  const result = await query(
    `SELECT t.*, c.lead_id, l.name as lead_name, l.phone
     FROM transcripts t
     JOIN calls c ON c.id=t.call_id
     LEFT JOIN leads l ON l.id=c.lead_id
     WHERE c.tenant_id=$1 AND c.campaign_id=$2
     ORDER BY t.created_at DESC LIMIT 200`,
    [req.user.tenantId, req.params.campaignId]
  );
  res.json(result.rows);
});

module.exports = router;
