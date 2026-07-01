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

test("natural speaking confirmation also confirms the CSV identity", () => {
  const state = session("Hinglish", {
    name: "Apoorv Gupta",
    playbook_type: "TEZ_SELFIE_PENDING",
    drop_stage: "SELFIE_PENDING"
  }, {
    identityPrompted: true,
    userTurns: 1,
    lastSpokenText: "क्या मेरी बात Apoorv Gupta जी से हो रही है?"
  });

  _test.updateConversationMemory(state, "हाँ जी, मैं ही बोल रहा हूँ");
  assert.equal(state.confirmedName, true);
});

test("natural Hindi identity confirmation from production advances to availability", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    userTurns: 1,
    lastSpokenText: "नमस्ते, मैं TezCredit से Raj बोल रहा हूँ। क्या मेरी बात Prasheel जी से हो रही है?"
  });

  _test.updateConversationMemory(state, "हां जी हो रही है।");
  const reply = _test.buildScriptedReply(state, "हां जी हो रही है।");
  assert.equal(state.confirmedName, true);
  assert.match(reply, /क्या अभी दो मिनट बात कर सकते हैं/);
  assert.doesNotMatch(reply, /क्या मेरी बात Prasheel जी से हो रही है/);
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

test("hello after the named greeting does not confirm identity or start the journey", () => {
  const state = session("English", {
    name: "Apoorv Gupta",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    userTurns: 1,
    lastSpokenText: "Hi, this is Raj calling from TezCredit. Am I speaking with Apoorv Gupta?"
  });

  _test.updateConversationMemory(state, "hello");
  const reply = _test.buildScriptedReply(state, "hello");
  assert.equal(Boolean(state.confirmedName), false);
  assert.match(reply, /Am I speaking with Apoorv Gupta/i);
  assert.doesNotMatch(reply, /bank verification|Apply Now/i);
});

test("TezCredit opening waits for identity and availability before journey guidance", () => {
  const state = session("English", {
    name: "Apoorv Gupta",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    userTurns: 1,
    lastSpokenText: "Hi, this is Raj calling from TezCredit. Am I speaking with Apoorv Gupta?"
  });

  _test.updateConversationMemory(state, "yes");
  const permission = _test.buildScriptedReply(state, "yes");
  assert.match(permission, /good time to talk for two minutes/i);
  assert.doesNotMatch(permission, /bank verification|Apply Now/i);

  state.lastSpokenText = permission;
  state.userTurns = 2;
  _test.updateConversationMemory(state, "yes");
  const purpose = _test.buildScriptedReply(state, "yes");
  assert.match(purpose, /bank verification is pending/i);
  assert.match(purpose, /open the website/i);
  assert.doesNotMatch(purpose, /Apply Now/i);

  state.lastSpokenText = purpose;
  state.userTurns = 3;
  _test.updateConversationMemory(state, "yes");
  const guidance = _test.buildScriptedReply(state, "yes");
  assert.match(guidance, /www\.tezcredit\.com/i);
  assert.match(guidance, /Apply Now/i);
});

test("repeated natural yes confirms availability without repeating the permission question", () => {
  const permission = "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?";
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    confirmedName: true,
    userTurns: 2,
    lastSpokenText: permission,
    assistantReplyHistory: [permission]
  });

  _test.updateConversationMemory(state, "हाँ जी हाँ जी बताइए");
  const reply = _test.buildScriptedReply(state, "हाँ जी हाँ जी बताइए");
  assert.equal(state.availabilityConfirmed, true);
  assert.match(reply, /bank verification pending/);
  assert.doesNotMatch(reply, /दो मिनट बात कर सकते/);
});

test("natural Hindi availability confirmation from production advances to journey purpose", () => {
  const permission = "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?";
  for (const customerReply of ["हां कर सकते हैं बात बोलो आगे।", "कर सकते हैं बात?"]) {
    const state = session("Hinglish", {
      name: "Prasheel",
      playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
      drop_stage: "BANK_VERIFICATION_PENDING",
      source_metadata: { productName: "TezCredit" }
    }, {
      identityPrompted: true,
      confirmedName: true,
      userTurns: 2,
      lastSpokenText: permission,
      assistantReplyHistory: [permission]
    });

    _test.updateConversationMemory(state, customerReply);
    const reply = _test.buildScriptedReply(state, customerReply);
    assert.equal(state.availabilityConfirmed, true, customerReply);
    assert.match(reply, /bank verification pending/, customerReply);
    assert.doesNotMatch(reply, /दो मिनट बात कर सकते/, customerReply);
  }
});

test("anti-repeat never replaces an availability prompt with journey instructions", () => {
  const permission = "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?";
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    lastSpokenText: permission,
    assistantReplyHistory: [permission]
  });

  const reply = _test.refineAssistantReply(state, "हाँ जी", permission, { source: "scripted" });
  assert.equal(reply, permission);
  assert.doesNotMatch(reply, /UPI|bank verification tap/i);
});

