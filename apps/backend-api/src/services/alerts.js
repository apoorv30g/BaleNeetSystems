const logger = require("../utils/logger");

// Operational alerting.
//
// Deliberately self-hosted: this posts to a webhook YOU control (Slack/Teams/Google Chat
// incoming webhooks all accept {"text": "..."}). Hosted error trackers such as Sentry were
// avoided on purpose -- they ship payloads to US-based infrastructure, which would reintroduce
// the cross-border data flow that the Deepgram/Gemini removal and the India hosting migration
// exist to prevent. Keep alert text free of borrower PII for the same reason.
//
// Configure with ALERT_WEBHOOK_URL. With it unset, alerts still go to the structured log,
// so nothing silently disappears in development.

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const THROTTLE_MS = Number(process.env.ALERT_THROTTLE_MS || 15 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS || 5000);
const ENV_LABEL = process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || "development";

// alertKey -> { lastSentAt, suppressed }
const throttleState = new Map();

const SEVERITY_PREFIX = {
  critical: "CRITICAL",
  warning: "WARNING",
  info: "INFO"
};

function shouldSend(key, now) {
  const state = throttleState.get(key);
  if (!state) {
    throttleState.set(key, { lastSentAt: now, suppressed: 0 });
    return { send: true, suppressed: 0 };
  }
  if (now - state.lastSentAt >= THROTTLE_MS) {
    const suppressed = state.suppressed;
    throttleState.set(key, { lastSentAt: now, suppressed: 0 });
    return { send: true, suppressed };
  }
  state.suppressed += 1;
  return { send: false, suppressed: state.suppressed };
}

/**
 * Fire an operational alert. Never throws and never rejects — alerting must not be able to
 * break the code path that noticed the problem.
 *
 * @param {string} key       Stable identifier used for throttling (e.g. "sarvam_preflight_failing")
 * @param {string} message   Human-readable summary. No borrower PII.
 * @param {object} [details] Extra structured context for the log line.
 * @param {"critical"|"warning"|"info"} [severity]
 */
async function sendAlert(key, message, details = {}, severity = "warning") {
  const now = Date.now();
  const { send, suppressed } = shouldSend(key, now);

  // Always log, regardless of throttling — the log is the complete record.
  logger[severity === "critical" ? "error" : "warn"]("alert", {
    alertKey: key,
    severity,
    message,
    throttled: !send,
    ...details
  });

  if (!send || !WEBHOOK_URL) return { sent: false, throttled: !send };

  const prefix = SEVERITY_PREFIX[severity] || "ALERT";
  const suffix = suppressed > 0 ? `\n(${suppressed} similar alert(s) suppressed in the last ${Math.round(THROTTLE_MS / 60000)}m)` : "";
  const detailLines = Object.entries(details)
    .map(([k, v]) => `• ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");

  const text = `[${prefix}] [${ENV_LABEL}] ${message}`
    + (detailLines ? `\n${detailLines}` : "")
    + suffix;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) {
      logger.error("alert_delivery_failed", { alertKey: key, status: res.status });
      return { sent: false, error: `status_${res.status}` };
    }
    return { sent: true, suppressed };
  } catch (err) {
    // A failing webhook must not cascade. The log line above already captured the alert.
    logger.error("alert_delivery_failed", { alertKey: key, error: err.message });
    return { sent: false, error: err.message };
  }
}

// Clears throttling for a key — call when a condition recovers, so the next occurrence
// alerts immediately instead of being swallowed by the window.
function clearAlert(key) {
  throttleState.delete(key);
}

function alertsConfigured() {
  return Boolean(WEBHOOK_URL);
}

module.exports = {
  sendAlert,
  clearAlert,
  alertsConfigured,
  _test: { throttleState, shouldSend, THROTTLE_MS }
};
