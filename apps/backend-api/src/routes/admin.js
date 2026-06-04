const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db/pool");
const { redisClient } = require("../queue");
const config = require("../config");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getTenantSettings } = require("../services/settings");
const { generateReply, llmProviderStatus } = require("../providers/llm");
const { liveSttProviderStatus } = require("../providers/sttLive");
const {
  cleanupTestData,
  DEFAULT_TEST_CAMPAIGN_PATTERNS,
  DEFAULT_TEST_PHONES
} = require("../services/testDataCleanup");

const router = express.Router();
router.use(requireAuth, requireRole("platform_admin", "admin"));

router.get("/overview", async (req, res) => {
  if (isPlatformAdmin(req)) return res.json(await platformOverview());

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
      stt: liveSttProviderStatus(),
      llm: llmProviderStatus(),
      serverUrl: Boolean(config.serverUrl),
      frontendUrl: Boolean(config.frontendUrl)
    },
    settings,
    auditLogs: auditLogs.rows
  });
});

router.get("/clients", async (req, res) => {
  if (!isPlatformAdmin(req)) return res.status(403).json({ error: "Platform admin access required" });
  res.json(await listClients());
});

router.get("/costs", async (req, res) => {
  if (!isPlatformAdmin(req)) return res.status(403).json({ error: "Platform admin access required" });
  const days = normalizeCostDays(req.query.days);
  res.json(await platformCostOverview(days));
});

router.post("/clients", async (req, res) => {
  if (!isPlatformAdmin(req)) return res.status(403).json({ error: "Platform admin access required" });

  const {
    clientName,
    planType = "starter",
    adminName,
    adminEmail,
    adminPassword
  } = req.body || {};

  if (!clientName || !adminEmail || !adminPassword) {
    return res.status(400).json({ error: "Client name, login email and password are required" });
  }

  const existing = await query(`SELECT id FROM users WHERE email=$1`, [adminEmail.toLowerCase()]);
  if (existing.rows[0]) return res.status(409).json({ error: "A user with this email already exists" });

  const tenant = await query(
    `INSERT INTO tenants (name, plan_type) VALUES ($1,$2) RETURNING id, name, plan_type, created_at`,
    [clientName.trim(), planType || "starter"]
  );

  await query(
    `INSERT INTO tenant_settings (tenant_id)
     VALUES ($1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenant.rows[0].id]
  );

  const hash = bcrypt.hashSync(adminPassword, 10);
  const user = await query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role)
     VALUES ($1,$2,$3,$4,'operator')
     RETURNING id, name, email, role, created_at`,
    [tenant.rows[0].id, adminName || clientName.trim(), adminEmail.toLowerCase(), hash]
  );

  await audit(req, "client_onboard", {
    tenantId: tenant.rows[0].id,
    clientName: tenant.rows[0].name,
    email: adminEmail.toLowerCase()
  });

  res.status(201).json({ tenant: tenant.rows[0], user: user.rows[0] });
});