test("bank screen guidance progresses from visible screen to selecting the reported option", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  const first = _test.buildScriptedReply(state, "हाँ जी दिख रहा है");
  const second = _test.buildScriptedReply(state, "दिख रहा है दिख रहा है");
  const option = _test.buildScriptedReply(state, "UPI का option दिख रहा है");

  assert.match(first, /कौन सा option|UPI/);
  assert.match(second, /Screen पर लिखा option|UPI/);
  assert.notEqual(first, second);
  assert.match(option, /option चुनकर|successful/);
  assert.equal(state.bankVerificationOptionSeen, true);
});

test("no after the availability question asks for a callback time", () => {
  const state = session("English", {
    name: "Apoorv Gupta",
    playbook_type: "TEZ_SELFIE_PENDING",
    drop_stage: "SELFIE_PENDING"
  }, {
    confirmedName: true,
    lastSpokenText: "Thank you, Apoorv Gupta. Is now a good time to talk for two minutes?"
  });

  assert.equal(_test.isAvailabilityDecline(state, "no"), true);
  assert.match(_test.availabilityDeclineReply(state), /what time.*call you back/i);
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

test("five-minute call limit uses the requested English closing", () => {
  assert.equal(
    _test.maxCallClosingText(session("English")),
    "You can follow the pending steps now."
  );
});

test("five-minute call limit uses a natural Hindi closing", () => {
  assert.equal(
    _test.maxCallClosingText(session("Hinglish")),
    "अब आप बाकी चरण पूरे कर सकते हैं।"
  );
});

test("voicebot limits calls to five minutes by default", () => {
  assert.deepEqual(_test.maxCallDurationConfig(), {
    maxCallSeconds: 300,
    closingLeadSeconds: 5
  });
});

test("TezCredit website wait checks at 20 seconds and closes at 30 seconds total", () => {
  assert.deepEqual(_test.websiteLoginCheckDelays(), {
    firstCheckMs: 20000,
    finalCheckMs: 30000
  });

  const state = session("English", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  });
  assert.equal(
    _test.shouldStartWebsiteLoginWait(state, "Open www.tezcredit.com, click Apply Now, and log in."),
    true
  );
  assert.equal(
    _test.shouldStartWebsiteLoginWait(state, "Are you able to open the website now?"),
    false
  );
  assert.match(_test.websiteLoginCheckText(state, 1), /opened.*Apply Now.*logged in/i);
  assert.match(_test.websiteLoginCheckText(state, 2), /complete the pending process.*Thank you/i);
  state.websiteLoginConfirmed = true;
  assert.equal(
    _test.shouldStartWebsiteLoginWait(state, "Open www.tezcredit.com, click Apply Now, and log in."),
    false
  );
});

test("TezCredit website wait proceeds only after login confirmation", () => {
  assert.equal(_test.websiteLoginConfirmed("Yes, I have logged in"), true);
  assert.equal(_test.websiteLoginConfirmed("हाँ जी login हो गया"), true);
  assert.equal(_test.websiteLoginConfirmed("अभी नहीं हुआ"), false);
  assert.equal(_test.websiteLoginConfirmed("yes"), false);
  assert.equal(_test.websiteLoginConfirmed("yes", { allowBareAgreement: true }), true);
});

test("TezCredit proceeds to the active stage after website login confirmation", () => {
  const state = session("English", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    websiteLoginConfirmed: true
  });

  const reply = _test.buildScriptedReply(state, "yes");
  assert.match(reply, /UPI verification|bank-account verification|error/i);
  assert.doesNotMatch(reply, /open www\.tezcredit\.com|Apply Now|sign in/i);
  assert.equal(state.websiteLoginAcknowledged, true);
});

test("TezCredit answers the eligible amount from imported CSV details", () => {
  const state = session("English", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "1800",
    source_metadata: { productName: "TezCredit" }
  });

  const reply = _test.buildScriptedReply(state, "How much amount can I get?");
  assert.match(reply, /current eligible amount/i);
  assert.match(reply, /₹1,800/);
  assert.match(reply, /TezCredit details/i);
});

test("TezCredit handles a request for more amount without promising approval", () => {
  const state = session("English", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "1800",
    source_metadata: { productName: "TezCredit" }
  });

  const reply = _test.buildScriptedReply(state, "I want more amount");
  assert.match(reply, /current loan.*₹1,800/i);
  assert.match(reply, /may become eligible for a higher amount/i);
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

test("identity and availability confirmations remain in progress until journey intent is known", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    userTurns: 2,
    confirmedName: true,
    confirmedNameTurn: 1,
    availabilityConfirmed: true,
    availabilityConfirmedTurn: 2
  });

  const result = _test.classifyLiveConversation(state, "हां कर सकते हैं बात बोलो आगे।", [
    { speaker: "user", text: "हां जी हो रही है।" },
    { speaker: "user", text: "हां कर सकते हैं बात बोलो आगे।" }
  ]);

  assert.equal(result.outcome, "IN_PROGRESS");
  assert.equal(result.intent, "IN_PROGRESS");
  assert.match(result.summary, /identity or availability/i);
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
