const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/routes/voicebot");

function session(language = "Hinglish", overrides = {}) {
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
    }
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
