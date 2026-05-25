require("dotenv").config();

module.exports = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  jwtSecret: process.env.JWT_SECRET || "dev_secret_change_me",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  serverUrl: process.env.SERVER_URL || "http://localhost:4000",
  callWindowStart: Number(process.env.CALL_WINDOW_START || 9),
  callWindowEnd: Number(process.env.CALL_WINDOW_END || 20),
  maxCallAttempts: Number(process.env.MAX_CALL_ATTEMPTS || 3),
  retryDelayMinutes: Number(process.env.CALL_RETRY_DELAY_MINUTES || 360),
  loanAppUrl: process.env.LOAN_APP_URL || "https://yourapp.com/apply",
  paymentLinkBase: process.env.PAYMENT_LINK_BASE || "https://yourapp.com/pay",
  supportPhone: process.env.SUPPORT_PHONE || "",
  exotel: {
    accountSid: process.env.EXOTEL_ACCOUNT_SID,
    apiKey: process.env.EXOTEL_API_KEY,
    apiToken: process.env.EXOTEL_API_TOKEN,
    fromNumber: process.env.EXOTEL_FROM_NUMBER,
    apiBase: process.env.EXOTEL_API_BASE || "https://api.in.exotel.com"
  },
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY,
    sarvamApiKey: process.env.SARVAM_API_KEY,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY
  }
};
