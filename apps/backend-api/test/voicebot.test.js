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

test("voicebot answers iPhone screening with name and purpose", () => {
  const reply = _test.callScreeningReply(session("English", {
    source_metadata: { productName: "TezCredit" }
  }));

  assert.match(reply, /Raj from TezCredit/i);
  assert.match(reply, /loan eligibility check/i);
  assert.match(reply, /connect the call/i);
  assert.doesNotMatch(reply, /Thank you/i);
});

test("voicebot handles hearing confirmation without malformed LLM text", () => {
  const state = session("Hinglish", {}, {
    userTurns: 1,
    tenantId: null,
    lastSpokenText: "Namaste, mai Loan App se Raj bol raha hu. Kya aap mujhe sun paa rahe hain?"
  });

  const reply = _test.buildScriptedReply(state, "हाँ मैं सुन पा रहा हूँ।");
  assert.match(reply, /सुरक्षित link भेज/);
  assert.match(reply, /screen दिख रहा/);
  assert.doesNotMatch(reply, /ऐप में सुरक्षित।/);
});

test("voicebot moves unclear first response after greeting to safe link flow", () => {
  const state = session("Hinglish", {}, {
    userTurns: 1,
    tenantId: null,
    lastSpokenText: "Namaste, mai Loan App se Raj bol raha hu. Kya aap mujhe sun paa rahe hain?"
  });

  const reply = _test.buildScriptedReply(state, "तो ते मैं ही बोलेगी।");
  assert.match(reply, /सुरक्षित link भेज/);
  assert.match(reply, /screen दिख रहा/);
});

test("voicebot advances after user agrees to an already-sent link", () => {
  const state = session("Hinglish", {}, { tenantId: null });

  const first = _test.buildScriptedReply(state, "yes");
  assert.match(first, /सुरक्षित link भेज/);
  assert.equal(state.linkInstructionGiven, true);

  const second = _test.buildScriptedReply(state, "OK");
  assert.match(second, /screen/);
  assert.doesNotMatch(second, /सुरक्षित link भेज|link भेज रहा/);
});

test("voicebot uses last spoken link prompt to avoid repeating in English", () => {
  const state = session("English", {}, {
    tenantId: null,
    lastSpokenText: "Sure, I am sending the secure link. Please open it and check your documents and final eligibility."
  });

  const reply = _test.buildScriptedReply(state, "yes");
  assert.match(reply, /what you see|which screen/i);
  assert.doesNotMatch(reply, /sending the secure link/i);
});

test("voicebot treats hmm after a link prompt as a conversational follow-up", () => {
  const state = session("Hinglish", {}, {
    tenantId: null,
    lastSpokenText: "ठीक है, मैं सुरक्षित link भेज रहा हूँ। उसे खोलकर documents और final eligibility दो मिनट में check कर लीजिए।"
  });

  const reply = _test.buildScriptedReply(state, "हम्म");
  assert.match(reply, /screen/);
  assert.doesNotMatch(reply, /link भेज रहा/);
});

test("voicebot treats bare nahi after a link prompt as a blocker, not final rejection", () => {
  const state = session("Hinglish", {}, {
    tenantId: null,
    lastSpokenText: "ठीक है, मैं सुरक्षित link भेज रहा हूँ। उसे खोलकर documents और final eligibility दो मिनट में check कर लीजिए।"
  });

  assert.equal(_test.isContextualNegativeReply(state, "नाही"), true);
  assert.match(_test.contextualNegativeReply(state), /दिक्कत|link|app/);
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

test("voicebot protects intro audio from barge-in cancellation", () => {
  const state = {
    activeSpeechSeq: 1,
    activeSpeechMark: "intro_played",
    activeSpeechMediaStartedAt: Date.now() - 10000,
    activeSpeechChunksSent: 30
  };
  assert.equal(_test.shouldCancelAssistantSpeech(state, { type: "SpeechStarted" }), false);
});

test("voicebot allows later barge-in after speech grace period", () => {
  const state = {
    activeSpeechSeq: 2,
    activeSpeechMark: "reply_played",
    activeSpeechMediaStartedAt: Date.now() - 10000,
    activeSpeechChunksSent: 30
  };
  assert.equal(_test.shouldCancelAssistantSpeech(state, { type: "SpeechStarted" }), true);
});

test("voicebot greets TezCredit customer by the CSV name before discussing the journey", () => {
  const greeting = _test.firstGreeting({
    name: "Apoorv Gupta",
    language: "English",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "30000",
    source_metadata: { productName: "TezCredit" }
  });

  assert.equal(greeting, "Hi, this is Raj calling from TezCredit. Am I speaking with Apoorv Gupta?");
  assert.doesNotMatch(greeting, /bank verification|30,000|30000/i);
});

test("voicebot uses a polite Hindi named greeting for TezCredit", () => {
  const greeting = _test.firstGreeting({
    name: "Apoorv Gupta",
    language: "Hinglish",
    playbook_type: "TEZ_SELFIE_PENDING",
    drop_stage: "SELFIE_PENDING",
    source_metadata: { productName: "TezCredit" }
  });

  assert.match(greeting, /नमस्ते/);
  assert.match(greeting, /TezCredit से Raj/);
  assert.match(greeting, /Apoorv Gupta जी/);
});

test("yes after the named greeting confirms the CSV identity", () => {
  const state = session("English", {
    name: "Apoorv Gupta",
    playbook_type: "TEZ_SELFIE_PENDING",
    drop_stage: "SELFIE_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    userTurns: 1,
    lastSpokenText: "Hi, this is Raj calling from TezCredit. Am I speaking with Apoorv Gupta?"
  });

  _test.updateConversationMemory(state, "yes");
  assert.equal(state.confirmedName, true);
  assert.equal(state.capturedName, "Apoorv Gupta");
});

test("no after the named greeting asks for the intended person instead of rejecting the loan", () => {
  const state = session("English", {
    name: "Apoorv Gupta",
    playbook_type: "TEZ_SELFIE_PENDING",
    drop_stage: "SELFIE_PENDING"
  }, {
    lastSpokenText: "Hi, this is Raj calling from TezCredit. Am I speaking with Apoorv Gupta?"
  });

  assert.equal(_test.isNamedCalleeDenial(state, "no"), true);
  assert.match(_test.namedCalleeDenialReply(state), /Apoorv Gupta available/i);
  assert.match(_test.namedCalleeDenialReply(state), /wrong number/i);
});

test("TezCredit stage guidance sends the user through Apply Now on the website", () => {
  const state = session("English", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "1800",
    source_metadata: { productName: "TezCredit" }
  }, { tenantId: null });

  const reply = _test.buildScriptedReply(state, "yes");
  assert.match(reply, /www\.tezcredit\.com/i);
  assert.match(reply, /Apply Now/i);
  assert.doesNotMatch(reply, /\bapp\b/i);
});

test("TezCredit speech says 1800 as words and never calls the website an app", () => {
  const state = session("English", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  });

  const spoken = _test.prepareTextForSpeech("Open the app. Your offer is ₹1,800.", state);
  assert.match(spoken, /website/i);
  assert.match(spoken, /one thousand eight hundred rupees/i);
  assert.doesNotMatch(spoken, /₹|1,800|\bapp\b/i);
});

