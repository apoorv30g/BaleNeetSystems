const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/routes/voicebot");

// Wiring tests for the third-party disclosure guard inside the live conversation engine.
// The pure detection/guard functions are covered in collections.test.js; these assert the
// engine actually applies them.

function session(overrides = {}, language = "Hinglish") {
  return {
    preferredLanguage: language,
    tenantId: "tenant",
    lead: {
      name: "Apoorv Gupta",
      phone: "8826522604",
      playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
      drop_stage: "BANK_VERIFICATION_PENDING",
      offer_amount: "18000",
      loan_amount: "18000",
      language
    },
    ...overrides
  };
}

test("the third-party closing reveals no loan, amount, or reason for the call", () => {
  const hindi = _test.thirdPartyCloseText(session());
  const english = _test.thirdPartyCloseText(session({}, "English"));

  for (const text of [hindi, english]) {
    assert.ok(text.length > 0);
    // Naming the reason to the wrong person IS the disclosure we are avoiding.
    assert.doesNotMatch(text, /loan|emi|overdue|due|amount|payment|बकाया|किस्त|लोन|₹/i);
  }
  assert.match(english, /wrong contact|not call/i);
});

test("the identity-first stand-in asks for confirmation without disclosing anything", () => {
  const reply = _test.identityFirstReply(session({}, "English"));
  assert.match(reply, /confirm/i);
  assert.doesNotMatch(reply, /loan|emi|overdue|amount|₹/i);
});

test("a debt-revealing reply is suppressed once a third party is suspected", () => {
  const state = session({ thirdPartySuspected: true, confirmedName: false, userTurns: 2 });
  const refined = _test.refineAssistantReply(
    state,
    "he is not here",
    "Your EMI of ₹18,000 is overdue, please pay today.",
    { source: "llm" }
  );

  assert.doesNotMatch(refined, /EMI|overdue|18,000|₹/i, "must not disclose debt to a third party");
  assert.match(refined, /confirm/i, "should ask to confirm identity instead");
});

test("a debt-revealing reply is allowed once identity IS confirmed", () => {
  const state = session({ thirdPartySuspected: true, confirmedName: true, userTurns: 2 });
  const refined = _test.refineAssistantReply(
    state,
    "yes it's me",
    "Your bank verification is pending.",
    { source: "scripted" }
  );
  assert.match(refined, /bank verification/i, "the borrower themselves may be told");
});

test("normal calls are unaffected — the guard only applies after a third-party signal", () => {
  // Identity is unconfirmed at the start of EVERY call; gating on that alone would break the
  // standard opening, which exists precisely to establish identity first.
  const state = session({ confirmedName: false, userTurns: 1 });
  const refined = _test.refineAssistantReply(
    state,
    "haan boliye",
    "Aapka bank verification pending hai.",
    { source: "scripted" }
  );
  assert.match(refined, /bank verification/i, "an ordinary pre-confirmation turn must not be blocked");
});

test("a non-disclosing reply passes through even when a third party is suspected", () => {
  const state = session({ thirdPartySuspected: true, confirmedName: false, userTurns: 2 });
  const refined = _test.refineAssistantReply(
    state,
    "who is this",
    "Kya aap abhi baat kar sakte hain?",
    { source: "scripted" }
  );
  assert.match(refined, /baat kar sakte/i, "harmless replies must not be suppressed");
});
