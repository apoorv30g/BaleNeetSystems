require("dotenv").config();
const http = require("http");
const { Worker } = require("bullmq");
const config = require("./config");
const { query } = require("./db");
const { triggerOutboundCall } = require("./exotel");
const { assertSarvamReadyForCall } = require("./health");

async function tenantSettings(tenantId) {
  const result = await query(`SELECT * FROM tenant_settings WHERE tenant_id=$1`, [tenantId]);
  const row = result.rows[0];
  return {
    callWindowStart: Number(row?.call_window_start || config.callWindowStart),
    callWindowEnd: Number(row?.call_window_end || config.callWindowEnd),
    maxCallAttempts: Number(row?.max_call_attempts || config.maxCallAttempts)
  };
}

function insideCallWindow(settings) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: config.callWindowTimeZone
  }).format(new Date()));
  return hour >= settings.callWindowStart && hour < settings.callWindowEnd;
}

const worker = new Worker("lead-calls", async (job) => {
  const { tenantId, campaignId, leadId, force = false } = job.data;
  const settings = await tenantSettings(tenantId);

  if (!force && !insideCallWindow(settings)) throw new Error(`Outside call window (${config.callWindowTimeZone})`);

  const leadResult = await query(`SELECT * FROM leads WHERE id=$1 AND tenant_id=$2`, [leadId, tenantId]);
  const lead = leadResult.rows[0];
  if (!lead) throw new Error("Lead not found");

  if (lead.attempt_count >= settings.maxCallAttempts) {
    await query(`UPDATE leads SET status='max_attempts' WHERE id=$1`, [leadId]);
    return;
  }

  const providerHealth = await assertSarvamReadyForCall();
  if (!providerHealth.skipped) {
    console.log("sarvam preflight ok", {
      leadId,
      campaignId,
      cached: providerHealth.cached,
      elapsedMs: providerHealth.elapsedMs,
      ageMs: providerHealth.ageMs
    });
  }

  const callRow = await query(
    `INSERT INTO calls (tenant_id, campaign_id, lead_id, status) VALUES ($1,$2,$3,'initiated') RETURNING *`,
    [tenantId, campaignId, leadId]
  );

  try {
    const result = await triggerOutboundCall({ to: lead.phone, leadId, campaignId, callId: callRow.rows[0].id });
    await query(`UPDATE calls SET call_sid=$1, status='dialing', updated_at=NOW() WHERE id=$2`, [result.callSid, callRow.rows[0].id]);
    await query(`UPDATE leads SET status='called', attempt_count=attempt_count+1, last_called_at=NOW() WHERE id=$1`, [leadId]);
    await holdDispatchSlot({ leadId, campaignId, callId: callRow.rows[0].id, callSid: result.callSid, dryRun: result.dryRun });
  } catch (err) {
    await query(`UPDATE calls SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`, [err.message, callRow.rows[0].id]);
    await query(`UPDATE leads SET status='failed', attempt_count=attempt_count+1, last_called_at=NOW() WHERE id=$1`, [leadId]);
    throw err;
  }
}, { connection: { url: config.redisUrl }, concurrency: config.maxConcurrentCalls });

let shuttingDown = false;
let jobsCompleted = 0, jobsFailed = 0;
worker.on("completed", job => { jobsCompleted++; console.log(`completed job ${job.id}`); });
worker.on("failed", (job, err) => { jobsFailed++; console.error(`failed job ${job?.id}: ${err.message}`); });

console.log(`Worker started with concurrency ${config.maxConcurrentCalls}`);

// Minimal HTTP health server so container orchestrators can probe liveness
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT || 4001);

const healthServer = http.createServer(async (req, res) => {
  if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
  let dbOk = true;
  try { await query("SELECT 1"); } catch { dbOk = false; }
  const ok = !shuttingDown && dbOk;
  res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, shuttingDown, dbOk, jobsCompleted, jobsFailed, concurrency: config.maxConcurrentCalls }));
});
healthServer.listen(HEALTH_PORT, () => console.log(`Worker health server on :${HEALTH_PORT}`));

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] Received ${signal} — draining queue worker...`);
  try {
    healthServer.close();
    // Stop accepting new jobs; wait for running jobs to complete (up to 30s).
    await worker.close(false);
    console.log("[worker] Worker drained cleanly.");
  } catch (err) {
    console.error("[worker] Error during shutdown:", err.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

async function holdDispatchSlot({ leadId, campaignId, callId, callSid, dryRun = false }) {
  if (dryRun) return;

  const minHoldMs = Math.max(0, config.callDispatchSpacingSeconds) * 1000;
  const maxHoldMs = channelHoldMaxMs();
  const startedAt = Date.now();
  let lastStatus = "dialing";
  let terminal = false;

  console.log("holding channel slot", {
    leadId,
    campaignId,
    callSid,
    minHoldSeconds: config.callDispatchSpacingSeconds,
    maxHoldSeconds: Math.round(maxHoldMs / 1000)
  });

  while (Date.now() - startedAt < maxHoldMs) {
    const elapsed = Date.now() - startedAt;
    const status = await callStatus(callId);
    if (status) lastStatus = status;
    terminal = isTerminalCallStatus(lastStatus);

    if (terminal && elapsed >= minHoldMs) break;
    await sleep(Math.min(config.callChannelPollMs, Math.max(250, maxHoldMs - elapsed)));
  }

  console.log("released channel slot", {
    leadId,
    campaignId,
    callSid,
    status: lastStatus,
    terminal,
    elapsedMs: Date.now() - startedAt
  });
}

function channelHoldMaxMs() {
  const configured = Number(config.callChannelHoldMaxSeconds || 0);
  const seconds = configured > 0
    ? configured
    : config.exotel.ringTimeoutSeconds + config.exotel.timeLimitSeconds + 15;
  return Math.max(seconds, config.callDispatchSpacingSeconds, 1) * 1000;
}

async function callStatus(callId) {
  const result = await query(`SELECT status FROM calls WHERE id=$1`, [callId]);
  return result.rows[0]?.status || "";
}

function isTerminalCallStatus(status) {
  return [
    "completed",
    "failed",
    "busy",
    "no-answer",
    "no_answer",
    "canceled",
    "cancelled",
    "timeout",
    "rejected"
  ].includes(String(status || "").toLowerCase());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
