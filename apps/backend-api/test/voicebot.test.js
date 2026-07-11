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
  assert.match(reply, /Sneha/);
  assert.match(reply, /TezCredit/);
  assert.match(reply, /ओ टी पी/);
});

test("voicebot answers where are you calling from with TezCredit", () => {
  const reply = _test.buildScriptedReply(session("English"), "Where are you calling from?");
  assert.match(reply, /Sneha/);
  assert.match(reply, /calling from TezCredit/i);
  assert.doesNotMatch(reply, /LoanConnect/i);
});

test("TezCredit identity question is answered after callee confirmation", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    confirmedName: true,
    userTurns: 2,
    lastSpokenText: "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?"
  });

  const reply = _test.buildScriptedReply(state, "आप कहाँ से call कर रही हैं?");
  assert.match(reply, /Sneha/);
  assert.match(reply, /TezCredit/);
  assert.match(reply, /क्या अभी दो मिनट बात कर सकते हैं/);
  assert.doesNotMatch(reply, /LoanConnect|लोन कनेक्ट/i);
});

test("voicebot explains where the number came from", () => {
  const reply = _test.buildScriptedReply(session("English"), "Where did you get my number?");
  assert.match(reply, /loan enquiry|app registration/i);
});

test("voicebot handles link not opening", () => {
  const reply = _test.buildScriptedReply(session("English", {}, { tenantId: null }), "The link is not opening");
  assert.match(reply, /sending the secure link again/i);
  assert.match(reply, /www\.tezcredit\.com/i);
  assert.match(reply, /Apply Now/i);
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

  assert.match(reply, /Sneha from TezCredit/i);
  assert.match(reply, /loan eligibility check/i);
  assert.match(reply, /connect the call/i);
  assert.doesNotMatch(reply, /Thank you/i);
});

test("voicebot handles hearing confirmation without malformed LLM text", () => {
  const state = session("Hinglish", {}, {
    userTurns: 1,
    tenantId: null,
    lastSpokenText: "Namaste, main Sneha TezCredit se bol rahi hoon. Kya aap mujhe sun paa rahe hain?"
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
    lastSpokenText: "Namaste, main Sneha TezCredit se bol rahi hoon. Kya aap mujhe sun paa rahe hain?"
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

  assert.equal(greeting, "Hi, this is Sneha calling from TezCredit. Am I speaking with Apoorv Gupta?");
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
  assert.match(greeting, /Sneha, TezCredit से/);
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
    lastSpokenText: "Hi, this is Sneha calling from TezCredit. Am I speaking with Apoorv Gupta?"
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
    lastSpokenText: "नमस्ते, मैं Sneha, TezCredit से बोल रही हूँ। क्या मेरी बात Prasheel जी से हो रही है?"
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
    lastSpokenText: "Hi, this is Sneha calling from TezCredit. Am I speaking with Apoorv Gupta?"
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
    lastSpokenText: "Hi, this is Sneha calling from TezCredit. Am I speaking with Apoorv Gupta?"
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
    lastSpokenText: "Hi, this is Sneha calling from TezCredit. Am I speaking with Apoorv Gupta?"
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

test("no after the availability question closes politely without another question", () => {
  const state = session("English", {
    name: "Apoorv Gupta",
    playbook_type: "TEZ_SELFIE_PENDING",
    drop_stage: "SELFIE_PENDING"
  }, {
    confirmedName: true,
    lastSpokenText: "Thank you, Apoorv Gupta. Is now a good time to talk for two minutes?"
  });

  assert.equal(_test.isAvailabilityDecline(state, "no"), true);
  assert.equal(_test.availabilityDeclineReply(state), "No problem. Thank you for your time.");
  assert.doesNotMatch(_test.availabilityDeclineReply(state), /\?/);
  assert.equal(_test.availabilityDeclineOutcome("no"), "NOT_INTERESTED");
});

test("busy and negative availability responses always close the conversation gate", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    lastSpokenText: "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?"
  });

  for (const response of [
    "नहीं अभी मैं busy हूं।",
    "अभी बात नहीं कर सकते",
    "मेरे पास time नहीं है",
    "not a good time",
    "नहीं, किसके regarding?",
    "ਨਹੀਂ ਜੀ"
  ]) {
    assert.equal(_test.isAvailabilityDecline(state, response), true, response);
  }
  assert.equal(_test.availabilityDeclineOutcome("नहीं अभी मैं busy हूं।"), "CALLBACK");
  assert.equal(_test.availabilityDeclineReply(state), "कोई बात नहीं। आपका समय देने के लिए धन्यवाद।");
  assert.doesNotMatch(_test.availabilityDeclineReply(state), /\?/);
});

test("purpose question at the availability gate explains the active TezCredit step", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    confirmedName: true,
    lastSpokenText: "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?"
  });

  const reply = _test.buildScriptedReply(state, "किसके regarding?");
  assert.match(reply, /bank verification pending/);
  assert.match(reply, /क्या अभी दो मिनट बात कर सकते हैं/);
  assert.notEqual(reply, "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?");
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