router.get("/clients/:tenantId/users", async (req, res) => {
  if (!isPlatformAdmin(req)) return res.status(403).json({ error: "Platform admin access required" });
  const result = await query(
    `SELECT id, name, email, role, created_at FROM users WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [req.params.tenantId]
  );
  res.json(result.rows);
});

router.post("/clients/:tenantId/users", async (req, res) => {
  if (!isPlatformAdmin(req)) return res.status(403).json({ error: "Platform admin access required" });
  const { name, email, password, role = "operator" } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (!["operator", "viewer"].includes(role)) return res.status(400).json({ error: "Invalid client role" });

  const tenant = await query(`SELECT id FROM tenants WHERE id=$1`, [req.params.tenantId]);
  if (!tenant.rows[0]) return res.status(404).json({ error: "Client not found" });

  const hash = bcrypt.hashSync(password, 10);
  const result = await query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, email, role, created_at`,
    [req.params.tenantId, name || "", email.toLowerCase(), hash, role]
  );

  await audit(req, "client_user_create", { tenantId: req.params.tenantId, email: email.toLowerCase(), role });
  res.status(201).json(result.rows[0]);
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

router.get("/test-data-cleanup", async (req, res) => {
  const result = await cleanupTestData({
    tenantId: req.user.tenantId,
    confirm: false,
    campaignNamePatterns: listFromQuery(req.query.campaignNamePatterns) || DEFAULT_TEST_CAMPAIGN_PATTERNS,
    phones: listFromQuery(req.query.phones) || DEFAULT_TEST_PHONES
  });
  res.json(result);
});

router.post("/test-data-cleanup", async (req, res) => {
  const confirm = req.body?.confirm === true;
  const result = await cleanupTestData({
    tenantId: req.user.tenantId,
    confirm,
    campaignNamePatterns: Array.isArray(req.body?.campaignNamePatterns)
      ? req.body.campaignNamePatterns
      : DEFAULT_TEST_CAMPAIGN_PATTERNS,
    phones: Array.isArray(req.body?.phones) ? req.body.phones : DEFAULT_TEST_PHONES
  });

  await audit(req, confirm ? "test_data_cleanup" : "test_data_cleanup_preview", {
    matchedCampaigns: result.matchedCampaigns,
    matchedLeads: result.matchedLeads,
    matchedCalls: result.matchedCalls,
    counts: result.counts,
    deleted: result.deleted || null
  });
  res.json(result);
});

router.get("/gemini-test", async (req, res) => {
  const startedAt = Date.now();
  const providerStatus = llmProviderStatus();
  try {
    const reply = await generateReply({
      lead: {
        tenant_id: req.user.tenantId,
        name: "Test User",
        phone: "0000000000",
        playbook_type: "UNAPPROVED_USERS",
        drop_stage: "UNAPPROVED_USERS",
        offer_amount: "50000",
        language: "Hinglish"
      },
      lastUserMessage: "Hello"
    });
    res.json({
      ok: true,
      provider: providerStatus.primary,
      fallbackProvider: providerStatus.fallback,
      model: providerStatus.primary === "sarvam" ? providerStatus.sarvamModel : providerStatus.geminiModel,
      elapsedMs: Date.now() - startedAt,
      reply
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      provider: providerStatus.primary,
      fallbackProvider: providerStatus.fallback,
      model: providerStatus.primary === "sarvam" ? providerStatus.sarvamModel : providerStatus.geminiModel,
      elapsedMs: Date.now() - startedAt,
      error: err.message
    });
  }
});

router.get("/exotel-calls/:callSid", async (req, res) => {
  if (!config.exotel.accountSid || !config.exotel.apiKey || !config.exotel.apiToken) {
    return res.status(503).json({ error: "Exotel credentials are not configured" });
  }

  const callSid = req.params.callSid;
  const [callDetails, legDetails] = await Promise.all([
    fetchExotelFirst([
      `/v1/Accounts/${encodeURIComponent(config.exotel.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`,
      `/v1/Accounts/${encodeURIComponent(config.exotel.accountSid)}/Calls/${encodeURIComponent(callSid)}`
    ]),
    fetchExotelFirst([
      `/v1/Accounts/${encodeURIComponent(config.exotel.accountSid)}/Calls/${encodeURIComponent(callSid)}/Legs.json`,
      `/v1/Accounts/${encodeURIComponent(config.exotel.accountSid)}/Calls/${encodeURIComponent(callSid)}/Legs`
    ])
      .catch(err => ({ ok: false, status: err.status || 500, error: err.message }))
  ]);

  res.json({ callSid, callDetails, legDetails });
});

async function audit(req, action, details) {
  await query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, details)
     VALUES ($1,$2,$3,$4)`,
    [req.user.tenantId, req.user.userId, action, details]
  );
}

function isPlatformAdmin(req) {
  return req.user?.role === "platform_admin";
}

async function platformOverview() {
  const [clients, counts, auditLogs] = await Promise.all([
    listClients(),
    query(`
      SELECT
        (SELECT COUNT(*)::int FROM tenants) AS tenants,
        (SELECT COUNT(*)::int FROM users WHERE role <> 'platform_admin') AS client_users,
        (SELECT COUNT(*)::int FROM campaigns) AS campaigns,
        (SELECT COUNT(*)::int FROM leads) AS leads,
        (SELECT COUNT(*)::int FROM calls) AS calls
    `),
    query(`
      SELECT al.*, u.email as user_email, t.name as tenant_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id=al.user_id
      LEFT JOIN tenants t ON t.id=al.tenant_id
      ORDER BY al.created_at DESC
      LIMIT 100
    `)
  ]);

  let redis = "ok";
  try {
    await redisClient.ping();
  } catch (err) {
    redis = err.message;
  }

  return {
    scope: "platform",
    clients,
    counts: counts.rows[0] || {},
    providerStatus: {
      database: "ok",
      redis,
      exotel: Boolean(config.exotel.accountSid && config.exotel.apiKey && config.exotel.apiToken && config.exotel.fromNumber),
      gemini: Boolean(config.ai.geminiApiKey),
      deepgram: Boolean(config.ai.deepgramApiKey),
      sarvam: Boolean(config.ai.sarvamApiKey),
      stt: liveSttProviderStatus(),
      llm: llmProviderStatus(),
      serverUrl: Boolean(config.serverUrl),
      frontendUrl: Boolean(config.frontendUrl)
    },
    auditLogs: auditLogs.rows
  };
}

async function listClients() {
  const result = await query(`
    SELECT
      t.id,
      t.name,
      t.plan_type,
      t.created_at,
      COUNT(DISTINCT u.id)::int AS users,
      COUNT(DISTINCT c.id)::int AS campaigns,
      COUNT(DISTINCT l.id)::int AS leads,
      COUNT(DISTINCT ca.id)::int AS calls,
      MIN(u.email) FILTER (WHERE u.role <> 'platform_admin') AS primary_email
    FROM tenants t
    LEFT JOIN users u ON u.tenant_id=t.id
    LEFT JOIN campaigns c ON c.tenant_id=t.id
    LEFT JOIN leads l ON l.tenant_id=t.id
    LEFT JOIN calls ca ON ca.tenant_id=t.id
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `);
  return result.rows;
}

async function platformCostOverview(days) {
  const params = [];
  const callWhere = dateWhere("c.created_at", days, params);
  const sttWhere = dateWhere("e.created_at", days, params);
  const transcriptWhere = dateWhere("tr.created_at", days, params);
  const eventWhere = dateWhere("ve.created_at", days, params);

  const [calls, stt, tts, llm, clients] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int AS calls,
        COUNT(CASE WHEN c.status='completed' THEN 1 END)::int AS completed_calls,
        COALESCE(SUM(GREATEST(c.duration_seconds,0)),0)::float AS duration_seconds,
        COALESCE(SUM(CEIL(GREATEST(c.duration_seconds,0) / 60.0)),0)::float AS billable_minutes,
        COALESCE(SUM(c.cost_estimate),0)::float AS stored_cost
      FROM calls c
      ${callWhere.sql}
    `, callWhere.params),
    query(`
      WITH provider_calls AS (
        SELECT
          CASE
            WHEN LOWER(e.provider) LIKE '%sarvam%' THEN 'sarvam'
            WHEN LOWER(e.provider) LIKE '%deepgram%' THEN 'deepgram'
            ELSE LOWER(e.provider)
          END AS provider,
          e.call_id,
          COUNT(*)::int AS events,
          MAX(GREATEST(c.duration_seconds,0))::float AS duration_seconds
        FROM call_stt_events e
        LEFT JOIN calls c ON c.id=e.call_id
        ${sttWhere.sql}
        GROUP BY provider, e.call_id
      )
      SELECT
        provider,
        COALESCE(SUM(events),0)::int AS events,
        COUNT(call_id)::int AS calls,
        COALESCE(SUM(duration_seconds),0)::float AS duration_seconds,
        COALESCE(SUM(CEIL(duration_seconds / 60.0)),0)::float AS billable_minutes
      FROM provider_calls
      GROUP BY provider
      ORDER BY provider
    `, sttWhere.params),
    query(`
      SELECT
        COUNT(*)::int AS messages,
        COALESCE(SUM(LENGTH(tr.text)),0)::float AS chars
      FROM transcripts tr
      LEFT JOIN calls c ON c.id=tr.call_id
      WHERE tr.speaker='assistant'
      ${transcriptWhere.andSql}
    `, transcriptWhere.params),
    query(`
      SELECT
        CASE
          WHEN LOWER(COALESCE(ve.details->>'provider','')) LIKE '%gemini%' THEN 'gemini'
          ELSE 'sarvam'
        END AS provider,
        COUNT(*)::int AS replies,
        COALESCE(SUM(NULLIF(ve.details->>'textBytes','')::numeric),0)::float AS text_bytes
      FROM voicebot_events ve
      LEFT JOIN campaigns c ON c.id=ve.campaign_id
      WHERE ve.event_type='reply_ready'
        AND COALESCE(ve.details->>'source','')='llm'
      ${eventWhere.andSql}
      GROUP BY provider
      ORDER BY provider
    `, eventWhere.params),
    query(`
      SELECT
        t.id,
        t.name,
        COUNT(c.id)::int AS calls,
        COALESCE(SUM(GREATEST(c.duration_seconds,0)),0)::float AS duration_seconds,
        COALESCE(SUM(CEIL(GREATEST(c.duration_seconds,0) / 60.0)),0)::float AS billable_minutes
      FROM tenants t
      LEFT JOIN calls c ON c.tenant_id=t.id ${days ? "AND c.created_at >= NOW() - ($1::text || ' days')::interval" : ""}
      GROUP BY t.id
      ORDER BY billable_minutes DESC, t.created_at DESC
    `, days ? [days] : [])
  ]);

  const rates = costRates();
  const callStats = calls.rows[0] || {};
  const sarvamStt = stt.rows.find(row => row.provider === "sarvam") || {};
  const deepgramStt = stt.rows.find(row => row.provider === "deepgram") || {};
  const ttsStats = tts.rows[0] || {};
  const sarvamLlm = llm.rows.find(row => row.provider === "sarvam") || {};
  const geminiLlm = llm.rows.find(row => row.provider === "gemini") || {};

  const components = [
    component({
      key: "exotel_voice",
      vendor: "Exotel",
      label: "Outbound voice calls",
      unit: "billable minute",
      quantity: number(callStats.billable_minutes),
      rawUsage: `${formatNumber(callStats.duration_seconds)} seconds across ${callStats.calls || 0} calls`,
      rate: rates.exotelCostPerMinuteInr
    }),
    component({
      key: "sarvam_stt",
      vendor: "Sarvam",
      label: "Saaras live STT",
      unit: "audio hour",
      quantity: number(sarvamStt.duration_seconds) / 3600,
      rawUsage: `${formatNumber(sarvamStt.duration_seconds)} seconds, ${sarvamStt.events || 0} transcript events`,
      rate: rates.sarvamSttCostPerHourInr
    }),
    component({
      key: "sarvam_tts",
      vendor: "Sarvam",
      label: "Bulbul TTS",
      unit: "1K characters",
      quantity: number(ttsStats.chars) / 1000,
      rawUsage: `${formatNumber(ttsStats.chars)} assistant characters, ${ttsStats.messages || 0} messages`,
      rate: rates.sarvamTtsCostPer1kCharsInr
    }),
    component({
      key: "sarvam_llm",
      vendor: "Sarvam",
      label: "Sarvam chat / LLM",
      unit: "1K estimated output tokens",
      quantity: estimatedTokens(sarvamLlm.text_bytes) / 1000,
      rawUsage: `${formatNumber(estimatedTokens(sarvamLlm.text_bytes))} estimated output tokens, ${sarvamLlm.replies || 0} LLM replies`,
      rate: rates.sarvamLlmCostPer1kTokensInr
    }),
    component({
      key: "deepgram_stt",
      vendor: "Deepgram",
      label: "Fallback STT",
      unit: "billable minute",
      quantity: number(deepgramStt.billable_minutes),
      rawUsage: `${formatNumber(deepgramStt.duration_seconds)} seconds, ${deepgramStt.events || 0} transcript events`,
      rate: rates.deepgramCostPerMinuteInr
    }),
    component({
      key: "gemini_llm",
      vendor: "Gemini",
      label: "Fallback LLM",
      unit: "1K estimated output tokens",
      quantity: estimatedTokens(geminiLlm.text_bytes) / 1000,
      rawUsage: `${formatNumber(estimatedTokens(geminiLlm.text_bytes))} estimated output tokens, ${geminiLlm.replies || 0} LLM replies`,
      rate: rates.geminiCostPer1kTokensInr
    })
  ];

  const totalEstimatedInr = roundMoney(components.reduce((sum, item) => sum + item.estimatedCostInr, 0));
  const missingRates = components.filter(item => item.quantity > 0 && item.rateInr === 0).map(item => item.key);

  return {
    period: {
      days,
      label: days ? `Last ${days} days` : "All time"
    },
    summary: {
      totalEstimatedInr,
      storedCallCostInr: roundMoney(callStats.stored_cost),
      calls: callStats.calls || 0,
      completedCalls: callStats.completed_calls || 0,
      billableMinutes: number(callStats.billable_minutes)
    },
    rates,
    missingRates,
    components,
    clients: clients.rows.map(client => ({
      id: client.id,
      name: client.name,
      calls: client.calls || 0,
      durationSeconds: number(client.duration_seconds),
      billableMinutes: number(client.billable_minutes),
      estimatedExotelCostInr: roundMoney(number(client.billable_minutes) * rates.exotelCostPerMinuteInr)
    })),
    notes: [
      "These are operational estimates from app usage, not vendor invoices.",
      "Exotel uses rounded-up per-call billable minutes.",
      "Sarvam LLM tokens are estimated from reply bytes because vendors bill by token internally.",
      "Set Railway rate variables to make totals match your actual plans."
    ]
  };
}

