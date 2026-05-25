const http = require("http");
const express = require("express");
const cors = require("cors");
const config = require("./config");
const { query } = require("./db/pool");
const { redisClient } = require("./queue");
const logger = require("./utils/logger");
const { attachVoicebot } = require("./routes/voicebot");

const app = express();
const server = http.createServer(app);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (config.frontendUrls.includes(origin)) return true;

  try {
    const host = new URL(origin).hostname.toLowerCase();
    return config.corsOriginSuffixes.some(suffix => host === suffix.replace(/^\./, "") || host.endsWith(suffix));
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", async (_, res) => {
  const checks = { api: "ok", database: "unknown", redis: "unknown" };
  let ok = true;

  try {
    await query("SELECT 1");
    checks.database = "ok";
  } catch (err) {
    ok = false;
    checks.database = err.message;
  }

  try {
    await redisClient.ping();
    checks.redis = "ok";
  } catch (err) {
    ok = false;
    checks.redis = err.message;
  }

  res.status(ok ? 200 : 503).json({ ok, service: "loanconnect-backend", checks, ts: new Date().toISOString() });
});

app.use("/auth", require("./routes/auth"));
app.use("/campaigns", require("./routes/campaigns"));
app.use("/analytics", require("./routes/analytics"));
app.use("/compliance", require("./routes/compliance"));
app.use("/webhooks", require("./routes/webhooks"));

app.use((err, req, res, next) => {
  logger.error("request_failed", { error: err.message, path: req.path });
  res.status(500).json({ error: "Internal server error" });
});

attachVoicebot(server);

server.listen(config.port, () => logger.info("backend_started", { port: config.port }));
