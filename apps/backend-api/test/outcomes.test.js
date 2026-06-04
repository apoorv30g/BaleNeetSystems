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

test("due-date question is not treated as promise to pay", () => {
  const message = "When is my due date?";
  assert.equal(inferOutcome(message), "IN_PROGRESS");
  assert.equal(isTerminalIntent(message), false);
});

test("callback and wrong-number requests are terminal", () => {
  assert.equal(inferOutcome("I am driving, call me tomorrow"), "CALLBACK");
  assert.equal(isTerminalIntent("I am driving, call me tomorrow"), true);
  assert.equal(terminalOutcome("wrong number"), "WRONG_NUMBER");
  assert.equal(isTerminalIntent("wrong number"), true);
});

test("paid and promise-to-pay responses are terminal", () => {
  assert.equal(terminalOutcome("I already paid"), "PAID");
  assert.equal(isTerminalIntent("I already paid"), true);
  assert.equal(terminalOutcome("I will pay tomorrow"), "PROMISE_TO_PAY");
  assert.equal(isTerminalIntent("I will pay tomorrow"), true);
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
