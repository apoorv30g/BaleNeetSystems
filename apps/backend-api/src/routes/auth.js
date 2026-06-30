const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db/pool");
const { signToken } = require("../middleware/auth");

const router = express.Router();
const PLATFORM_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "admin@loanconnect.ai").toLowerCase();

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await query(`SELECT * FROM users WHERE email=$1`, [email]);
  const user = result.rows[0];

  if (!user || !passwordMatches(user, password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (user.role === "platform_admin" || user.email.toLowerCase() === PLATFORM_ADMIN_EMAIL) {
    return res.status(403).json({ error: "Use admin login for platform admin access" });
  }

  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenant_id }
  });
});

router.post("/admin-login", async (req, res) => {
  const { email, password } = req.body;
  const result = await query(`SELECT * FROM users WHERE email=$1`, [email]);
  const user = result.rows[0];

  if (!user || !adminPasswordMatches(user, password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!["platform_admin", "admin"].includes(user.role)) {
    return res.status(403).json({ error: "Admin access required" });
  }

  const authUser = {
    ...user,
    role: user.role === "platform_admin" || user.email.toLowerCase() === PLATFORM_ADMIN_EMAIL
      ? "platform_admin"
      : user.role
  };

  res.json({
    token: signToken(authUser),
    user: { id: authUser.id, name: authUser.name, email: authUser.email, role: authUser.role, tenantId: authUser.tenant_id }
  });
});

function passwordMatches(user, password) {
  return Boolean(user?.password_hash && bcrypt.compareSync(password || "", user.password_hash));
}

function adminPasswordMatches(user, password) {
  // Plaintext ADMIN_PASSWORD env fallback removed — all passwords must be bcrypt-hashed in DB.
  // To reset the platform admin password run: node src/db/seed.js
  return passwordMatches(user, password);
}

module.exports = router;