test("voicebot uses strict three-second customer turn-taking", () => {
  assert.deepEqual(_test.noSpeechTurnConfig(), {
    strictTurnTaking: true,
    promptDelayMs: 3000,
    responseGraceMs: 3000
  });
  assert.equal(_test.noSpeechPromptText(session()), "Hello, क्या मेरी आवाज़ आपको आ रही है?");
  assert.match(_test.noSpeechClosingText(session()), /www\.tezcredit\.com/);
  assert.match(_test.noSpeechClosingText(session()), /login/);
  assert.equal(_test.noSpeechPromptText(session("English")), "Hello, am I audible?");
});

test("voicebot playback lock uses conservative overlap-prevention defaults", () => {
  assert.deepEqual(_test.playbackLockConfig(), {
    playbackMarkWaitMs: 900,
    speechQueueStaleMs: 8000,
    bargeInGraceMs: 700,
    bargeInMinChunks: 3,
    bargeInClearEnabled: true,
    fastAckEnabled: true,
    outboundChunkBytes: 640
  });
});

test("voicebot playback mark names are unique and Exotel-safe strings", () => {
  assert.equal(_test.buildPlaybackMarkName("reply played!", 12), "reply_played_12");
  assert.equal(_test.buildPlaybackMarkName("", 3), "speech_3");
  assert.ok(_test.buildPlaybackMarkName("x".repeat(80), 5).length <= 43);
});

test("missing Sarvam finals recover after a short watchdog instead of a long silence", () => {
  assert.deepEqual(_test.sttFinalWatchdogConfig(), {
    delayMs: 1200,
    recoveryText: "Sorry, awaaz clear nahi aayi. Ek baar phir bolenge?"
  });

  const state = {
    transcriptSeq: 3,
    activeSttUtterance: { seq: 7 }
  };
  assert.equal(_test.shouldRecoverMissingSttFinal(state, 7, 3), true);
  assert.equal(_test.shouldRecoverMissingSttFinal({ ...state, transcriptSeq: 4 }, 7, 3), false);
  assert.equal(_test.shouldRecoverMissingSttFinal({ ...state, speaking: true }, 7, 3), false);
  assert.equal(_test.shouldRecoverMissingSttFinal(state, 8, 3), false);
});

test("TezCredit website wait gives a full answer window after the check prompt", () => {
  assert.deepEqual(_test.websiteLoginCheckDelays(), {
    firstCheckMs: 20000,
    finalCheckMs: 30000,
    answerWindowMs: 10000
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
    _test.shouldUseWebsiteLoginWait(state, "Open www.tezcredit.com, click Apply Now, and log in."),
    false
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

test("customer speech interrupts website auto-close", () => {
  const state = {
    websiteWaitActive: true,
    websiteWaitStartedAt: Date.now(),
    websiteLoginCheckTimer: setTimeout(() => {}, 60000),
    websiteLoginFollowupTimer: setTimeout(() => {}, 60000)
  };

  assert.equal(_test.interruptWebsiteLoginWait(state, "customer_question"), true);
  assert.equal(state.websiteWaitActive, false);
  assert.equal(state.websiteLoginCheckTimer, null);
  assert.equal(state.websiteLoginFollowupTimer, null);
  assert.equal(state.websiteLoginResponsePending, true);
  assert.equal(state.websiteWaitInterruptedReason, "customer_question");
  assert.equal(_test.interruptWebsiteLoginWait(state, "duplicate"), false);
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

test("TezCredit answers the website name and URL directly", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    confirmedName: true,
    availabilityConfirmed: true,
    userTurns: 5
  });

  for (const question of ["नाम क्या है website का?", "website का नाम बताइए मेरे को"]) {
    const reply = _test.buildScriptedReply(state, question);
    assert.match(reply, /Website का नाम TezCredit है/);
    assert.match(reply, /www\.tezcredit\.com/);
    assert.match(reply, /Apply Now/);
    assert.doesNotMatch(reply, /Please connect the call/i);
  }
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
  assert.match(reply, /current eligible amount is ₹1,800/i);
  assert.match(reply, /take this amount first/i);
  assert.match(reply, /apply for a higher amount, subject to eligibility/i);
});

test("TezCredit answers amount questions during the opening gate", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "18000",
    source_metadata: { productName: "TezCredit" }
  }, {
    identityPrompted: true,
    confirmedName: true,
    availabilityConfirmed: false,
    userTurns: 2
  });

  const amountReply = _test.buildScriptedReply(state, "मुझे कितना amount मिलेगा?");
  assert.match(amountReply, /₹18,000/);
  assert.match(amountReply, /eligible amount/);
  assert.match(amountReply, /क्या अभी दो मिनट बात कर सकते हैं/);

  const moreReply = _test.buildScriptedReply({ ...state, availabilityConfirmed: true }, "मुझे ज्यादा amount चाहिए");
  assert.match(moreReply, /पहले यह amount ले लीजिए/);
  assert.match(moreReply, /higher amount के लिए apply/);
});

