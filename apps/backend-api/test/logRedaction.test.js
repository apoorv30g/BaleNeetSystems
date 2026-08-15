const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/utils/logger");

const { redact, redactText } = _test;

test("phone numbers are redacted from free text", () => {
  assert.equal(redactText("call 9876543210 now"), "call [phone] now");
  assert.equal(redactText("+91 9876543210"), "[phone]");
  assert.equal(redactText("+919876543210"), "[phone]");
});

test("PAN and Aadhaar numbers are redacted", () => {
  assert.match(redactText("PAN ABCDE1234F verified"), /\[pan\]/);
  assert.match(redactText("aadhaar 1234 5678 9012"), /\[aadhaar\]/);
  assert.match(redactText("aadhaar 123456789012"), /\[aadhaar\]/);
});

test("email addresses are redacted", () => {
  assert.equal(redactText("contact borrower@example.com today"), "contact [email] today");
});

test("sensitive keys are replaced wholesale regardless of value", () => {
  const out = redact({
    password: "hunter2",
    token: "eyJhbGciOi",
    phone: "9876543210",
    apiKey: "sk-live-123",
    harmless: "keep me"
  });
  assert.equal(out.password, "[redacted]");
  assert.equal(out.token, "[redacted]");
  assert.equal(out.phone, "[redacted]");
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.harmless, "keep me");
});

test("nested objects and arrays are redacted", () => {
  const out = redact({
    lead: { name: "Test", phone: "9876543210" },
    transcripts: ["my number is 9876543210", "ok"]
  });
  assert.equal(out.lead.phone, "[redacted]");
  assert.equal(out.transcripts[0], "my number is [phone]");
  assert.equal(out.transcripts[1], "ok");
});

test("transcript text embedded in a non-sensitive key is still scrubbed", () => {
  // The most common real leak: a transcript logged under a neutral key like "text".
  const out = redact({ text: "haan mera number 9876543210 hai, PAN ABCDE1234F" });
  assert.doesNotMatch(out.text, /9876543210/);
  assert.doesNotMatch(out.text, /ABCDE1234F/);
});

test("Error objects keep their message but are scrubbed", () => {
  const out = redact({ err: new Error("failed for 9876543210") });
  assert.equal(out.err.message, "failed for [phone]");
  assert.equal(out.err.name, "Error");
});

test("non-string primitives pass through untouched", () => {
  const out = redact({ count: 42, ok: true, nothing: null });
  assert.equal(out.count, 42);
  assert.equal(out.ok, true);
  assert.equal(out.nothing, null);
});

test("deeply nested structures terminate rather than recursing forever", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: "9876543210" } } } } } } } };
  assert.doesNotThrow(() => redact(deep));
});

test("ordinary numbers are not mistaken for phone numbers", () => {
  // Loan amounts and durations must survive, or logs become useless for debugging.
  assert.equal(redactText("amount 50000 over 12 months"), "amount 50000 over 12 months");
  assert.equal(redactText("duration 180 seconds"), "duration 180 seconds");
});
