const express = require("express");
const { asyncRouter } = require("../utils/asyncRouter");
const bcrypt = require("bcryptjs");
const { query } = require("../db/pool");
const { signToken } = require("../middleware/auth");
const { validate, fields } = require("../utils/validate");

// Login validates presence and type only -- NOT password complexity. Enforcing a minimum
// length here would lock out any existing account whose password predates the rule.
// Complexity is enforced where passwords are set (admin user/client creation).
const loginSchema = {
  email: { type: "string", required: true, max: 200 },
  password: { type: "string", required: true, max: 200 }
};

const router = asyncRouter();
const PLATFORM_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "admin@loanconnect.ai").toLowerCase();

// A real bcrypt hash (of a value nobody can log in with) compared against when the email
// does not exist, so a missing user costs the same wall-clock time as a wrong password.
// Without this, "no such user" returns measurably faster and leaks which emails are registered.
const DUMMY_HASH = bcrypt.hashSync("::no-such-user::", 10);

router.post("/login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const result = await query(`SELECT * FROM users WHERE email=$1`, [email]);
  const user = result.rows[0]?.is_active === false ? null : result.rows[0];

  if (!await passwordMatches(user, password)) {
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

router.post("/admin-login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const result = await query(`SELECT * FROM users WHERE email=$1`, [email]);
  const user = result.rows[0]?.is_active === false ? null : result.rows[0];

  if (!await adminPasswordMatches(user, password)) {
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

// bcrypt.compare (async) rather than compareSync -- the correct API, and the only form that
// could yield.
//
// CAVEAT (measured, not assumed): bcryptjs is pure JS and its async API still occupies the
// event loop for the full ~90ms at cost 10, so this does NOT make login non-blocking on its
// own. Since this process also serves the live voicebot WebSocket, each login stalls
// in-flight call audio for roughly that long. Logins are staff-initiated and infrequent, so
// the impact is bounded; eliminating it needs either the native `bcrypt` package (real
// threadpool hashing, adds a native build step) or node:crypto scrypt (changes hash format,
// requires migrating existing hashes). See test/auth.test.js for the pinned budget.
async function passwordMatches(user, password) {
  const hash = user?.password_hash || DUMMY_HASH;
  const matched = await bcrypt.compare(password || "", hash);
  // Even a "successful" compare against DUMMY_HASH must not authenticate anyone.
  return Boolean(user?.password_hash) && matched;
}

function adminPasswordMatches(user, password) {
  // Plaintext ADMIN_PASSWORD env fallback removed — all passwords must be bcrypt-hashed in DB.
  // To reset the platform admin password run: node src/db/seed.js
  return passwordMatches(user, password);
}

module.exports = router;
