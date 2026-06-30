const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { query, pool } = require("./db/pool");
const { redisClient, callQueue } = require("./queue");
const logger = require("./utils/logger");
const { attachVoicebot } = require("./routes/voicebot");

const app = express();
const server = http.createServer(app);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // API-only; no HTML served
  crossOriginEmbedderPolicy: false
}));

// Correlation ID — attach to every request for end-to-end tracing
app.use((req, res, next) => {
  req.correlationId = req.headers["x-correlation-id"] || crypto.randomUUID();
  res.setHeader("x-correlation-id", req.correlationId);
  next();
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (req.path !== "/health") {
      logger.info("http_request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        correlationId: req.correlationId
      });
    }
  });
  next();
});

// CORS — only allow configured origins; deny all others in production
const allowedOrigins = new Set(config.frontendUrls.map(u => u.toLowerCase()));
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true); // server-to-server / curl
    const lc = origin.toLowerCase();
    const allowed = allowedOrigins.has(lc)
      || config.corsOriginSuffixes.some(suffix => lc.endsWith(suffix));
    if (allowed) return callback(null, true);
    if (config.nodeEnv !== "production") return callback(null, true); // permissive in dev
    callback(new Error(`CORS: origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "x-correlation-id"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Rate limiting — auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
  keyGenerator: req => {
    // Rate-limit per IP + email combination to avoid locking shared IPs
    const email = String(req.body?.email || "").toLowerCase().slice(0, 100);
    return `${req.ip}:${email}`;
  }
});

// General API rate limit — loose ceiling against accidental hammering
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Slow down." }
});

app.get("/health", async (_, res) => {
  const checks = { api: "ok", database: "unknown", redis: "unknown" };
  let ok = true;

  try {
    await query("SELECT 1");
    const poolStats = pool.totalCount !== undefined
      ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
      : null;
    checks.database = "ok";
    if (poolStats) checks.dbPool = poolStats;
  } catch (err) {
    ok = false;
    checks.database = "error";
  }

  try {
    await redisClient.ping();
    const queueCounts = await callQueue.getJobCounts("waiting", "active", "delayed").catch(() => null);
    checks.redis = "ok";
    if (queueCounts) checks.queue = queueCounts;
  } catch (err) {
    ok = false;
    checks.redis = "error";
  }

  res.status(ok ? 200 : 503).json({ ok, service: "loanconnect-backend", checks, ts: new Date().toISOString() });
});

app.use("/auth", authLimiter, require("./routes/auth"));
app.use("/admin", apiLimiter, require("./routes/admin"));
app.use("/campaigns", apiLimiter, require("./routes/campaigns"));
app.use("/playbooks", apiLimiter, require("./routes/playbooks"));
app.use("/analytics", apiLimiter, require("./routes/analytics"));
app.use("/compliance", apiLimiter, require("./routes/compliance"));
app.use("/webhooks", require("./routes/webhooks"));

app.use((err, req, res, next) => {
  const isKnown = err.status && err.status < 500;
  logger.error("request_failed", {
    event: "request_failed",
    path: req.path,
    method: req.method,
    status: err.status || 500,
    correlationId: req.correlationId,
    // Only include err.message for non-5xx; avoids leaking DB internals
    ...(isKnown ? { reason: err.message } : {})
  });
  res.status(err.status || 500).json({ error: isKnown ? err.message : "Internal server error" });
});

attachVoicebot(server);

server.listen(config.port, () => logger.info("backend_started", { port: config.port }));

// Graceful shutdown — drain in-flight HTTP requests and DB connections
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown_initiated", { signal });
  server.close(async () => {
    try {
      await pool.end();
      await redisClient.quit();
      logger.info("shutdown_complete");
    } catch (err) {
      logger.error("shutdown_error", { error: err.message });
    }
    process.exit(0);
  });
  // Force-kill after 30s if connections don't drain
  setTimeout(() => { logger.error("shutdown_timeout"); process.exit(1); }, 30000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
