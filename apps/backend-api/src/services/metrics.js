const { query } = require("../db/pool");
const { llmProviderStatus } = require("../providers/llm");
const { sendAlert, clearAlert, alertsConfigured } = require("./alerts");
const logger = require("../utils/logger");

// Operational metrics.
//
// Self-hosted by design: exposed on an endpoint you scrape yourself rather than pushed to a
// hosted APM. Third-party observability vendors would receive operational data from a system
// holding borrower records, reintroducing the cross-border flow the residency work removed.
//
// Two kinds of signal:
//   - counters: in-process, reset on restart. Cheap, immediate.
//   - gauges:   derived from the database on request. Survive restarts, cost a query.

const counters = {
  httpRequests: 0,
  httpErrors5xx: 0,
  authFailures: 0,
  voicebotCallsStarted: 0,
  voicebotCallsCompleted: 0,
  llmCalls: 0,
  llmFailures: 0,
  sttReconnects: 0
};

const startedAt = Date.now();

function increment(name, by = 1) {
  if (!(name in counters)) return;
  counters[name] += by;
}

function snapshotCounters() {
  return { ...counters, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
}

// Health thresholds. Deliberately conservative -- an alert nobody trusts gets muted, and a
// muted alert is worse than none.
const CALL_FAILURE_RATE_THRESHOLD = Number(process.env.ALERT_CALL_FAILURE_RATE || 0.5);
const CALL_FAILURE_MIN_SAMPLE = Number(process.env.ALERT_CALL_FAILURE_MIN_SAMPLE || 10);
const QUEUE_DEPTH_THRESHOLD = Number(process.env.ALERT_QUEUE_DEPTH || 500);
const COMPLIANCE_FAIL_THRESHOLD = Number(process.env.ALERT_COMPLIANCE_FAILS || 1);

async function databaseGauges() {
  const gauges = {};

  // Call outcomes over the last hour — the primary "is calling working" signal.
  try {
    const calls = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(CASE WHEN status='failed' THEN 1 END)::int AS failed,
        COUNT(CASE WHEN status='completed' THEN 1 END)::int AS completed
      FROM calls
      WHERE created_at > NOW() - INTERVAL '1 hour'
    `);
    const row = calls.rows[0] || {};
    gauges.callsLastHour = Number(row.total || 0);
    gauges.callsFailedLastHour = Number(row.failed || 0);
    gauges.callsCompletedLastHour = Number(row.completed || 0);
    gauges.callFailureRateLastHour = gauges.callsLastHour > 0
      ? Number((gauges.callsFailedLastHour / gauges.callsLastHour).toFixed(3))
      : 0;
  } catch (err) {
    gauges.callsError = err.message;
  }

  // Compliance failures are a regulatory signal, not just an operational one.
  try {
    const compliance = await query(`
      SELECT COUNT(*)::int AS fails
      FROM call_compliance_audits
      WHERE verdict='fail' AND created_at > NOW() - INTERVAL '24 hours'
    `);
    gauges.complianceFailsLast24h = Number(compliance.rows[0]?.fails || 0);
  } catch (err) {
    // Table may not exist on an un-migrated database; not fatal for the endpoint.
    if (!["42P01", "42703"].includes(err.code)) gauges.complianceError = err.message;
  }

  try {
    const leads = await query(`
      SELECT COUNT(*)::int AS queued FROM leads WHERE status='queued'
    `);
    gauges.leadsQueued = Number(leads.rows[0]?.queued || 0);
  } catch (err) {
    gauges.leadsError = err.message;
  }

  return gauges;
}

// Evaluates gauges against thresholds and fires alerts. Called on a timer, not per-request,
// so scraping the endpoint cannot spam alerts.
async function evaluateAlerts() {
  let gauges;
  try {
    gauges = await databaseGauges();
  } catch (err) {
    logger.error("metrics_evaluation_failed", { error: err.message });
    return;
  }

  // Only meaningful with enough samples -- 1 failure out of 1 call is not a 100% failure rate
  // worth waking someone for.
  if (
    gauges.callsLastHour >= CALL_FAILURE_MIN_SAMPLE
    && gauges.callFailureRateLastHour >= CALL_FAILURE_RATE_THRESHOLD
  ) {
    await sendAlert(
      "call_failure_rate_high",
      `${Math.round(gauges.callFailureRateLastHour * 100)}% of calls failed in the last hour (${gauges.callsFailedLastHour}/${gauges.callsLastHour}).`,
      { failed: gauges.callsFailedLastHour, total: gauges.callsLastHour },
      "critical"
    );
  } else if (gauges.callsLastHour >= CALL_FAILURE_MIN_SAMPLE) {
    clearAlert("call_failure_rate_high");
  }

  if (gauges.leadsQueued >= QUEUE_DEPTH_THRESHOLD) {
    await sendAlert(
      "queue_depth_high",
      `${gauges.leadsQueued} leads are queued and not being dispatched — the worker may be stalled.`,
      { queued: gauges.leadsQueued, threshold: QUEUE_DEPTH_THRESHOLD },
      "warning"
    );
  } else {
    clearAlert("queue_depth_high");
  }

  if (gauges.complianceFailsLast24h >= COMPLIANCE_FAIL_THRESHOLD) {
    await sendAlert(
      "compliance_failures",
      `${gauges.complianceFailsLast24h} call(s) FAILED the compliance audit in the last 24h. Review before continuing campaigns.`,
      { count: gauges.complianceFailsLast24h },
      "critical"
    );
  } else {
    clearAlert("compliance_failures");
  }
}

async function metricsSnapshot() {
  const gauges = await databaseGauges();
  return {
    ok: true,
    ts: new Date().toISOString(),
    counters: snapshotCounters(),
    gauges,
    llm: llmProviderStatus(),
    alertingConfigured: alertsConfigured()
  };
}

let timer = null;

function startMetricsMonitor() {
  const intervalMs = Number(process.env.METRICS_EVAL_INTERVAL_MS || 5 * 60 * 1000);
  if (intervalMs <= 0) return { stop() {} };

  if (!alertsConfigured()) {
    logger.warn("alerting_not_configured", {
      hint: "Set ALERT_WEBHOOK_URL to receive operational alerts. Metrics are still logged."
    });
  }

  timer = setInterval(() => {
    evaluateAlerts().catch(err => logger.error("alert_evaluation_failed", { error: err.message }));
  }, intervalMs);
  timer.unref?.(); // never hold the process open

  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = {
  increment,
  metricsSnapshot,
  evaluateAlerts,
  startMetricsMonitor,
  _test: { counters, databaseGauges, snapshotCounters }
};