function costRates() {
  return {
    exotelCostPerMinuteInr: moneyEnv("EXOTEL_COST_PER_MINUTE_INR"),
    sarvamSttCostPerHourInr: moneyEnv("SARVAM_STT_COST_PER_HOUR_INR"),
    sarvamTtsCostPer1kCharsInr: moneyEnv("SARVAM_TTS_COST_PER_1K_CHARS_INR"),
    sarvamLlmCostPer1kTokensInr: moneyEnv("SARVAM_LLM_COST_PER_1K_TOKENS_INR"),
    deepgramCostPerMinuteInr: moneyEnv("DEEPGRAM_COST_PER_MINUTE_INR"),
    geminiCostPer1kTokensInr: moneyEnv("GEMINI_COST_PER_1K_TOKENS_INR")
  };
}

function component({ key, vendor, label, unit, quantity, rawUsage, rate }) {
  const usage = number(quantity);
  return {
    key,
    vendor,
    label,
    unit,
    quantity: roundUsage(usage),
    rawUsage,
    rateInr: rate,
    estimatedCostInr: roundMoney(usage * rate),
    configured: rate > 0
  };
}

function dateWhere(column, days, baseParams = []) {
  if (!days) return { sql: "", andSql: "", params: baseParams };
  const params = [...baseParams, days];
  const condition = `${column} >= NOW() - ($${params.length}::text || ' days')::interval`;
  return { sql: `WHERE ${condition}`, andSql: `AND ${condition}`, params };
}

