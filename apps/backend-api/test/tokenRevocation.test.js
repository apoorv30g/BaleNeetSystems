const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_for_revocation_tests";
process.env.AUTH_REVOCATION_CACHE_MS = "0"; // no caching, so each test sees current state

const pool = require("../src/db/pool");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const TENANT_ID = "44444444-4444-4444-8444-444444444444";

// Mutable stand-in for the users row these tests operate on.
let dbUser = { token_version: 0, is_active: true, exists: true };
// middleware/auth.js destructures `query` at import time, so the stub must be installed
// before that require and stay the same function object -- toggling this flag is how we
// simulate an outage rather than reassigning pool.query later (which would have no effect).
let dbUnreachable = false;

pool.query = async (sql, params) => {
  if (dbUnreachable) throw new Error("connection refused");
  if (/SELECT token_version, is_active FROM users/i.test(sql)) {
    if (!dbUser.exists || params[0] !== USER_ID) return { rows: [] };
    return { rows: [{ token_version: dbUser.token_version, is_active: dbUser.is_active }] };
  }
  if (/UPDATE users SET token_version/i.test(sql)) {
    dbUser.token_version += 1;
    return { rows: [{ id: USER_ID, email: "u@example.com" }] };
  }
  return { rows: [] };
};

const { signToken, requireAuth, revokeUserSessions, invalidateUserCache } = require("../src/middleware/auth");

function makeApp() {
  const app = express();
  app.get("/protected", requireAuth, (req, res) => res.json({ ok: true, userId: req.user.userId }));
  app.use((err, req, res, next) => res.status(500).json({ error: "Internal server error" }));
  return app;
}

async function callProtected(token) {
  const app = makeApp();
  const server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/protected`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

test.beforeEach(() => {
  dbUser = { token_version: 0, is_active: true, exists: true };
  invalidateUserCache(USER_ID);
});

function tokenForCurrentState() {
  return signToken({ id: USER_ID, tenant_id: TENANT_ID, role: "operator", email: "u@example.com", token_version: dbUser.token_version });
}

test("a freshly issued token is accepted", async () => {
  const res = await callProtected(tokenForCurrentState());
  assert.equal(res.status, 200);
  assert.equal(res.body.userId, USER_ID);
});

test("revoking sessions immediately invalidates an already-issued token", async () => {
  const token = tokenForCurrentState();
  assert.equal((await callProtected(token)).status, 200, "token should start valid");

  await revokeUserSessions(USER_ID);

  const res = await callProtected(token);
  assert.equal(res.status, 401, "token must stop working after revocation");
  assert.match(res.body.error, /Session expired/i);
});

test("a token issued after revocation works again", async () => {
  await revokeUserSessions(USER_ID);
  const res = await callProtected(tokenForCurrentState());
  assert.equal(res.status, 200);
});

test("deactivating the account blocks an otherwise-valid token", async () => {
  const token = tokenForCurrentState();
  dbUser.is_active = false;
  invalidateUserCache(USER_ID);

  const res = await callProtected(token);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /disabled/i);
});

test("a token for a deleted user is rejected", async () => {
  const token = tokenForCurrentState();
  dbUser.exists = false;
  invalidateUserCache(USER_ID);

  const res = await callProtected(token);
  assert.equal(res.status, 401);
});

test("a token signed with the wrong secret is rejected", async () => {
  const forged = jwt.sign({ userId: USER_ID, tenantId: TENANT_ID, role: "admin", tv: 0 }, "not_the_real_secret");
  const res = await callProtected(forged);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /Invalid token/i);
});

test("a token with no tv claim is rejected once the user has been revoked", async () => {
  // Tokens issued before this feature existed carry no tv claim; treated as generation 0.
  const legacy = jwt.sign(
    { userId: USER_ID, tenantId: TENANT_ID, role: "operator", email: "u@example.com" },
    process.env.JWT_SECRET
  );
  assert.equal((await callProtected(legacy)).status, 200, "legacy token valid before revocation");

  await revokeUserSessions(USER_ID);
  assert.equal((await callProtected(legacy)).status, 401, "legacy token must die on revocation");
});

test("missing token is rejected", async () => {
  const res = await callProtected(null);
  assert.equal(res.status, 401);
});

test("auth fails closed when the database is unreachable", async () => {
  const token = tokenForCurrentState();
  invalidateUserCache(USER_ID);
  dbUnreachable = true;
  try {
    const res = await callProtected(token);
    // Must NOT fall through to allowing the request: we cannot prove the session is valid,
    // and this guards a system holding borrower data.
    assert.equal(res.status, 503);
  } finally {
    dbUnreachable = false;
  }
});
