const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyConversation,
  inferOutcome,
  isCallScreening,
  isOptOut,
  isTerminalIntent,
  isVoicemail,
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
  assert.equal(isOptOut("कभी भी ना"), true);
  assert.equal(isOptOut("never contact me again"), true);
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

test("voicemail and call screening are terminal non-human outcomes", () => {
  assert.equal(isVoicemail("Please reply after the tone."), true);
  assert.equal(inferOutcome("Please reply after the tone."), "VOICEMAIL");
  assert.equal(terminalOutcome("Please reply after the tone."), "VOICEMAIL");
  assert.equal(isTerminalIntent("Please reply after the tone."), true);

  assert.equal(isCallScreening("Name and reason for your call? Please stay on the line."), true);
  assert.equal(inferOutcome("Name and reason for your call? Please stay on the line."), "CALL_SCREENING");
  assert.equal(terminalOutcome("Name and reason for your call? Please stay on the line."), "CALL_SCREENING");
});

test("customer asking reason for call is not call screening", () => {
  assert.equal(isCallScreening("What is the reason for this call?"), false);
  assert.equal(isTerminalIntent("What is the reason for this call?"), false);
  assert.equal(isCallScreening("website का नाम बताइए मेरे को"), false);
  assert.equal(isCallScreening("नाम क्या है website का?"), false);
});

test("classifyConversation summarizes the outcome", () => {
  const result = classifyConversation({
    userMessage: "I will pay tomorrow",
    transcript: [{ speaker: "assistant", text: "Can you pay today?" }],
    playbookType: "SOFT_PAYMENT_REMINDER"
  });
  assert.equal(result.outcome, "PROMISE_TO_PAY");
  assert.match(result.summary, /future payment commitment/);
  assert.equal(result.intent, "PROMISE_TO_PAY");
  assert.equal(result.nextAction, "Schedule payment follow-up near the promised time.");
  assert.ok(result.confidence > 0.8);
});
