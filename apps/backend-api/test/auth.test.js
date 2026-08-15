const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcryptjs");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_for_auth_tests";

const pool = require("../src/db/pool");

const REAL_PASSWORD = "correct horse battery staple";
const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  name: "Test Operator",
  email: "operator@example.com",
  role: "operator",
  password_hash: bcrypt.hashSync(REAL_PASSWORD, 10)
};

// Stub the DB so these tests need no Postgres, matching the suite's pure-unit style.
pool.query = async (_sql, params) => {
  const email = params?.[0];
  return { rows: email === USER.email ? [{ ...USER }] : [] };
};

const authRouter = require("../src/routes/auth");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: "Internal server error" }));
  return app;
}

async function login(body) {
  const app = makeApp();
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const startedAt = process.hrtime.bigint();
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { status: res.status, body: await res.json(), elapsedMs };
  } finally {
    server.close();
  }
}

test("valid credentials return a token", async () => {
  const res = await login({ email: USER.email, password: REAL_PASSWORD });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, "expected a JWT");
  assert.equal(res.body.user.email, USER.email);
  assert.equal(res.body.user.tenantId, USER.tenant_id);
  assert.ok(!("password_hash" in res.body.user), "password hash must never be returned");
});

test("wrong password is rejected", async () => {
  const res = await login({ email: USER.email, password: "wrong" });
  assert.equal(res.status, 401);
  assert.ok(!res.body.token);
});

test("unknown email is rejected and cannot authenticate via the dummy hash", async () => {
  const res = await login({ email: "nobody@example.com", password: "anything" });
  assert.equal(res.status, 401);
  assert.ok(!res.body.token);

  // The dummy hash's own plaintext must not become a backdoor for unknown users.
  const backdoor = await login({ email: "nobody@example.com", password: "::no-such-user::" });
  assert.equal(backdoor.status, 401, "dummy-hash plaintext must never authenticate");
  assert.ok(!backdoor.body.token);
});

test("missing password is rejected as a malformed request", async () => {
  // 400, not 401: an absent field is a malformed request, and schema validation now rejects
  // it before the handler. This leaks nothing extra — it is identical whether or not the
  // email exists, so account enumeration is still not possible through this path.
  const res = await login({ email: USER.email });
  assert.equal(res.status, 400);
  assert.ok(!res.body.token);

  const unknownEmail = await login({ email: "nobody@example.com" });
  assert.equal(unknownEmail.status, 400, "must not differ by whether the account exists");
});

test("unknown email costs comparable time to a wrong password (no user enumeration)", async () => {
  // Warm up so first-call JIT/connect costs don't skew the comparison.
  await login({ email: USER.email, password: "warmup" });
  await login({ email: "nobody@example.com", password: "warmup" });

  const wrongPassword = await login({ email: USER.email, password: "wrong" });
  const unknownEmail = await login({ email: "nobody@example.com", password: "wrong" });

  // Both paths run one bcrypt compare, so neither should be dramatically faster.
  // Generous bound: this catches "no bcrypt ran at all" (which was ~100x faster), not jitter.
  const ratio = Math.max(wrongPassword.elapsedMs, unknownEmail.elapsedMs)
    / Math.max(1, Math.min(wrongPassword.elapsedMs, unknownEmail.elapsedMs));
  assert.ok(
    ratio < 10,
    `timing gap too large (${wrongPassword.elapsedMs.toFixed(1)}ms vs ${unknownEmail.elapsedMs.toFixed(1)}ms) — unknown emails may be enumerable`
  );
});

// KNOWN LIMITATION — bcryptjs is a pure-JS implementation whose "async" API still occupies
// the event loop for the full hash duration (~90ms at cost 10); measured, not assumed.
// Using bcrypt.compare() instead of compareSync() is still the correct API (it is the only
// form that COULD yield, and costs nothing), but it does not by itself make hashing
// non-blocking. Because this process also serves the live voicebot WebSocket, each login
// stalls in-flight call audio for roughly that long.
//
// Impact is bounded: logins are staff-initiated and infrequent, not per-call. Eliminating it
// entirely requires either the native `bcrypt` package (libuv threadpool, real off-thread
// hashing, but adds a native build step to the Docker image) or migrating to node:crypto
// scrypt/pbkdf2 (async via threadpool, but changes the stored hash format).
//
// This test pins the current cost so a regression (e.g. raising the bcrypt cost factor)
// is visible rather than silent.
test("password hashing cost stays within the known blocking budget", async () => {
  let worstGapMs = 0;
  let last = process.hrtime.bigint();
  const ticker = setInterval(() => {
    const now = process.hrtime.bigint();
    worstGapMs = Math.max(worstGapMs, Number(now - last) / 1e6);
    last = now;
  }, 5);

  try {
    await login({ email: USER.email, password: REAL_PASSWORD });
  } finally {
    clearInterval(ticker);
  }

  assert.ok(
    worstGapMs < 250,
    `login occupied the event loop for ${worstGapMs.toFixed(1)}ms — well beyond the ~90ms `
      + `bcryptjs baseline. Live call audio stalls for this long on every login.`
  );
});
