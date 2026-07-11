const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { query } = require("../db/pool");

const TRAINING_SCOPE = "voice_training";
const JWT_EXPIRY = process.env.TRAINING_PORTAL_JWT_EXPIRY || "8h";
let cachedTenantId = "";

async function verifyTrainingPortalCredentials(email, password) {
  const configuredEmail = String(process.env.TRAINING_PORTAL_EMAIL || "").trim().toLowerCase();
  const configuredPassword = process.env.TRAINING_PORTAL_PASSWORD || "";
  const configuredHash = process.env.TRAINING_PORTAL_PASSWORD_HASH || "";

  if (!configuredEmail || (!configuredPassword && !configuredHash)) {
    const err = new Error("Training portal credentials are not configured");
    err.status = 503;
    throw err;
  }

  if (String(email || "").trim().toLowerCase() !== configuredEmail) return null;
  const passwordText = String(password || "");
  const matches = configuredHash
    ? bcrypt.compareSync(passwordText, configuredHash)
    : passwordText === configuredPassword;
  if (!matches) return null;

  const tenantId = await resolveTrainingTenantId();
  return {
    id: "training-portal",
    email: configuredEmail,
    name: process.env.TRAINING_PORTAL_NAME || "Training Portal",
    role: "training_portal",
    tenant_id: tenantId
  };
}

function signTrainingToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      tenantId: user.tenant_id,
      role: "training_portal",
      email: user.email,
      scope: TRAINING_SCOPE
    },
    config.jwtSecret,
    { expiresIn: JWT_EXPIRY }
  );
}

function requireTrainingAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Training portal login required" });

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.role !== "training_portal" || payload.scope !== TRAINING_SCOPE || !payload.tenantId) {
      return res.status(403).json({ error: "Training portal access required" });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid training portal token" });
  }
}

async function resolveTrainingTenantId() {
  if (process.env.TRAINING_PORTAL_TENANT_ID) return process.env.TRAINING_PORTAL_TENANT_ID;
  if (cachedTenantId) return cachedTenantId;

  const result = await query(`SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1`);
  const tenantId = result.rows[0]?.id;
  if (!tenantId) {
    const err = new Error("No tenant exists for training portal data");
    err.status = 503;
    throw err;
  }
  cachedTenantId = tenantId;
  return tenantId;
}

module.exports = {
  requireTrainingAuth,
  signTrainingToken,
  verifyTrainingPortalCredentials
};
