const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/routes/voicebot");

function session(language = "Hinglish", overrides = {}, sessionOverrides = {}) {
  return {
    preferredLanguage: language,
    tenantId: "tenant",
    lead: {
      name: "Test User",
      phone: "8826522604",
      playbook_type: "UNAPPROVED_USERS",
      offer_amount: "50000",
      loan_amount: null,
      language,
      ...overrides
    },
    ...sessionOverrides
  };
}

test("voicebot answers interest-rate questions directly in Hindi", () => {
  const reply = _test.buildScriptedReply(session(), "मुझे rate of interest जानना है");
  assert.match(reply, /ब्याज दर/);
  assert.doesNotMatch(reply, /पूछिए/);
});

test("voicebot answers interest-rate questions directly in English", () => {
  const reply = _test.buildScriptedReply(session("English"), "What is the interest rate?");
  assert.match(reply, /exact interest rate/i);
  assert.doesNotMatch(reply, /please ask/i);
});

test("voicebot recovers when user says the answer was wrong", () => {
  const reply = _test.buildScriptedReply(session(), "यह नहीं पूछा मैंने");
  assert.match(reply, /गलत समझा/);
  assert.match(reply, /ब्याज दर/);
});

test("voicebot answers fee and charge questions safely", () => {
  const reply = _test.buildScriptedReply(session("English"), "Any processing fee or hidden charges?");
  assert.match(reply, /shown clearly/i);
  assert.match(reply, /never share OTP/i);
});

test("voicebot explains identity without asking sensitive details", () => {
  const reply = _test.buildScriptedReply(session(), "कौन बोल रहा है?");
  assert.match(reply, /लोन कनेक्ट/);
  assert.match(reply, /ओ टी पी/);
});

test("voicebot explains where the number came from", () => {
  const reply = _test.buildScriptedReply(session("English"), "Where did you get my number?");
  assert.match(reply, /loan enquiry|app registration/i);
});

test("voicebot handles link not opening", () => {
  const reply = _test.buildScriptedReply(session("English", {}, { tenantId: null }), "The link is not opening");
  assert.match(reply, /sending the secure link again/i);
  assert.match(reply, /app support/i);
});

test("voicebot sends details without implying whatsapp support", () => {
  const reply = _test.buildScriptedReply(session("English", {}, { tenantId: null }), "Send details on WhatsApp");
  assert.match(reply, /SMS/i);
  assert.match(reply, /before accepting/i);
});

test("voicebot answers pending approval questions", () => {
  const reply = _test.buildScriptedReply(session("English"), "Why am I not approved?");
  assert.match(reply, /incomplete|pending/i);
});

test("voicebot handles forgot login safely", () => {
  const reply = _test.buildScriptedReply(session(), "मुझे login password भूल गया");
  assert.match(reply, /mobile number/);
  assert.match(reply, /ओ टी पी/);
});

test("voicebot answers disbursal timing without overpromising", () => {
  const reply = _test.buildScriptedReply(session("English"), "Money kab account mein aayega?");
  assert.match(reply, /depends on final approval/i);
});

test("voicebot explains CIBIL impact", () => {
  const reply = _test.buildScriptedReply(session(), "Will this affect my CIBIL?");
  assert.match(reply, /सिबिल/);
});

test("voicebot allows review and rejection", () => {
  const reply = _test.buildScriptedReply(session("English"), "Can I reject after seeing offer?");
  assert.match(reply, /does not force/i);
});

test("voicebot answers due date from lead data", () => {
  const reply = _test.buildScriptedReply(session("English", {
    playbook_type: "SOFT_PAYMENT_REMINDER",
    due_date: "2026-06-10"
  }), "When is my due date?");
  assert.match(reply, /2026-06-10/);
});

test("voicebot handles payment failed", () => {
  const reply = _test.buildScriptedReply(session("English", {}, { tenantId: null }), "Payment failed but money debited");
  assert.match(reply, /money was debited/i);
  assert.match(reply, /app support/i);
});

test("voicebot handles partial payment questions", () => {
  const reply = _test.buildScriptedReply(session(), "Can I pay partially?");
  assert.match(reply, /Partial payment|Partial/i);
});

test("voicebot handles penalty questions", () => {
  const reply = _test.buildScriptedReply(session("English"), "How much penalty is added?");
  assert.match(reply, /late fee|penalty/i);
});

test("voicebot handles hardship and restructuring", () => {
  const reply = _test.buildScriptedReply(session(), "मेरी नौकरी चली गई, cannot pay full amount");
  assert.match(reply, /restructuring|easy EMI/i);
});

test("voicebot handles no human transfer", () => {
  const reply = _test.buildScriptedReply(session("English"), "Connect me to agent");
  assert.match(reply, /no human transfer/i);
});

test("voicebot captures explicit fresh-lead name and asks loan requirement next", () => {
  const state = session("English", { playbook_type: "FRESH_LEAD" }, {
    userTurns: 1,
    lastSpokenText: "Can I confirm your name?"
  });

  _test.updateConversationMemory(state, "My name is Apoorv Gupta");
  const reply = _test.buildScriptedReply(state, "My name is Apoorv Gupta");

  assert.equal(state.confirmedName, true);
  assert.equal(state.capturedName, "Apoorv Gupta");
  assert.match(reply, /how much loan/i);
  assert.doesNotMatch(reply, /name/i);
});

test("voicebot treats a short answer after name prompt as confirmed", () => {
  const state = session("Hinglish", { playbook_type: "FRESH_LEAD", name: "" }, {
    userTurns: 1,
    lastSpokenText: "आपका नाम confirm कर दीजिए"
  });

  _test.updateConversationMemory(state, "Apoorv");
  const reply = _test.buildScriptedReply(state, "Apoorv");

  assert.equal(state.confirmedName, true);
  assert.equal(state.capturedName, "Apoorv");
  assert.match(reply, /कितना loan चाहिए/);
});

test("voicebot drops stale replies after a newer turn starts", () => {
  const state = {};
  const firstTurn = _test.beginUserTurn(state, "What is the interest rate?", "final");
  assert.equal(_test.isCurrentTurn(state, firstTurn), true);

  const secondTurn = _test.beginUserTurn(state, "I did not get the link", "final");
  assert.equal(_test.isCurrentTurn(state, firstTurn), false);
  assert.equal(_test.isCurrentTurn(state, secondTurn), true);
});

test("voicebot invalidates active turn when user barges in", () => {
  const state = {};
  const firstTurn = _test.beginUserTurn(state, "Show my offer", "final");
  _test.invalidateAssistantTurn(state, "barge_in_speech_started");
  assert.equal(_test.isCurrentTurn(state, firstTurn), false);
});