test("TezCredit handles real-call network issue with website-first guidance", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    source_metadata: { productName: "TezCredit" }
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    tenantId: null
  });

  const reply = _test.buildScriptedReply(state, "लेकिन net तो चल नहीं रहा");
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /Apply Now/);
  assert.doesNotMatch(reply, /app खोल|app में|ऐप/i);
});

test("TezCredit confirms same-number SMS link from real-call phrasing", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_PROFILE_PENDING",
    drop_stage: "PROFILE_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    tenantId: null
  });

  const reply = _test.buildScriptedReply(state, "मैं इसी number पर डाल दूं link");
  assert.match(reply, /इसी number|same number/i);
  assert.match(reply, /SMS|एस एम एस/i);
  assert.match(reply, /www\.tezcredit\.com/);
});

test("TezCredit lets customer self-complete without forcing call guidance", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_PROFILE_PENDING",
    drop_stage: "PROFILE_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    tenantId: null
  });

  const reply = _test.buildScriptedReply(state, "नहीं वैसे मैं भर लेता हूँ अपने आप ही");
  assert.match(reply, /खुद complete|खुद/i);
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /OTP|ओ टी पी/);
});

test("TezCredit handles NBFC and legitimacy questions safely", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  const reply = _test.buildScriptedReply(state, "यह NBFC पास है ना");
  assert.match(reply, /TezCredit/);
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /OTP|ओ टी पी/);
});

test("TezCredit handles high-interest objection without promising discount", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_APPROVED_NOT_DISBURSED",
    drop_stage: "APPROVED_NOT_DISBURSED"
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  const reply = _test.buildScriptedReply(state, "interest बहुत ज्यादा है");
  assert.match(reply, /Final rate|Final/i);
  assert.match(reply, /मना|reject/i);
  assert.doesNotMatch(reply, /कम rate|discount|90%/i);
});

test("TezCredit explains how personal loan proceeds from the website", () => {
  const state = session("Hinglish", {
    playbook_type: "TEZ_PROFILE_PENDING",
    drop_stage: "PROFILE_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  const reply = _test.buildScriptedReply(state, "personal loan चाहिए तो कैसे मिलेगा");
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /Apply Now/);
  assert.match(reply, /Eligibility/i);
});

test("TezCredit latest-call website question gives exact URL before bank guidance", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "18000",
    source_metadata: { productName: "TezCredit" }
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  const reply = _test.buildScriptedReply(state, "कौन सी website?");
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /Apply Now/);
  assert.match(reply, /mobile number|mobile number से/i);
  assert.doesNotMatch(reply, /bank verification दिख रहा|UPI या bank account/i);
});

test("TezCredit handles unknown website phrasing from latest call", () => {
  const state = session("English", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  const reply = _test.buildScriptedReply(state, "I don't know the website");
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /Apply Now/);
  assert.doesNotMatch(reply, /UPI|bank-account verification/i);
});

test("TezCredit login question explains website login instead of repeating bank step", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  const reply = _test.buildScriptedReply(state, "लॉग इन कैसे करना है?");
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /Apply Now/);
  assert.match(reply, /registered mobile number|mobile number/i);
  assert.match(reply, /OTP|ओ टी पी/);
  assert.doesNotMatch(reply, /UPI या account verification|bank verification screen/i);
});

test("TezCredit process-in-progress waits for result instead of resetting journey", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    bankVerificationOptionSeen: true
  });

  const reply = _test.buildScriptedReply(state, "process हो रहा है");
  assert.match(reply, /process complete|wait|seconds|successful|failed/i);
  assert.doesNotMatch(reply, /website खोलिए|UPI, bank account/);
});

