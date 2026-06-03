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

module.exports = {
  databaseUrl: required("DATABASE_URL", isProduction ? "" : "postgresql://postgres:password@localhost:5432/loanconnect"),
  redisUrl: required("REDIS_URL", process.env.REDIS_PRIVATE_URL || (isProduction ? "" : "redis://localhost:6379")),
  maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS || 20),
  callWindowStart: Number(process.env.CALL_WINDOW_START || 9),
  callWindowEnd: Number(process.env.CALL_WINDOW_END || 20),
  callWindowTimeZone: process.env.CALL_WINDOW_TIME_ZONE || "Asia/Kolkata",
  maxCallAttempts: Number(process.env.MAX_CALL_ATTEMPTS || 3),
  callDispatchEnabled: process.env.CALL_DISPATCH_ENABLED === "true",
  dryRunCalls: process.env.DRY_RUN_CALLS === "true",
  serverUrl: required("SERVER_URL", isProduction ? railwayUrl() : "http://localhost:4000"),
  exotel: {
    accountSid: process.env.EXOTEL_ACCOUNT_SID,
    apiKey: process.env.EXOTEL_API_KEY,
    apiToken: process.env.EXOTEL_API_TOKEN,
    fromNumber: process.env.EXOTEL_FROM_NUMBER,
    apiBase: process.env.EXOTEL_API_BASE || "https://api.in.exotel.com",
    flowUrl: process.env.EXOTEL_FLOW_URL || "",
    outboundMode: process.env.EXOTEL_OUTBOUND_MODE || (process.env.EXOTEL_FLOW_URL ? "flow" : "direct"),
    ringTimeoutSeconds: Number(process.env.EXOTEL_RING_TIMEOUT_SECONDS || 45),
    timeLimitSeconds: Number(process.env.EXOTEL_TIME_LIMIT_SECONDS || 600),
    callType: process.env.EXOTEL_CALL_TYPE || ""
  }
};
