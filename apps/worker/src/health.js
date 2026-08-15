const config = require("./config");
const { sendAlert, clearAlert } = require("./alerts");

// Sarvam is now the only AI provider (Deepgram/Gemini were removed for data residency), so a
// sustained preflight failure means no call can succeed. Track consecutive failures and alert
// once the run looks like an outage rather than a blip.
const PREFLIGHT_ALERT_THRESHOLD = Number(process.env.SARVAM_PREFLIGHT_ALERT_THRESHOLD || 3);
let consecutivePreflightFailures = 0;

async function assertSarvamReadyForCall() {
  if (!config.requireSarvamHealth || config.dryRunCalls) {
    return { ok: true, skipped: true, reason: "sarvam_preflight_disabled" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sarvamPreflightTimeoutMs);
  try {
    const url = new URL(config.sarvamPreflightUrl);
    url.searchParams.set("source", "worker");
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    const body = parseMaybeJson(text);

    if (!res.ok || !body?.ok) {
      throw new Error(summarizePreflightFailure(body, text, res.status));
    }

    if (consecutivePreflightFailures >= PREFLIGHT_ALERT_THRESHOLD) {
      await sendAlert(
        "sarvam_preflight_recovered",
        `Sarvam preflight recovered after ${consecutivePreflightFailures} consecutive failures. Call dispatch resuming.`,
        { consecutiveFailures: consecutivePreflightFailures },
        "info"
      );
    }
    consecutivePreflightFailures = 0;
    clearAlert("sarvam_preflight_failing");
    return body;
  } catch (err) {
    consecutivePreflightFailures += 1;
    if (consecutivePreflightFailures >= PREFLIGHT_ALERT_THRESHOLD) {
      await sendAlert(
        "sarvam_preflight_failing",
        `Sarvam preflight has failed ${consecutivePreflightFailures} times in a row — no outbound calls are being placed. Sarvam is the only AI provider, so there is no failover.`,
        { consecutiveFailures: consecutivePreflightFailures, lastError: String(err.message).slice(0, 300) },
        "critical"
      );
    }
    throw new Error(`Sarvam preflight failed before Exotel call: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function preflightFailureCount() {
  return consecutivePreflightFailures;
}

function summarizePreflightFailure(body, text, status) {
  if (!body || typeof body !== "object") return `HTTP ${status}: ${String(text || "").slice(0, 300)}`;
  const failed = Object.entries(body.checks || {})
    .filter(([, check]) => !check?.ok)
    .map(([name, check]) => `${name}=${check?.error || check?.status || check?.statusCode || "failed"}`)
    .join(", ");
  return failed || `HTTP ${status}`;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { assertSarvamReadyForCall, preflightFailureCount };
