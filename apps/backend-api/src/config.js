require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";

function railwayUrl() {
  return process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "";
}

function required(name, fallback = "") {
  const value = process.env[name] || fallback;
  if (isProduction && !value) throw new Error(`${name} is required in production`);
  return value;
}

// Parses a numeric env var, failing fast if the value is not a finite number.
function requiredNum(name, defaultVal) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name}="${raw}" must be a finite number`);
  return n;
}

// Validate all numeric voicebot config at startup so NaN values are caught early.
function validateVoicebotConfig() {
  const numericVars = [
    ["VOICEBOT_INTRO_DELAY_MS", 0],
    ["VOICEBOT_ACK_DELAY_MS", 850],
    ["VOICEBOT_FAST_ACK_DELAY_MS", 850],
    ["VOICEBOT_NO_SPEECH_PROMPT_MS", 3000],
    ["VOICEBOT_NO_SPEECH_END_MS", 3000],
    ["VOICEBOT_MIN_TRANSCRIPT_CONFIDENCE", 0.62],
    ["VOICEBOT_LOW_CONFIDENCE_MAX_WORDS", 3],
    ["VOICEBOT_INTERIM_TRANSCRIPT_DELAY_MS", 1200],
    ["VOICEBOT_INTERIM_TRANSCRIPT_FORCE_MS", 2600],
    ["VOICEBOT_INTERIM_TRANSCRIPT_MIN_WORDS", 2],
    ["VOICEBOT_INTERIM_TRANSCRIPT_MIN_CHARS", 5],
    ["VOICEBOT_BARGE_IN_GRACE_MS", 700],
    ["VOICEBOT_BARGE_IN_MIN_CHUNKS", 3],
    ["VOICEBOT_TTS_PREROLL_MS", 300],
    ["VOICEBOT_TTS_VOLUME", 1.6],
    ["VOICEBOT_PCM_CACHE_MAX", 200],
    ["VOICEBOT_PLAYBACK_MARK_WAIT_MS", 900],
    ["VOICEBOT_SPEECH_QUEUE_STALE_MS", 8000],
    ["EXOTEL_MEDIA_CHUNK_BYTES", 640],
  ];
  for (const [name, def] of numericVars) requiredNum(name, def);
}

const frontendUrls = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || (isProduction ? "https://app.baleneetsystems.in" : "http://localhost:3000"))
  .split(",")
  .map(url => url.trim())
  .filter(Boolean);

const corsOriginSuffixes = (process.env.CORS_ORIGIN_SUFFIXES || ".baleneetsystems.in")
  .split(",")
  .map(suffix => suffix.trim().toLowerCase())
  .filter(Boolean);

// sarvam-m (and its size aliases) is the retired 24B Sarvam chat model. sarvam-30b / sarvam-105b
// are the supported replacements (30b is faster -> better for live-call latency; 105b is higher
// quality). Declared before module.exports so it is initialized when the ai block calls it.
const DEPRECATED_SARVAM_CHAT_MODELS = new Set(["sarvam-m", "sarvam-m:v1", "sarvam-24b", "sarvam-2b"]);
function resolveSarvamChatModel() {
  const requested = String(process.env.SARVAM_CHAT_MODEL || "").trim();
  if (requested && DEPRECATED_SARVAM_CHAT_MODELS.has(requested.toLowerCase())) {
    console.warn(`[config] SARVAM_CHAT_MODEL="${requested}" is a deprecated Sarvam chat model (retired 2026-07-27). ` +
      `Falling back to "sarvam-30b". Please update the env var to sarvam-30b or sarvam-105b.`);
    return "sarvam-30b";
  }
  return requested || "sarvam-30b";
}

module.exports = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: required("DATABASE_URL", isProduction ? "" : "postgresql://postgres:password@localhost:5432/loanconnect"),
  redisUrl: required("REDIS_URL", process.env.REDIS_PRIVATE_URL || (isProduction ? "" : "redis://localhost:6379")),
  jwtSecret: required("JWT_SECRET", isProduction ? "" : "dev_secret_change_me"),
  frontendUrl: frontendUrls[0] || "",
  frontendUrls,
  corsOriginSuffixes,
  serverUrl: required("SERVER_URL", isProduction ? railwayUrl() : "http://localhost:4000"),
  callWindowStart: Number(process.env.CALL_WINDOW_START || 9),
  callWindowEnd: Number(process.env.CALL_WINDOW_END || 20),
  maxCallAttempts: Number(process.env.MAX_CALL_ATTEMPTS || 3),
  retryDelayMinutes: Number(process.env.CALL_RETRY_DELAY_MINUTES || 360),
  maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS || process.env.EXOTEL_CHANNEL_COUNT || 1),
    loanAppUrl: process.env.LOAN_APP_URL || "https://www.asapfinance.in",
    tezCreditUrl: process.env.TEZCREDIT_URL || "https://www.tezcredit.com",
  paymentLinkBase: process.env.PAYMENT_LINK_BASE || "https://yourapp.com/pay",
  brandName: process.env.BRAND_NAME || "ASAP Finance",
  assistantName: process.env.ASSISTANT_NAME || "Sneha",
  supportPhone: process.env.SUPPORT_PHONE || "",
  voicebotToken: process.env.VOICEBOT_TOKEN || "",
  exotel: {
    accountSid: process.env.EXOTEL_ACCOUNT_SID,
    apiKey: process.env.EXOTEL_API_KEY,
    apiToken: process.env.EXOTEL_API_TOKEN,
    fromNumber: process.env.EXOTEL_FROM_NUMBER,
    apiBase: process.env.EXOTEL_API_BASE || "https://api.in.exotel.com",
    channelCount: Number(process.env.EXOTEL_CHANNEL_COUNT || process.env.MAX_CONCURRENT_CALLS || 1)
  },
  // Sarvam is the ONLY permitted AI provider. Gemini (LLM) and Deepgram (STT) were removed
  // for India data-residency compliance: borrower audio and transcripts must not leave
  // Indian jurisdiction. Do not add a non-Indian provider here without a compliance review.
  ai: {
    sarvamApiKey: process.env.SARVAM_API_KEY,
    // Centralized Sarvam model names. The /chat/completions, /text-to-speech and STT endpoints
    // themselves are current; only the legacy sarvam-m (24B) CHAT model is being retired
    // (Sarvam end-of-life 2026-07-27). resolveSarvamChatModel() auto-upgrades a deprecated value
    // to the recommended replacement and warns, so a stale env var degrades gracefully instead
    // of failing calls. TTS (bulbul) and STT (saaras) are unaffected.
    sarvamChatModel: resolveSarvamChatModel(),
    sarvamTtsModel: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
    sarvamSttModel: process.env.SARVAM_STT_MODEL || "saaras:v3"
  }
};

// Run at import time so misconfigured numeric vars fail the process immediately.
try {
  validateVoicebotConfig();
} catch (err) {
  console.error("[config] Invalid env var:", err.message);
  process.exit(1);
}
