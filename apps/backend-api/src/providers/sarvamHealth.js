const WebSocket = require("ws");
const config = require("../config");

let cachedHealth = null;
let cachedAt = 0;
let inFlight = null;

async function getSarvamHealth({ force = false } = {}) {
  const cacheMs = Number(process.env.SARVAM_PREFLIGHT_CACHE_MS || 60000);
  const now = Date.now();
  if (!force && cachedHealth && now - cachedAt < cacheMs) {
    return { ...cachedHealth, cached: true, ageMs: now - cachedAt };
  }

  if (!force && inFlight) return inFlight;

  inFlight = runSarvamHealth()
    .then(result => {
      cachedHealth = result;
      cachedAt = Date.now();
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function assertSarvamHealthyForCall() {
  if (!sarvamPreflightRequired()) {
    return { ok: true, skipped: true, reason: "sarvam_preflight_disabled" };
  }

  const health = await getSarvamHealth({
    force: process.env.SARVAM_PREFLIGHT_FORCE_PER_CALL === "true"
  });
  if (!health.ok) {
    throw new Error(`Sarvam preflight failed: ${summarizeFailedChecks(health.checks)}`);
  }
  return health;
}

function sarvamPreflightRequired() {
  return process.env.CALL_REQUIRE_SARVAM_HEALTH !== "false" && process.env.DRY_RUN_CALLS !== "true";
}

async function runSarvamHealth() {
  const startedAt = Date.now();
  const checks = {
    apiKey: { ok: Boolean(config.ai.sarvamApiKey) }
  };

  if (!config.ai.sarvamApiKey) {
    return {
      ok: false,
      provider: "sarvam",
      required: sarvamPreflightRequired(),
      checks,
      elapsedMs: Date.now() - startedAt
    };
  }

  const probeFns = [];
  if (envEnabled("SARVAM_PREFLIGHT_CHECK_STT", true)) probeFns.push(["stt", checkStt]);
  if (envEnabled("SARVAM_PREFLIGHT_CHECK_CHAT", true)) probeFns.push(["chat", checkChat]);
  if (envEnabled("SARVAM_PREFLIGHT_CHECK_TTS", true)) probeFns.push(["tts", checkTts]);

  const settled = await Promise.allSettled(probeFns.map(([, fn]) => fn()));
  settled.forEach((result, index) => {
    const [name] = probeFns[index];
    checks[name] = result.status === "fulfilled"
      ? result.value
      : { ok: false, error: result.reason?.message || String(result.reason) };
  });

  return {
    ok: Object.values(checks).every(check => check.ok),
    provider: "sarvam",
    required: sarvamPreflightRequired(),
    checks,
    cached: false,
    elapsedMs: Date.now() - startedAt
  };
}

function checkStt() {
  const timeoutMs = Number(process.env.SARVAM_PREFLIGHT_STT_TIMEOUT_MS || process.env.SARVAM_PREFLIGHT_TIMEOUT_MS || 2500);
  const params = sarvamSttParams();

  return new Promise(resolve => {
    let done = false;
    const startedAt = Date.now();
    const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`, {
      headers: { "Api-Subscription-Key": config.ai.sarvamApiKey }
    });

    const timer = setTimeout(() => finish({ ok: false, error: `timeout_${timeoutMs}ms` }), timeoutMs);

    ws.on("open", () => {
      finish({
        ok: true,
        model: process.env.SARVAM_STT_MODEL || "saaras:v3",
        mode: process.env.SARVAM_STT_MODE || "codemix",
        sampleRate: Number(process.env.SARVAM_STT_SAMPLE_RATE || 8000),
        elapsedMs: Date.now() - startedAt
      });
    });

    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", chunk => { body += chunk.toString(); });
      res.on("end", () => finish({
        ok: false,
        statusCode: res.statusCode,
        error: body.slice(0, 500) || `unexpected_response_${res.statusCode}`
      }));
    });

    ws.on("error", err => finish({ ok: false, error: err.message }));
    ws.on("close", (code, reason) => {
      if (!done) finish({ ok: false, code, error: reason?.toString() || `closed_${code}` });
    });

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      resolve(result);
    }
  });
}

async function checkChat() {
  const timeoutMs = Number(process.env.SARVAM_PREFLIGHT_CHAT_TIMEOUT_MS || process.env.SARVAM_PREFLIGHT_TIMEOUT_MS || 2500);
  const startedAt = Date.now();
  const body = {
    model: process.env.SARVAM_CHAT_MODEL || "sarvam-30b",
    messages: [{ role: "user", content: "Reply with OK only." }],
    max_tokens: 4,
    temperature: 0,
    reasoning_effort: null,
    stream: false
  };
  const { ok, status, text, data } = await fetchJsonWithTimeout("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": config.ai.sarvamApiKey
    },
    body: JSON.stringify(body)
  }, timeoutMs);

  const reply = data?.choices?.[0]?.message?.content || "";
  return {
    ok: ok && Boolean(reply),
    status,
    model: body.model,
    elapsedMs: Date.now() - startedAt,
    error: ok ? "" : text.slice(0, 500)
  };
}

async function checkTts() {
  const timeoutMs = Number(process.env.SARVAM_PREFLIGHT_TTS_TIMEOUT_MS || process.env.SARVAM_PREFLIGHT_TIMEOUT_MS || 2500);
  const startedAt = Date.now();
  const body = {
    text: process.env.SARVAM_PREFLIGHT_TTS_TEXT || "Namaste.",
    target_language_code: process.env.SARVAM_TTS_LANGUAGE || "hi-IN",
    speaker: process.env.SARVAM_TTS_SPEAKER || "shubh",
    model: process.env.SARVAM_TTS_MODEL || "bulbul:v3"
  };
  const { ok, status, text, data } = await fetchJsonWithTimeout("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": config.ai.sarvamApiKey
    },
    body: JSON.stringify(body)
  }, timeoutMs);

  const audio = data?.audio || data?.audioContent || data?.data?.audio || (Array.isArray(data?.audios) ? data.audios.join("") : "");
  return {
    ok: ok && Boolean(audio),
    status,
    model: body.model,
    speaker: body.speaker,
    elapsedMs: Date.now() - startedAt,
    audioBytes: audio ? Buffer.byteLength(audio, "base64") : 0,
    error: ok ? "" : text.slice(0, 500)
  };
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, data: parseMaybeJson(text) };
  } catch (err) {
    return { ok: false, status: 0, text: err.message, data: null };
  } finally {
    clearTimeout(timer);
  }
}

function sarvamSttParams() {
  return new URLSearchParams({
    "language-code": process.env.SARVAM_STT_LANGUAGE_CODE || "hi-IN",
    model: process.env.SARVAM_STT_MODEL || "saaras:v3",
    mode: process.env.SARVAM_STT_MODE || "codemix",
    sample_rate: String(process.env.SARVAM_STT_SAMPLE_RATE || 8000),
    input_audio_codec: process.env.SARVAM_STT_AUDIO_ENCODING || "pcm_s16le",
    high_vad_sensitivity: process.env.SARVAM_STT_HIGH_VAD_SENSITIVITY || "true",
    vad_signals: process.env.SARVAM_STT_VAD_SIGNALS || "true"
  });
}

function envEnabled(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return !/^(false|off|0|no)$/i.test(value);
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeFailedChecks(checks = {}) {
  return Object.entries(checks)
    .filter(([, check]) => !check?.ok)
    .map(([name, check]) => `${name}=${check?.error || check?.statusCode || check?.status || "failed"}`)
    .join(", ") || "unknown";
}

module.exports = { assertSarvamHealthyForCall, getSarvamHealth, sarvamPreflightRequired };
