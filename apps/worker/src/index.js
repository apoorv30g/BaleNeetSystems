require("dotenv").config();
const http = require("http");
const { Worker } = require("bullmq");
const config = require("./config");
const { query } = require("./db");
const { triggerOutboundCall } = require("./exotel");
const { assertSarvamReadyForCall, preflightFailureCount } = require("./health");
const { sendAlert } = require("./alerts");

async function tenantSettings(tenantId) {
  const result = await query(`SELECT * FROM tenant_settings WHERE tenant_id=$1`, [tenantId]);
  const row = result.rows[0];
  return {
    callWindowStart: Number(row?.call_window_start || config.callWindowStart),
    callWindowEnd: Number(row?.call_window_end || config.callWindowEnd),
    maxCallAttempts: Number(row?.max_call_attempts || config.maxCallAttempts),
    // Cross-campaign caps (RBI fair-practice). Read with ?? so an explicit 0 ("no cap")
    // is honoured rather than falling back to the default.
    maxContactsPerDay: Number(row?.max_contacts_per_day ?? config.maxContactsPerDay),
    maxContactsPerWeek: Number(row?.max_contacts_per_week ?? config.maxContactsPerWeek)
  };
}

// Counts calls that actually reached this PERSON in the recent past, across every campaign in
// the tenant -- keyed on phone, not lead id.
//
// campaigns.max_attempts only limits one lead row in one campaign. A borrower enrolled in
// three campaigns has three lead rows with three independent counters, so the per-campaign
// checks all pass while the person is called three times in a day. That is the "persistent
// bothering" pattern RBI fair-practice guidance calls out, so the cap has to be per person.
//
// Only connected calls count: a failed dial did not bother anyone, and counting it would
// strand borrowers whose number is briefly unreachable.
//
// ⚠️ THIS IS THE ENFORCING COPY. An advisory duplicate lives at
// apps/backend-api/src/services/contactFrequency.js, used to preview how many queued leads
// will be skipped. It cannot be imported here (separate workspace, separate db client -- the
// same reason config.js is duplicated). Keep the rule identical in both: the window, the
// connected-status list, and the last-10-digits phone matching.
async function contactFrequencyBlock(tenantId, phone, settings) {
  const maxPerDay = settings.maxContactsPerDay;
  const maxPerWeek = settings.maxContactsPerWeek;
  if (!phone || (!(maxPerDay > 0) && !(maxPerWeek > 0))) return null;

  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE c.created_at >= NOW() - INTERVAL '24 hours')::int AS today,
       COUNT(*) FILTER (WHERE c.created_at >= NOW() - INTERVAL '7 days')::int  AS week
     FROM calls c
     JOIN leads l ON l.id = c.lead_id
     WHERE c.tenant_id = $1
       AND RIGHT(l.phone, 10) = RIGHT($2, 10)
       AND c.status IN ('completed','streaming')`,
    [tenantId, String(phone)]
  );
  const today = Number(result.rows[0]?.today || 0);
  const week = Number(result.rows[0]?.week || 0);

  if (maxPerDay > 0 && today >= maxPerDay) return { reason: "daily_contact_cap", today, week, maxPerDay, maxPerWeek };
  if (maxPerWeek > 0 && week >= maxPerWeek) return { reason: "weekly_contact_cap", today, week, maxPerDay, maxPerWeek };
  return null;
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

  // `force` is an operator-initiated single call (a "call now" button), not a campaign
  // dispatch, so it bypasses the cap the same way it bypasses the calling window.
  if (!force) {
    const capped = await contactFrequencyBlock(tenantId, lead.phone, settings);
    if (capped) {
      // Marked rather than failed: this lead is legitimately callable later, so it must not
      // burn a retry or land in the failed pile. A distinct status keeps it visible.
      await query(`UPDATE leads SET status='frequency_capped' WHERE id=$1`, [leadId]);
      console.log("contact frequency cap blocked call", { leadId, campaignId, ...capped });
      return;
    }
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

  let dispatched;
  try {
    dispatched = await triggerOutboundCall({ to: lead.phone, leadId, campaignId, callId: callRow.rows[0].id });
    await query(`UPDATE calls SET call_sid=$1, status='dialing', updated_at=NOW() WHERE id=$2`, [dispatched.callSid, callRow.rows[0].id]);
    await query(`UPDATE leads SET status='called', attempt_count=attempt_count+1, last_called_at=NOW() WHERE id=$1`, [leadId]);
  } catch (err) {
    await query(`UPDATE calls SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`, [err.message, callRow.rows[0].id]);
    await query(`UPDATE leads SET status='failed', attempt_count=attempt_count+1, last_called_at=NOW() WHERE id=$1`, [leadId]);
    throw err;
  }

  // The call is already placed at this point; a transient failure while pacing/polling must
  // NOT mark the call failed or burn a second attempt — log it and release the slot.
  try {
    await holdDispatchSlot({ leadId, campaignId, callId: callRow.rows[0].id, callSid: dispatched.callSid, dryRun: dispatched.dryRun });
  } catch (err) {
    console.error("holdDispatchSlot failed after successful dispatch", { leadId, campaignId, error: err.message });
  }
}, { connection: { url: config.redisUrl }, concurrency: config.maxConcurrentCalls });

let shuttingDown = false;
let jobsCompleted = 0, jobsFailed = 0;

// A run of consecutive failures means the queue is draining without placing calls -- leads
// burn their attempt counts and nobody finds out until someone opens the dashboard.
const CONSECUTIVE_FAILURE_ALERT = Number(process.env.WORKER_FAILURE_ALERT_THRESHOLD || 5);
let consecutiveFailures = 0;

worker.on("completed", job => {
  jobsCompleted++;
  consecutiveFailures = 0;
  console.log(`completed job ${job.id}`);
});

worker.on("failed", (job, err) => {
  jobsFailed++;
  consecutiveFailures++;
  console.error(`failed job ${job?.id}: ${err.message}`);
  if (consecutiveFailures >= CONSECUTIVE_FAILURE_ALERT) {
    sendAlert(
      "worker_consecutive_failures",
      `${consecutiveFailures} call jobs have failed in a row — outbound calling is effectively stopped.`,
      { consecutiveFailures, jobsCompleted, jobsFailed, lastError: String(err.message).slice(0, 300) },
      "critical"
    ).catch(() => {});
  }
});

console.log(`Worker started with concurrency ${config.maxConcurrentCalls}`);

// Minimal HTTP health server so container orchestrators can probe liveness
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT || 4001);

const healthServer = http.createServer(async (req, res) => {
  if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
  let dbOk = true;
  try { await query("SELECT 1"); } catch { dbOk = false; }
  const sarvamPreflightFailures = preflightFailureCount();
  const ok = !shuttingDown && dbOk;
  res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok,
    shuttingDown,
    dbOk,
    jobsCompleted,
    jobsFailed,
    // Non-zero means calls are currently being blocked before dispatch.
    sarvamPreflightFailures,
    concurrency: config.maxConcurrentCalls
  }));
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
process.on("unhandledRejection", (reason) => {
  console.error("[worker] Unhandled rejection:", reason instanceof Error ? reason.message : String(reason));
});
process.on("uncaughtException", (err) => {
  console.error("[worker] Uncaught exception:", err.message, err.stack);
  process.exit(1);
});

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
