const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcryptjs");

// Integration tests against a REAL Postgres.
//
// These are the tests that unit tests structurally cannot replace: cross-tenant isolation is
// a property of the SQL, not of any pure function, so it can only be proven by running the
// queries. A regression here leaks one lender's borrowers to another.
//
// They SKIP (not fail) when no database is reachable, so `npm test` still works on a laptop
// without Docker. CI provides one via a service container.
//
// The schema must already exist -- run migrations first. (src/db/migrate.js is a script: it
// executes on import and calls pool.end(), so it cannot be required from inside a test.)
//
//   Local:  docker compose up -d postgres
//           DATABASE_URL=postgresql://postgres:password@localhost:5432/loanconnect npm run migrate
//           TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/loanconnect npm test

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "";

if (!TEST_DATABASE_URL) {
  test("tenant isolation integration tests", { skip: "TEST_DATABASE_URL not set" }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "integration_test_secret";
  process.env.AUTH_REVOCATION_CACHE_MS = "0";
  process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
  process.env.SERVER_URL = process.env.SERVER_URL || "http://localhost:4000";

  const { query, pool } = require("../../src/db/pool");
  const authRouter = require("../../src/routes/auth");
  const campaignsRouter = require("../../src/routes/campaigns");
  const analyticsRouter = require("../../src/routes/analytics");

  // Distinct, recognisable values so a leak is obvious in a failure message.
  const A = { email: "isolation-a@test.invalid", password: "tenant-a-password", tenantName: "Isolation Tenant A" };
  const B = { email: "isolation-b@test.invalid", password: "tenant-b-password", tenantName: "Isolation Tenant B" };

  let server;
  let baseUrl;
  let dbAvailable = false;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/auth", authRouter);
    app.use("/campaigns", campaignsRouter);
    app.use("/analytics", analyticsRouter);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: "Internal server error" }));
    return app;
  }

  async function api(path, { token, method = "GET", body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  async function seedTenant(spec) {
    const tenant = await query(
      `INSERT INTO tenants (name, plan_type) VALUES ($1,'starter') RETURNING id`,
      [spec.tenantName]
    );
    const tenantId = tenant.rows[0].id;

    await query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenantId]);

    const user = await query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,'operator') RETURNING id`,
      [tenantId, spec.tenantName, spec.email, bcrypt.hashSync(spec.password, 10)]
    );

    const campaign = await query(
      `INSERT INTO campaigns (tenant_id, name, campaign_type, playbook_type, status)
       VALUES ($1,$2,'RETARGETING','UNAPPROVED_USERS','active') RETURNING id`,
      [tenantId, `${spec.tenantName} Campaign`]
    );
    const campaignId = campaign.rows[0].id;

    const lead = await query(
      `INSERT INTO leads (tenant_id, campaign_id, name, phone, playbook_type, status)
       VALUES ($1,$2,$3,$4,'UNAPPROVED_USERS','pending') RETURNING id`,
      [tenantId, campaignId, `${spec.tenantName} Borrower`, `9${Math.floor(100000000 + Math.random() * 899999999)}`]
    );

    await query(
      `INSERT INTO calls (tenant_id, campaign_id, lead_id, status, outcome)
       VALUES ($1,$2,$3,'completed','INTERESTED')`,
      [tenantId, campaignId, lead.rows[0].id]
    );

    return { tenantId, userId: user.rows[0].id, campaignId, leadId: lead.rows[0].id };
  }

  async function cleanup() {
    // Tenants cascade to campaigns/leads/calls/users.
    await query(`DELETE FROM tenants WHERE name IN ($1,$2)`, [A.tenantName, B.tenantName]).catch(() => {});
    await query(`DELETE FROM users WHERE email IN ($1,$2)`, [A.email, B.email]).catch(() => {});
  }

  test.before(async () => {
    try {
      await query("SELECT 1");
      // Confirm the schema exists rather than failing later with a confusing SQL error.
      await query("SELECT 1 FROM tenants LIMIT 1");
      dbAvailable = true;
    } catch (err) {
      throw new Error(
        `[integration] database not ready (${err.message}). `
        + `TEST_DATABASE_URL is set, so these tests fail rather than silently pass. `
        + `Run migrations first: DATABASE_URL=<url> npm run migrate`
      );
    }

    await cleanup();

    A.seed = await seedTenant(A);
    B.seed = await seedTenant(B);

    server = buildApp().listen(0);
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    A.token = (await api("/auth/login", { method: "POST", body: { email: A.email, password: A.password } })).body.token;
    B.token = (await api("/auth/login", { method: "POST", body: { email: B.email, password: B.password } })).body.token;
  });

  test.after(async () => {
    if (server) server.close();
    if (dbAvailable) await cleanup();
    await pool.end().catch(() => {});
  });

  test("both tenants can log in and receive scoped tokens", () => {
    assert.ok(A.token, "tenant A should have a token");
    assert.ok(B.token, "tenant B should have a token");
    assert.notEqual(A.token, B.token);
  });

  test("a tenant sees only its own campaigns", async () => {
    const res = await api("/campaigns", { token: A.token });
    assert.equal(res.status, 200);
    const names = res.body.map(c => c.name);
    assert.ok(names.includes(`${A.tenantName} Campaign`), "own campaign should be visible");
    assert.ok(
      !names.includes(`${B.tenantName} Campaign`),
      `LEAK: tenant A can see tenant B's campaign. Got: ${JSON.stringify(names)}`
    );
  });

  test("a tenant cannot read another tenant's campaign by id", async () => {
    const res = await api(`/campaigns/${B.seed.campaignId}`, { token: A.token });
    assert.ok(
      res.status === 404 || res.status === 403,
      `LEAK: expected 404/403 reading another tenant's campaign, got ${res.status}`
    );
  });

  test("a tenant cannot list another tenant's leads", async () => {
    const res = await api(`/campaigns/${B.seed.campaignId}/leads`, { token: A.token });
    if (res.status === 200) {
      const leads = Array.isArray(res.body) ? res.body : res.body?.leads || [];
      assert.equal(leads.length, 0, `LEAK: tenant A retrieved ${leads.length} of tenant B's leads`);
    } else {
      assert.ok(res.status === 404 || res.status === 403, `unexpected status ${res.status}`);
    }
  });

  test("a tenant cannot export another tenant's call records", async () => {
    const res = await api(`/campaigns/${B.seed.campaignId}/export/calls`, { token: A.token });
    if (res.status === 200) {
      const csv = String(res.body);
      assert.ok(
        !csv.includes(`${B.tenantName} Borrower`),
        "LEAK: tenant A exported tenant B's borrower data"
      );
    }
  });

  test("a tenant cannot delete another tenant's campaign", async () => {
    const res = await api(`/campaigns/${B.seed.campaignId}`, { token: A.token, method: "DELETE" });
    // Whatever the status, B's campaign must still exist.
    const still = await query(`SELECT id FROM campaigns WHERE id=$1`, [B.seed.campaignId]);
    assert.equal(still.rows.length, 1, "LEAK: tenant A deleted tenant B's campaign");
  });

  test("analytics totals count only the caller's tenant", async () => {
    const res = await api("/analytics/summary", { token: A.token });
    assert.equal(res.status, 200);
    const summary = res.body.summary || res.body;
    // Each tenant was seeded with exactly one call.
    assert.ok(
      Number(summary.total_calls) <= 1,
      `LEAK: analytics returned ${summary.total_calls} calls; tenant A should see at most its own 1`
    );
  });

  test("requests without a token are rejected", async () => {
    const res = await api("/campaigns");
    assert.equal(res.status, 401);
  });

  test("a token signed with the wrong secret is rejected", async () => {
    const jwt = require("jsonwebtoken");
    const forged = jwt.sign(
      { userId: A.seed.userId, tenantId: B.seed.tenantId, role: "admin", tv: 0 },
      "wrong_secret"
    );
    const res = await api("/campaigns", { token: forged });
    assert.equal(res.status, 401, "LEAK: a forged token was accepted");
  });

  test("revoking sessions in the database invalidates a live token", async () => {
    const throwaway = (await api("/auth/login", {
      method: "POST",
      body: { email: A.email, password: A.password }
    })).body.token;

    assert.equal((await api("/campaigns", { token: throwaway })).status, 200);

    await query(`UPDATE users SET token_version = token_version + 1 WHERE id=$1`, [A.seed.userId]);

    const after = await api("/campaigns", { token: throwaway });
    assert.equal(after.status, 401, "token should stop working once sessions are revoked");

    // Restore so later tests (and A.token) keep working.
    await query(`UPDATE users SET token_version = token_version - 1 WHERE id=$1`, [A.seed.userId]);
  });
}