test("TezCredit not-visible blocker asks current screen and is not marked interested", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    bankVerificationOptionSeen: true,
    userTurns: 8
  });

  const reply = _test.buildScriptedReply(state, "नहीं दिख रहा अभी यार");
  assert.match(reply, /exact screen|screen बताइए/i);
  assert.match(reply, /mobile login|OTP|profile|offer|UPI|error/i);
  assert.doesNotMatch(reply, /कौन सा option दिख रहा है: UPI, bank account/);

  const classification = _test.classifyLiveConversation(state, "नहीं दिख रहा अभी यार", [
    { speaker: "user", text: "UPI" },
    { speaker: "assistant", text: "दिख रहा option tap करके verification पूरा कीजिए। Successful दिखे तो मुझे बताइए।" },
    { speaker: "user", text: "नहीं दिख रहा अभी यार" }
  ]);
  assert.equal(classification.outcome, "IN_PROGRESS");
  assert.match(classification.reason, /blocked|cannot see/i);
});

test("voicebot treats iPhone available phrase as screening", () => {
  const { isCallScreening } = require("../src/services/outcomes");
  assert.equal(isCallScreening("This person is available."), true);
});

test("voicebot only treats screening prompts as screening before a human conversation starts", () => {
  assert.equal(
    _test.shouldTreatAsCallScreening({ userTurns: 0 }, "Name and reason for your call? Please stay on the line."),
    true
  );
  assert.equal(
    _test.shouldTreatAsCallScreening({ userTurns: 5, confirmedName: true }, "website का नाम बताइए मेरे को"),
    false
  );
  assert.equal(
    _test.shouldTreatAsCallScreening({ userTurns: 5 }, "Name and reason for your call? Please stay on the line."),
    false
  );
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

test("Hindi singular availability confirmation is accepted", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    userTurns: 2,
    lastSpokenText: "धन्यवाद, Prasheel जी। क्या अभी दो मिनट बात कर सकते हैं?"
  });

  _test.updateConversationMemory(state, "हाँ कर सकता हूँ।");

  assert.equal(state.availabilityConfirmed, true);
  assert.equal(state.availabilityConfirmedTurn, 2);
});

test("approved-not-disbursed vague completion asks for credit confirmation instead of backtracking", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_APPROVED_NOT_DISBURSED",
    drop_stage: "APPROVED_NOT_DISBURSED"
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    userTurns: 9
  });

  const reply = _test.buildScriptedReply(state, "हो गया complete।");

  assert.match(reply, /loan amount|credit|account/i);
  assert.doesNotMatch(reply, /कौन सा website screen|एक-एक step|www\.tezcredit\.com/);
});

test("credit confirmation is classified as journey completed", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_APPROVED_NOT_DISBURSED",
    drop_stage: "APPROVED_NOT_DISBURSED"
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    userTurns: 14
  });

  const result = _test.classifyLiveConversation(state, "क्रेडिट हो गया।", [
    { speaker: "assistant", text: "क्या loan amount आपके account में credit हो गया?" },
    { speaker: "user", text: "क्रेडिट हो गया।" }
  ]);

  assert.equal(result.outcome, "JOURNEY_COMPLETED");
  assert.equal(result.intent, "JOURNEY_COMPLETED");
});

test("max duration uses completion close when journey is already completed", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_APPROVED_NOT_DISBURSED",
    drop_stage: "JOURNEY_COMPLETED",
    source_status: "JOURNEY_COMPLETED",
    source_metadata: { journeyProgress: { journeyCompleted: true } }
  }, {
    journeyCompleted: true
  });

  const closing = _test.maxCallClosingText(state);

  assert.match(closing, /journey complete|journey complete हो गई/i);
  assert.doesNotMatch(closing, /बाकी चरण|pending steps/i);
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

test("known TezCredit identity is not confirmed by conversational filler", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    identityPrompted: true,
    userTurns: 1,
    lastSpokenText: "नमस्ते, मैं Sneha, TezCredit से बोल रही हूँ। क्या मेरी बात Prasheel जी से हो रही है?"
  });

  _test.updateConversationMemory(state, "हूं भाई।");
  const reply = _test.buildScriptedReply(state, "हूं भाई।");
  assert.equal(Boolean(state.confirmedName), false);
  assert.match(reply, /Prasheel जी से हो रही है/);
});

