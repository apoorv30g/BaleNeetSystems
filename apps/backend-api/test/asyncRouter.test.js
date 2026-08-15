const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { asyncRouter, wrapHandler } = require("../src/utils/asyncRouter");

// Boots a throwaway server on an ephemeral port and issues one request.
async function request(app, path, { timeoutMs = 2000 } = {}) {
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const port = server.address().port;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

function appWith(router) {
  const app = express();
  app.use(router);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: "handled", reason: err.message });
  });
  return app;
}

// Note: the bug this guards against is that a PLAIN express.Router leaves an async
// rejection unhandled -- the request then hangs with no response at all. That failure is
// not asserted here because node:test intercepts the unhandled rejection itself and fails
// the run regardless. The tests below assert the fixed behaviour instead.

test("asyncRouter forwards async rejections to the error middleware", async () => {
  const router = asyncRouter();
  router.get("/boom", async () => {
    throw new Error("async failure");
  });

  const res = await request(appWith(router), "/boom");
  assert.equal(res.status, 500);
  assert.match(res.body, /handled/);
  assert.match(res.body, /async failure/);
});

test("asyncRouter still serves successful async routes normally", async () => {
  const router = asyncRouter();
  router.get("/ok", async (req, res) => {
    await new Promise(r => setTimeout(r, 5));
    res.json({ ok: true });
  });

  const res = await request(appWith(router), "/ok");
  assert.equal(res.status, 200);
  assert.match(res.body, /"ok":true/);
});

test("asyncRouter forwards rejections from async middleware too", async () => {
  const router = asyncRouter();
  router.use(async () => {
    throw new Error("middleware failure");
  });
  router.get("/never", (req, res) => res.json({ reached: true }));

  const res = await request(appWith(router), "/never");
  assert.equal(res.status, 500);
  assert.match(res.body, /middleware failure/);
});

test("synchronous throws still reach the error middleware", async () => {
  const router = asyncRouter();
  router.get("/sync-boom", () => {
    throw new Error("sync failure");
  });

  const res = await request(appWith(router), "/sync-boom");
  assert.equal(res.status, 500);
  assert.match(res.body, /sync failure/);
});

test("wrapHandler preserves arity-4 error handlers", () => {
  const errorHandler = (err, req, res, next) => next(err);
  const wrapped = wrapHandler(errorHandler);
  // Express identifies error middleware by arity; losing this silently breaks error handling.
  assert.equal(wrapped.length, 4, "error-handling middleware must keep 4 arguments");

  const normal = (req, res, next) => next();
  assert.equal(wrapHandler(normal).length, 3);
});

test("wrapHandler leaves non-functions and sub-routers untouched", () => {
  assert.equal(wrapHandler("/some/path"), "/some/path");
  const subRouter = express.Router();
  assert.equal(wrapHandler(subRouter), subRouter, "routers must not be wrapped or mounting breaks");
});

test("async error handler mounted on asyncRouter still receives errors", async () => {
  const router = asyncRouter();
  router.get("/boom", async () => {
    throw new Error("original");
  });
  router.use(async (err, req, res, next) => {
    res.status(418).json({ caught: err.message });
  });

  const app = express();
  app.use(router);
  const res = await request(app, "/boom");
  assert.equal(res.status, 418);
  assert.match(res.body, /original/);
});
