const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { validate, validateBody, fields } = require("../src/utils/validate");

test("accepts a valid body", () => {
  const result = validateBody({ email: "a@b.com", password: "longenough1" }, {
    email: fields.email,
    password: fields.password
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("reports every problem at once, not just the first", () => {
  const result = validateBody({ email: "not-an-email", password: "short" }, {
    email: fields.email,
    password: fields.password
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 2, `expected both fields reported, got: ${result.errors.join(" | ")}`);
});

test("required fields are enforced, optional absent fields are not", () => {
  const schema = { email: fields.email, name: fields.name };
  const missing = validateBody({}, schema);
  assert.equal(missing.valid, false);
  assert.match(missing.errors[0], /email is required/);

  const optionalAbsent = validateBody({ email: "a@b.com" }, schema);
  assert.equal(optionalAbsent.valid, true, "an absent optional field must not be an error");
});

test("empty string counts as missing for a required field", () => {
  const result = validateBody({ email: "   " }, { email: fields.email });
  assert.equal(result.valid, false);
});

test("numeric bounds and integer-ness are enforced", () => {
  const schema = { dailyLimit: { type: "number", integer: true, min: 1, max: 100 } };
  assert.equal(validateBody({ dailyLimit: 50 }, schema).valid, true);
  assert.equal(validateBody({ dailyLimit: "50" }, schema).valid, true, "numeric strings are coerced");
  assert.equal(validateBody({ dailyLimit: 0 }, schema).valid, false);
  assert.equal(validateBody({ dailyLimit: 101 }, schema).valid, false);
  assert.equal(validateBody({ dailyLimit: 1.5 }, schema).valid, false);
  assert.equal(validateBody({ dailyLimit: "abc" }, schema).valid, false);
});

test("oneOf restricts to the allowed set", () => {
  const schema = { role: { type: "string", oneOf: ["admin", "operator"] } };
  assert.equal(validateBody({ role: "operator" }, schema).valid, true);
  assert.equal(validateBody({ role: "superuser" }, schema).valid, false);
});

test("a non-object body does not crash the validator", () => {
  assert.equal(validateBody(null, { email: fields.email }).valid, false);
  assert.equal(validateBody("a string", { email: fields.email }).valid, false);
  assert.equal(validateBody(undefined, { email: fields.email }).valid, false);
});

test("middleware returns 400 with the error list and does not reach the handler", async () => {
  const app = express();
  app.use(express.json());
  let handlerReached = false;
  app.post("/thing", validate({ email: fields.email }), (req, res) => {
    handlerReached = true;
    res.json({ ok: true });
  });

  const server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/thing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nope" })
    });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.error, "Invalid request");
    assert.ok(Array.isArray(body.details) && body.details.length > 0);
    assert.equal(handlerReached, false, "handler must not run on invalid input");

    const good = await fetch(`http://127.0.0.1:${port}/thing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "real@example.com" })
    });
    assert.equal(good.status, 200);
    assert.equal(handlerReached, true);
  } finally {
    server.close();
  }
});

test("login schema does NOT enforce password complexity", () => {
  // Enforcing a minimum length at login would lock out accounts created before the rule.
  const loginSchema = {
    email: { type: "string", required: true, max: 200 },
    password: { type: "string", required: true, max: 200 }
  };
  assert.equal(
    validateBody({ email: "old@user.com", password: "short" }, loginSchema).valid,
    true,
    "an existing short password must still be able to authenticate"
  );
});
