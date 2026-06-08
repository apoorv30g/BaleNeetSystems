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

const frontendUrls = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || (isProduction ? "https://app.baleneetsystems.in" : "http://localhost:3000"))
  .split(",")
  .map(url => url.trim())
  .filter(Boolean);

const corsOriginSuffixes = (process.env.CORS_ORIGIN_SUFFIXES || ".baleneetsystems.in")
  .split(",")
  .map(suffix => suffix.trim().toLowerCase())
  .filter(Boolean);

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
  loanAppUrl: process.env.LOAN_APP_URL || "https://yourapp.com/apply",
  paymentLinkBase: process.env.PAYMENT_LINK_BASE || "https://yourapp.com/pay",
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
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-flash-latest")
      .split(",")
      .map(model => model.trim())
      .filter(Boolean),
    sarvamApiKey: process.env.SARVAM_API_KEY,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY
  }
};