function normalizeCostDays(value) {
  if (!value || value === "all") return null;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return 30;
  return Math.min(Math.round(days), 3650);
}

function moneyEnv(name) {
  const value = Number(process.env[name] || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Math.round(number(value) * 100) / 100;
}

function roundUsage(value) {
  return Math.round(number(value) * 1000) / 1000;
}

function estimatedTokens(bytes) {
  return Math.ceil(number(bytes) / 4);
}

function formatNumber(value) {
  return Math.round(number(value)).toLocaleString("en-IN");
}

function rowsToCountMap(rows) {
  return rows.reduce((acc, row) => {
    acc[row.status || "unknown"] = row.count;
    return acc;
  }, {});
}

function exotelAuthHeader() {
  return `Basic ${Buffer.from(`${config.exotel.apiKey}:${config.exotel.apiToken}`).toString("base64")}`;
}

async function fetchExotel(path) {
  const res = await fetch(`${config.exotel.apiBase}${path}`, {
    headers: { Authorization: exotelAuthHeader() }
  });
  const text = await res.text();
  const body = parseMaybeJson(text);
  if (!res.ok) {
    const err = new Error(typeof body === "string" ? body : JSON.stringify(body));
    err.status = res.status;
    throw err;
  }
  return { ok: true, status: res.status, body };
}

async function fetchExotelFirst(paths) {
  let lastError;
  for (const path of paths) {
    try {
      return await fetchExotel(path);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function listFromQuery(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const list = raw.map(item => String(item || "").trim()).filter(Boolean);
  return list.length ? list : null;
}

module.exports = router;
