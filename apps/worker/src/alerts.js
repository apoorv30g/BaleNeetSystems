// Operational alerting for the worker process.
//
// Intentionally a small standalone copy rather than a shared import: the worker is a separate
// deployable with its own package.json and already duplicates config.js for the same reason.
//
// Posts to a webhook YOU control. Hosted error trackers were avoided deliberately -- they ship
// payloads to US infrastructure, which would reintroduce the cross-border data flow that the
// India hosting migration exists to prevent. Keep alert text free of borrower PII.

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const THROTTLE_MS = Number(process.env.ALERT_THROTTLE_MS || 15 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS || 5000);
const ENV_LABEL = process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || "development";

const throttleState = new Map();

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

async function sendAlert(key, message, details = {}, severity = "warning") {
  const now = Date.now();
  const { send, suppressed } = shouldSend(key, now);

  console[severity === "critical" ? "error" : "warn"]("[alert]", JSON.stringify({
    alertKey: key, severity, message, throttled: !send, ...details
  }));

  if (!send || !WEBHOOK_URL) return { sent: false, throttled: !send };

  const detailLines = Object.entries(details)
    .map(([k, v]) => `• ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
  const suffix = suppressed > 0
    ? `\n(${suppressed} similar alert(s) suppressed in the last ${Math.round(THROTTLE_MS / 60000)}m)`
    : "";
  const text = `[${severity.toUpperCase()}] [${ENV_LABEL}] [worker] ${message}`
    + (detailLines ? `\n${detailLines}` : "") + suffix;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return { sent: res.ok, suppressed };
  } catch (err) {
    // Alerting must never break the caller.
    console.error("[alert] delivery failed:", err.message);
    return { sent: false, error: err.message };
  }
}

function clearAlert(key) {
  throttleState.delete(key);
}

module.exports = { sendAlert, clearAlert };
