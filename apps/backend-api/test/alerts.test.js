const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

// Point alerts at a local sink before the module reads the env at import time.
let received = [];
const sink = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    received.push(JSON.parse(body));
    res.writeHead(200).end("ok");
  });
});
// listen() synchronously on an ephemeral port. Top-level await would make Node reparse this
// CommonJS file as an ES module (require + top-level await is ambiguous), so avoid it.
sink.listen(0);
const sinkPort = sink.address().port;
process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${sinkPort}/hook`;
process.env.ALERT_THROTTLE_MS = "10000";
process.env.ALERT_ENV_LABEL = "test";

const { sendAlert, clearAlert, alertsConfigured, _test } = require("../src/services/alerts");

test.beforeEach(() => {
  received = [];
  _test.throttleState.clear();
});

test.after(() => sink.close());

test("alerting reports as configured when a webhook is set", () => {
  assert.equal(alertsConfigured(), true);
});

test("an alert is delivered to the webhook with severity and environment", async () => {
  const result = await sendAlert("test_key", "Something broke", { count: 3 }, "critical");
  assert.equal(result.sent, true);
  assert.equal(received.length, 1);
  assert.match(received[0].text, /CRITICAL/);
  assert.match(received[0].text, /\[test\]/);
  assert.match(received[0].text, /Something broke/);
  assert.match(received[0].text, /count: 3/);
});

test("repeat alerts for the same key are throttled", async () => {
  await sendAlert("dup_key", "First");
  await sendAlert("dup_key", "Second");
  await sendAlert("dup_key", "Third");

  assert.equal(received.length, 1, "only the first alert should be delivered inside the window");
});

test("different keys are throttled independently", async () => {
  await sendAlert("key_a", "A");
  await sendAlert("key_b", "B");
  assert.equal(received.length, 2);
});

test("clearAlert lets the next occurrence through immediately", async () => {
  await sendAlert("recoverable", "down");
  assert.equal(received.length, 1);

  await sendAlert("recoverable", "still down");
  assert.equal(received.length, 1, "throttled as expected");

  clearAlert("recoverable");
  await sendAlert("recoverable", "down again");
  assert.equal(received.length, 2, "after recovery, a new outage must alert immediately");
});

test("suppressed count is reported when the window reopens", async () => {
  const now = Date.now();
  // First send opens the window.
  assert.equal(_test.shouldSend("windowed", now).send, true);
  // Two more inside the window are suppressed.
  assert.equal(_test.shouldSend("windowed", now + 100).send, false);
  assert.equal(_test.shouldSend("windowed", now + 200).send, false);
  // Once the window elapses, the next send reports how many were swallowed.
  const reopened = _test.shouldSend("windowed", now + _test.THROTTLE_MS + 1);
  assert.equal(reopened.send, true);
  assert.equal(reopened.suppressed, 2);
});

test("a failing webhook never throws to the caller", async () => {
  // Alerting must not be able to break the code path that detected the problem.
  const original = process.env.ALERT_WEBHOOK_URL;
  try {
    // Reload the module bound to an unroutable endpoint.
    delete require.cache[require.resolve("../src/services/alerts")];
    process.env.ALERT_WEBHOOK_URL = "http://127.0.0.1:1/nope";
    const broken = require("../src/services/alerts");
    const result = await broken.sendAlert("unreachable", "should not throw");
    assert.equal(result.sent, false);
    assert.ok(result.error, "failure should be reported, not thrown");
  } finally {
    process.env.ALERT_WEBHOOK_URL = original;
    delete require.cache[require.resolve("../src/services/alerts")];
  }
});
