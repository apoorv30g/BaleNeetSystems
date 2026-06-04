const config = require("./config");

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

    return body;
  } catch (err) {
    throw new Error(`Sarvam preflight failed before Exotel call: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
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

module.exports = { assertSarvamReadyForCall };