test("Punjabi-script haan ji confirms a known customer after Sarvam transliteration", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    identityPrompted: true,
    userTurns: 1,
    lastSpokenText: "नमस्ते, मैं Sneha, TezCredit से बोल रही हूँ। क्या मेरी बात Prasheel जी से हो रही है?"
  });

  _test.updateConversationMemory(state, "ਹਾਂਜੀ");
  assert.equal(state.confirmedName, true);
  assert.match(_test.buildScriptedReply(state, "ਹਾਂਜੀ"), /दो मिनट बात कर सकते हैं/);
});

test("an explicitly different name never confirms the CSV customer", () => {
  const state = session("English", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    identityPrompted: true,
    userTurns: 1,
    lastSpokenText: "Hi, this is Sneha from TezCredit. Am I speaking with Prasheel?"
  });

  _test.updateConversationMemory(state, "I am Rahul");
  assert.equal(Boolean(state.confirmedName), false);
  assert.equal(_test.isNamedCalleeDenial(state, "I am Rahul"), true);
});

test("confidence-free Sarvam fragments are clarified without rejecting valid short intents", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING"
  });
  const noConfidence = { confidence: null };

  assert.equal(_test.isLikelyMisheardTranscript("मात्र", noConfidence, state), true);
  assert.equal(_test.isLikelyMisheardTranscript("हाँ", noConfidence, state), false);
  assert.equal(_test.isLikelyMisheardTranscript("website", noConfidence, state), false);
  assert.equal(_test.isLikelyMisheardTranscript("UPI", noConfidence, state), false);
});

test("a lone website reference asks for confirmation without assuming a bank screen", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    identityPrompted: true,
    confirmedName: true,
    availabilityConfirmed: true,
    userTurns: 4
  });

  const reply = _test.buildScriptedReply(state, "website");
  assert.match(reply, /www\.tezcredit\.com/);
  assert.match(reply, /खुल गई है/);
  assert.doesNotMatch(reply, /UPI|bank account|successful/);
});

test("TezCredit interest requires meaningful journey evidence", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING"
  }, {
    confirmedName: true,
    availabilityConfirmed: true,
    userTurns: 4
  });
  const transcript = [
    { speaker: "user", text: "हाँ हाँ कर सकते हैं" },
    { speaker: "user", text: "website" }
  ];

  assert.equal(_test.classifyLiveConversation(state, "website", transcript).outcome, "IN_PROGRESS");
  assert.equal(_test.classifyLiveConversation(state, "login हो गया", transcript).outcome, "INTERESTED");
});

test("LLM grounding rejects invented facts and allows known TezCredit facts", () => {
  const state = session("Hinglish", {
    name: "Prasheel",
    playbook_type: "TEZ_BANK_VERIFICATION_PENDING",
    drop_stage: "BANK_VERIFICATION_PENDING",
    offer_amount: "18000",
    loan_amount: "18000",
    source_metadata: { productName: "TezCredit" }
  }, {
    confirmedName: true,
    availabilityConfirmed: true
  });

  assert.ok(_test.assistantGroundingIssues(state, "Visit www.fake-loan.com now.").some(issue => issue.startsWith("unsupported_url:")));
  assert.ok(_test.assistantGroundingIssues(state, "Your loan amount is ₹50,000.").some(issue => issue.startsWith("unsupported_amount:")));
  assert.ok(_test.assistantGroundingIssues(state, "Your interest rate is 12%.").includes("unsupported_rate"));
  assert.ok(_test.assistantGroundingIssues(state, "Your processing fee is 500.").includes("unsupported_financial_term"));
  assert.ok(_test.assistantGroundingIssues(state, "Your tenure is 6 months.").includes("unsupported_financial_term"));
  assert.ok(_test.assistantGroundingIssues(state, "Your loan is guaranteed.").includes("unsupported_guarantee"));
  assert.ok(_test.assistantGroundingIssues(state, "Please tell me your OTP.").includes("sensitive_data_request"));
  assert.ok(_test.assistantGroundingIssues(state, "Your selfie is pending.").includes("stage_mismatch:SELFIE"));
  assert.deepEqual(
    _test.assistantGroundingIssues(state, "Your bank verification is pending. Open www.tezcredit.com. Your amount is ₹18,000. Never share OTP."),
    []
  );

  const grounded = _test.refineAssistantReply(state, "what next", "Visit www.fake-loan.com for a guaranteed ₹50,000 loan.", { source: "llm" });
  assert.doesNotMatch(grounded, /fake-loan|guaranteed|50,000/);
  assert.match(grounded, /TezCredit|bank verification/i);
});
