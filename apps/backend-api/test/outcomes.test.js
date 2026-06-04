const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyConversation,
  inferOutcome,
  isOptOut,
  isTerminalIntent,
  terminalOutcome
} = require("../src/services/outcomes");

test("inferOutcome detects promise to pay", () => {
  assert.equal(inferOutcome("I will pay tomorrow"), "PROMISE_TO_PAY");
});

test("inferOutcome detects disputes", () => {
  assert.equal(inferOutcome("The amount is wrong, I have an issue"), "DISPUTE");
});

test("isOptOut detects do-not-call language", () => {
  assert.equal(isOptOut("please do not call me again"), true);
});

test("Hindi decline with bye is terminal not interested", () => {
  const message = "नहीं मुझे नहीं करना है bye।";
  assert.equal(inferOutcome(message), "NOT_INTERESTED");
  assert.equal(isTerminalIntent(message), true);
  assert.equal(terminalOutcome(message), "NOT_INTERESTED");
});

test("Hindi link missing is not terminal", () => {
  const message = "लिंक नहीं है मेरे पास।";
  assert.equal(isTerminalIntent(message), false);
});

test("classifyConversation summarizes the outcome", () => {
  const result = classifyConversation({
    userMessage: "I will pay tomorrow",
    transcript: [{ speaker: "assistant", text: "Can you pay today?" }],
    playbookType: "SOFT_PAYMENT_REMINDER"
  });
  assert.equal(result.outcome, "PROMISE_TO_PAY");
  assert.match(result.summary, /future payment commitment/);
});
