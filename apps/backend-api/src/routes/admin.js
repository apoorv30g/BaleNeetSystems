const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db/pool");
const { redisClient } = require("../queue");
const config = require("../config");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getTenantSettings } = require("../services/settings");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

router.get("/overview", async (req, res) => {
  const [tenant, users, campaigns, leads, calls, auditLogs, settings] = await Promise.all([
    query(`SELECT id, name, plan_type, created_at FROM tenants WHERE id=$1`, [req.user.tenantId]),
    query(`SELECT id, name, email, role, created_at FROM users WHERE tenant_id=$1 ORDER BY created_at DESC`, [req.user.tenantId]),
    query(`SELECT status, COUNT(*)::int count FROM campaigns WHERE tenant_id=$1 GROUP BY status`, [req.user.tenantId]),
    query(`SELECT status, COUNT(*)::int count FROM leads WHERE tenant_id=$1 GROUP BY status`, [req.user.tenantId]),
    query(`SELECT status, COUNT(*)::int count FROM calls WHERE tenant_id=$1 GROUP BY status`, [req.user.tenantId]),
    query(`SELECT al.*, u.email as user_email FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id WHERE al.tenant_id=$1 ORDER BY al.created_at DESC LIMIT 100`, [req.user.tenantId]),
    getTenantSettings(req.user.tenantId)
  ]);

  let redis = "ok";
  try {
    await redisClient.ping();
  } catch (err) {
    redis = err.message;
  }

  res.json({
    tenant: tenant.rows[0],
    users: users.rows,
    counts: {
      campaigns: rowsToCountMap(campaigns.rows),
      leads: rowsToCountMap(leads.rows),
      calls: rowsToCountMap(calls.rows)
    },
    providerStatus: {
      database: "ok",
      redis,
      exotel: Boolean(config.exotel.accountSid && config.exotel.apiKey && config.exotel.apiToken && config.exotel.fromNumber),
      gemini: Boolean(config.ai.geminiApiKey),
      deepgram: Boolean(config.ai.deepgramApiKey),
      sarvam: Boolean(config.ai.sarvamApiKey),
      serverUrl: Boolean(config.serverUrl),
      frontendUrl: Boolean(config.frontendUrl)
    },
    settings,
    auditLogs: auditLogs.rows
  });
});

router.get("/users", async (req, res) => {
  const result = await query(
    `SELECT id, name, email, role, created_at FROM users WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [req.user.tenantId]
  );
  res.json(result.rows);
});

router.post("/users", async (req, res) => {
  const { name, email, password, role = "operator" } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (!["admin", "operator", "viewer"].includes(role)) return res.status(400).json({ error: "Invalid role" });

  const hash = bcrypt.hashSync(password, 10);
  const result = await query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, email, role, created_at`,
    [req.user.tenantId, name || "", email.toLowerCase(), hash, role]
  );

  await audit(req, "user_create", { email: email.toLowerCase(), role });
  res.json(result.rows[0]);
});

router.patch("/users/:userId", async (req, res) => {
  const { name, role, password } = req.body;
  if (role && !["admin", "operator", "viewer"].includes(role)) return res.status(400).json({ error: "Invalid role" });

  const fields = [];
  const values = [];
  if (name !== undefined) {
    values.push(name);
    fields.push(`name=$${values.length}`);
  }
  if (role) {
    values.push(role);
    fields.push(`role=$${values.length}`);
  }
  if (password) {
    values.push(bcrypt.hashSync(password, 10));
    fields.push(`password_hash=$${values.length}`);
  }
  if (!fields.length) return res.status(400).json({ error: "Nothing to update" });

  values.push(req.params.userId, req.user.tenantId);
  const result = await query(
    `UPDATE users SET ${fields.join(", ")}
     WHERE id=$${values.length - 1} AND tenant_id=$${values.length}
     RETURNING id, name, email, role, created_at`,
    values
  );
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });

  await audit(req, "user_update", { userId: req.params.userId, role: role || undefined, passwordChanged: Boolean(password) });
  res.json(result.rows[0]);
});

router.delete("/users/:userId", async (req, res) => {
  if (req.params.userId === req.user.userId) return res.status(400).json({ error: "You cannot delete your own admin user" });
  const result = await query(
    `DELETE FROM users WHERE id=$1 AND tenant_id=$2 RETURNING id, email`,
    [req.params.userId, req.user.tenantId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });

  await audit(req, "user_delete", { userId: req.params.userId, email: result.rows[0].email });
  res.json({ ok: true });
});

router.get("/audit-logs", async (req, res) => {
  const result = await query(
    `SELECT al.*, u.email as user_email
     FROM audit_logs al
     LEFT JOIN users u ON u.id=al.user_id
     WHERE al.tenant_id=$1
     ORDER BY al.created_at DESC LIMIT 300`,
    [req.user.tenantId]
  );
  res.json(result.rows);
});

router.get("/voicebot-events", async (req, res) => {
  const result = await query(
    `SELECT ve.*, l.name as lead_name, l.phone
     FROM voicebot_events ve
     LEFT JOIN leads l ON l.id=ve.lead_id
     ORDER BY ve.created_at DESC LIMIT 300`
  );
  res.json(result.rows);
});

async function audit(req, action, details) {
  await query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, details)
     VALUES ($1,$2,$3,$4)`,
    [req.user.tenantId, req.user.userId, action, details]
  );
}

function rowsToCountMap(rows) {
  return rows.reduce((acc, row) => {
    acc[row.status || "unknown"] = row.count;
    return acc;
  }, {});
}

module.exports = router;