test("TezCredit Hindi speech says 1800 in Hindi words", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  });

  const spoken = _test.prepareTextForSpeech("आपका offer ₹1,800 है।", state);
  assert.match(spoken, /एक हज़ार आठ सौ रुपये/);
  assert.doesNotMatch(spoken, /₹|1,800/);
});

test("two-minute call limit uses the requested English closing", () => {
  assert.equal(
    _test.maxCallClosingText(session("English")),
    "You can follow the pending steps now."
  );
});

test("two-minute call limit uses a natural Hindi closing", () => {
  assert.equal(
    _test.maxCallClosingText(session("Hinglish")),
    "अब आप बाकी चरण पूरे कर सकते हैं।"
  );
});

test("voicebot treats iPhone available phrase as screening", () => {
  const { isCallScreening } = require("../src/services/outcomes");
  assert.equal(isCallScreening("This person is available."), true);
});

test("voicebot welcomes real user after call screening without human-transfer reply", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "18000",
    source_metadata: { productName: "TezCredit" }
  }, {
    tenantId: null,
    screeningAnswered: true,
    screeningHumanJoined: true,
    userTurns: 1
  });

  const reply = _test.buildScriptedReply(state, "Hello");
  assert.match(reply, /TezCredit|bank verification/i);
  assert.doesNotMatch(reply, /human transfer/i);
});

test("voicebot varies bank-verification clarification instead of repeating one sentence", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "18000",
    source_metadata: { productName: "TezCredit" }
  }, { tenantId: null });

  const first = _test.buildScriptedReply(state, "है जी?");
  const second = _test.buildScriptedReply(state, "और");

  assert.match(first, /bank verification|offer/i);
  assert.match(second, /अगला step|Next step|bank verification/i);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /complete।/);
  assert.doesNotMatch(second, /complete।/);
});

test("voicebot classification ignores screening text once a human joins", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    screeningAnswered: true,
    screeningHumanJoined: true
  });

  const result = _test.classifyLiveConversation(state, "Hello", [
    { speaker: "user", text: "This person is available." },
    { speaker: "assistant", text: "Please connect the call if the customer is available." },
    { speaker: "user", text: "Hello" }
  ]);

  assert.notEqual(result.outcome, "CALL_SCREENING");
});

test("voicebot rewrites assistant replies that repeat the previous line", () => {
  const repeated = "आपका loan offer ₹18,000 तक ready है, बस bank verification बाकी है। क्या app खोल सकते हैं?";
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "18000",
    source_metadata: { productName: "TezCredit" }
  }, {
    lastSpokenText: repeated,
    assistantReplyHistory: [repeated],
    tenantId: null
  });

  const reply = _test.refineAssistantReply(state, "और", repeated, { source: "llm" });
  assert.notEqual(reply, repeated);
  assert.match(reply, /अगला step|bank verification|UPI|app/i);
});

test("voicebot handles user complaint that it is repeating", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "18000",
    source_metadata: { productName: "TezCredit" }
  }, { tenantId: null });

  const reply = _test.buildScriptedReply(state, "आप बार बार एक ही बात बोल रहे हो");
  assert.match(reply, /repeat नहीं|Simple|bank verification|app/i);
});
