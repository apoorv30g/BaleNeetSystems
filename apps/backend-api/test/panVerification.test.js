const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/routes/voicebot");
const config = require("../src/config");

const WEBSITE = String(config.loanAppUrl || "").replace(/^https?:\/\//i, "");

function panLead(overrides = {}) {
  return {
    name: "Prasheel Gupta",
    phone: "8826522604",
    playbook_type: "PAN_VERIFICATION_RETARGETING",
    language: "Hinglish",
    ...overrides
  };
}

function panSession(stage, { lead = panLead(), english = false, ...extra } = {}) {
  return {
    preferredLanguage: english ? "English" : "Hinglish",
    lead: english ? { ...lead, language: "English" } : lead,
    userTurns: 1,
    confirmedName: true,
    panStage: stage,
    ...extra
  };
}

test("PAN opening greets with brand and name, without the word automated", () => {
  const greeting = _test.firstGreeting(panLead());
  assert.match(greeting, new RegExp(config.brandName));
  assert.match(greeting, /Prasheel Gupta/);
  assert.doesNotMatch(greeting, /automated/i);
  assert.doesNotMatch(greeting, /TezCredit/);
});

test("PAN happy path: identity -> context -> interest -> continue -> instructions", () => {
  const lead = panLead();
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 0, confirmedName: false, panStage: "identity" };
  session.lastSpokenText = _test.firstGreeting(lead);

  session.userTurns = 1;
  _test.updateConversationMemory(session, "हां जी");
  const context = _test.buildScriptedReply(session, "हां जी");
  assert.match(context, /धन्यवाद/);
  assert.ok(context.includes(WEBSITE));
  assert.match(context, /PAN verification/);
  session.lastSpokenText = context;

  session.userTurns = 2;
  const interest = _test.buildScriptedReply(session, "हां");
  assert.match(interest, /₹50,000/);
  session.lastSpokenText = interest;

  session.userTurns = 3;
  const cont = _test.buildScriptedReply(session, "हां");
  assert.match(cont, /आज अपनी application continue/);
  session.lastSpokenText = cont;

  session.userTurns = 4;
  const instructions = _test.buildScriptedReply(session, "हां चलिए");
  assert.match(instructions, /Apply for Loan/);
  assert.ok(instructions.includes(WEBSITE));
  assert.equal(session.panStage, "instructions_given");
  assert.equal(session.panOutcome, "continuing");
});

test("PAN playbook voice_config overrides brand, assistant, and website", () => {
  const lead = panLead({
    voice_config: { brand: { name: "BharatLoans", assistant: "Asha", website: "https://bharatloans.in" } }
  });
  const greeting = _test.firstGreeting(lead);
  assert.match(greeting, /BharatLoans/);
  assert.doesNotMatch(greeting, new RegExp(config.brandName));

  const session = panSession("identity", { lead, confirmedName: false });
  session.lastSpokenText = greeting;
  const identity = _test.buildScriptedReply(session, "कौन बोल रहा है?");
  assert.match(identity, /Asha/);
  assert.match(identity, /BharatLoans/);

  const session2 = panSession("identity", { lead });
  const context = _test.buildScriptedReply(session2, "हां");
  assert.match(context, /bharatloans\.in/);
  assert.doesNotMatch(context, new RegExp(WEBSITE.replace(/\./g, "\\.")));
});

test("trailing words after yes still confirm (हां जी और)", () => {
  const lead = panLead();
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, confirmedName: false, panStage: "identity" };
  session.lastSpokenText = _test.firstGreeting(lead);
  _test.updateConversationMemory(session, "हां जी और");
  assert.equal(session.confirmedName, true);
});

test("busy at availability closes with website and marks call for hangup", () => {
  const session = panSession("availability");
  const reply = _test.buildScriptedReply(session, "मैं अभी busy हूं");
  assert.ok(reply.includes(WEBSITE));
  assert.equal(session.panShouldClose, true);
  assert.equal(session.panOutcome, "busy");
});

test("bare no at interest stage closes politely as not interested", () => {
  const session = panSession("interest");
  const reply = _test.buildScriptedReply(session, "नहीं");
  assert.match(reply, /धन्यवाद/);
  assert.equal(session.panOutcome, "not_interested");
  assert.equal(session.panShouldClose, true);
});

test("website-name question is answered with brand and URL at any stage", () => {
  for (const stage of ["availability", "interest", "continue_today"]) {
    const reply = _test.buildScriptedReply(panSession(stage), "website ka naam kya hai");
    assert.ok(reply.includes(WEBSITE), `stage ${stage}: ${reply}`);
    assert.match(reply, new RegExp(config.brandName));
  }
});

test("kitna time lagega answers duration, not loan amount", () => {
  const reply = _test.buildScriptedReply(panSession("availability"), "kitna time lagega");
  assert.match(reply, /minute/);
  assert.doesNotMatch(reply, /₹50,000/);
});

test("guarantee and rate questions get compliant answers without promises", () => {
  const guarantee = _test.buildScriptedReply(panSession("availability"), "kya loan pakka milega");
  assert.match(guarantee, /eligibility/);
  const rate = _test.buildScriptedReply(panSession("availability"), "interest rate kya hai");
  assert.match(rate, /final offer screen/);
});

test("three unclear answers give up gracefully instead of looping", () => {
  const session = panSession("availability");
  const first = _test.buildScriptedReply(session, "xyzabc");
  const second = _test.buildScriptedReply(session, "xyzabc");
  const third = _test.buildScriptedReply(session, "xyzabc");
  assert.notEqual(first, second);
  assert.ok(third.includes(WEBSITE));
  assert.equal(session.panShouldClose, true);
  assert.equal(session.panOutcome, "unclear_gave_up");
});

test("identity stage re-asks the short name question, not the full greeting", () => {
  const lead = panLead();
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, confirmedName: false, panStage: "identity" };
  session.lastSpokenText = _test.firstGreeting(lead);
  const reply = _test.buildScriptedReply(session, "भाई ये तो");
  assert.match(reply, /Prasheel Gupta/);
  assert.doesNotMatch(reply, /recent loan application/);
});

test("repeat request gets a willing repeat, not an apology", () => {
  const reply = _test.buildScriptedReply(panSession("interest"), "phir se boliye");
  assert.match(reply, /जी ज़रूर/);
  assert.match(reply, /₹50,000/);
});

test("question after instructions gives a recap instead of hanging up", () => {
  const session = panSession("instructions_given");
  const recap = _test.buildScriptedReply(session, "Apply for Loan kahan hai");
  assert.ok(recap.includes(WEBSITE));
  assert.ok(!session.panShouldClose);
  const closing = _test.buildScriptedReply(session, "accha wahan kya karna hai");
  assert.equal(session.panShouldClose, true);
  assert.ok(closing.includes(WEBSITE));
});

test("theek hai after instructions closes the call with thanks", () => {
  const session = panSession("instructions_given");
  const reply = _test.buildScriptedReply(session, "theek hai");
  assert.match(reply, /धन्यवाद/);
  assert.equal(session.panShouldClose, true);
});

test("never-applied dispute apologizes and closes without pushing forward", () => {
  const session = panSession("availability");
  const reply = _test.buildScriptedReply(session, "maine kabhi apply nahi kiya");
  assert.match(reply, /माफी|दोबारा contact नहीं/);
  assert.equal(session.panOutcome, "disputes_application");
  assert.equal(session.panShouldClose, true);
});

test("FAQ interrupts are answered even before name confirmation", () => {
  const lead = panLead();
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, confirmedName: false, panStage: "identity" };
  session.lastSpokenText = _test.firstGreeting(lead);
  const reply = _test.buildScriptedReply(session, "loan amount kitna milega");
  assert.match(reply, /₹50,000/);
});

test("a substantive off-script question hands one grounded turn to the LLM", () => {
  const session = panSession("interest");
  const reply = _test.buildScriptedReply(session, "mera CIBIL score kharab hai to kya hoga");
  assert.equal(reply, "");
  assert.equal(session.flowLlmTurns, 1);
  const third = _test.buildScriptedReply(session, "aur kya kya check hota hai");
  assert.equal(third, "");
  const capped = _test.buildScriptedReply(session, "aur documents ke baare mein kya scene hai bhai");
  assert.notEqual(capped, "");
});

// A completely custom playbook flow -- different brand, different gates -- proving the
// engine is multi-client: this is what a second client's dashboard-authored config runs as.
function customFlowLead() {
  return {
    name: "Ravi Kumar",
    phone: "9812345678",
    playbook_type: "GOLD_LOAN_RENEWAL",
    language: "Hinglish",
    voice_config: {
      brand: { name: "SwarnaCredit", assistant: "Meera", website: "https://swarnacredit.in" },
      flow: {
        opening: {
          confirmName: true,
          text: { hi: "नमस्ते, यह {{brand}} की तरफ से call है। क्या मेरी बात {{name}} जी से हो रही है?", en: "Hi, this is a call from {{brand}}. Am I speaking with {{name}}?" },
          textNoName: { hi: "नमस्ते, यह {{brand}} की तरफ से call है। क्या मेरी बात customer से हो रही है?", en: "Hi, this is a call from {{brand}}. Am I speaking with the customer?" }
        },
        gates: [
          {
            id: "renewal_interest",
            question: { hi: "धन्यवाद। आपका gold loan renewal due है। क्या आप renew करना चाहेंगे?", en: "Thank you. Your gold loan renewal is due. Would you like to renew?" },
            reprompt: { hi: "क्या आप gold loan renew करना चाहेंगे?", en: "Would you like to renew your gold loan?" },
            onNo: { outcome: "not_interested", text: { hi: "ठीक है, धन्यवाद।", en: "Alright, thank you." } }
          }
        ],
        instructions: {
          outcome: "continuing",
          text: { hi: "बहुत बढ़िया! {{website}} पर जाकर renew कर लीजिए। धन्यवाद।", en: "Great! Please renew at {{website}}. Thank you." },
          condensed: { hi: "बस {{website}} पर जाकर renew करना है।", en: "Just renew at {{website}}." }
        },
        faqs: [
          { intent: "amount", answer: { hi: "Renewal amount website पर दिखेगा।", en: "The renewal amount is shown on the website." } }
        ]
      }
    }
  };
}

test("a custom playbook flow runs end-to-end with its own brand, gates, and website", () => {
  const lead = customFlowLead();
  const greeting = _test.firstGreeting(lead);
  assert.match(greeting, /SwarnaCredit/);
  assert.match(greeting, /Ravi Kumar/);

  const session = { preferredLanguage: "Hinglish", lead, userTurns: 0, confirmedName: false, panStage: "identity" };
  session.lastSpokenText = greeting;

  session.userTurns = 1;
  _test.updateConversationMemory(session, "हां जी");
  assert.equal(session.confirmedName, true);
  const gateQ = _test.buildScriptedReply(session, "हां जी");
  assert.match(gateQ, /gold loan renewal/);
  session.lastSpokenText = gateQ;

  session.userTurns = 2;
  const instructions = _test.buildScriptedReply(session, "हां");
  assert.match(instructions, /swarnacredit\.in/);
  assert.equal(session.panStage, "instructions_given");
  assert.equal(session.panOutcome, "continuing");
});

test("custom flow answers its own FAQs and inherits generic safety answers", () => {
  const lead = customFlowLead();
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, confirmedName: true, panStage: "renewal_interest" };
  const amount = _test.buildScriptedReply(session, "kitna amount hoga");
  assert.match(amount, /Renewal amount/);
  const safety = _test.buildScriptedReply(session, "aap OTP to nahi maangoge");
  assert.match(safety, /OTP, PIN, password/);
  const website = _test.buildScriptedReply(session, "website ka naam kya hai");
  assert.match(website, /SwarnaCredit/);
  assert.match(website, /swarnacredit\.in/);
});

test("an approved learned FAQ answers by phrase on top of the built-in PAN flow", () => {
  const lead = panLead({
    voice_config: {
      flow: {
        faqs: [{
          phrases: ["cibil kharab", "credit score"],
          answer: { hi: "CIBIL score का exact असर final offer screen पर दिखेगा। आप {{website}} पर check कर सकते हैं।", en: "The exact CIBIL impact is shown on the final offer screen at {{website}}." },
          learned: true
        }]
      }
    }
  });
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, confirmedName: true, panStage: "availability" };
  const reply = _test.buildScriptedReply(session, "mera cibil kharab hai to kya hoga");
  assert.match(reply, /CIBIL score का exact असर/);
  assert.ok(reply.includes(WEBSITE));

  // The default PAN flow still runs: gates advance normally and default FAQs still answer.
  const gate = _test.buildScriptedReply(session, "हां");
  assert.match(gate, /₹50,000/);
  const amount = _test.buildScriptedReply(session, "loan amount kitna milega");
  assert.match(amount, /₹50,000/);
});

test("a learned phrase inside a clear yes does not hijack the gate", () => {
  const lead = panLead({
    voice_config: { flow: { faqs: [{ phrases: ["loan"], answer: { hi: "hijacked", en: "hijacked" }, learned: true }] } }
  });
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, confirmedName: true, panStage: "interest" };
  const reply = _test.buildScriptedReply(session, "haan loan chahiye");
  assert.doesNotMatch(reply, /hijacked/);
  assert.equal(session.panStage, "continue_today");
});

test("decline phrasings the generic pipeline defers to the flow still close politely", () => {
  for (const phrase of ["mujhe nahi karna hai bhai", "नहीं लेना मुझे", "rehne do abhi"]) {
    const session = panSession("interest");
    const reply = _test.buildScriptedReply(session, phrase);
    assert.match(reply, /धन्यवाद/, `phrase: ${phrase} -> ${reply}`);
    assert.equal(session.panShouldClose, true, `phrase: ${phrase}`);
  }
});

test("a gate with question variants records which variant was spoken", () => {
  const lead = panLead({
    voice_config: {
      flow: {
        opening: {
          confirmName: false,
          text: { hi: "नमस्ते {{brand}}. क्या अभी बात कर सकते हैं?", en: "Hi from {{brand}}. Can we talk now?" }
        },
        gates: [{
          id: "interest",
          questionVariants: [
            { hi: "क्या आप interested हैं? variant A", en: "Are you interested? variant A" },
            { hi: "क्या आपको loan चाहिए? variant B", en: "Do you want a loan? variant B" }
          ],
          reprompt: { hi: "क्या आप interested हैं?", en: "Are you interested?" },
          onNo: { outcome: "not_interested" }
        }],
        instructions: { outcome: "continuing", text: { hi: "बढ़िया, {{website}}", en: "Great, {{website}}" } }
      }
    }
  });
  // confirmName:false -> opening IS the first gate's turn; engine enters "interest" on first input.
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, panStage: "interest", variantWeights: { interest: { 0: 0.9, 1: 0.1 } } };
  const reply = _test.buildScriptedReply(session, "हां");
  // moved to instructions after answering the single gate
  assert.match(reply, /बढ़िया/);
  // the gate question that was spoken when ENTERING interest is recorded... but here we entered
  // interest via panStage seed, so the variant event fires when the NEXT gate renders. Instead
  // verify the mechanism directly on gate entry:
  const s2 = { preferredLanguage: "Hinglish", lead, userTurns: 1, panStage: "identity", confirmedName: true };
  // identity->first gate transition renders a variant
  const gateReply = _test.buildScriptedReply(s2, "हां");
  assert.ok(Array.isArray(s2.pendingVariantEvents));
  assert.equal(s2.pendingVariantEvents.length, 1);
  assert.equal(s2.pendingVariantEvents[0].gateId, "interest");
  assert.ok([0, 1].includes(s2.pendingVariantEvents[0].variantIndex));
  assert.match(gateReply, /variant [AB]/);
});

test("weighted variant selection is honored (weight 0.99 vs floor)", () => {
  const lead = panLead({
    voice_config: {
      flow: {
        opening: { confirmName: true, text: { hi: "{{brand}} {{name}}?", en: "{{brand}} {{name}}?" }, textNoName: { hi: "{{brand}}?", en: "{{brand}}?" } },
        gates: [{
          id: "g1",
          questionVariants: [
            { hi: "A phrasing", en: "A phrasing" },
            { hi: "B phrasing", en: "B phrasing" }
          ],
          onNo: { outcome: "not_interested" }
        }],
        instructions: { outcome: "continuing", text: { hi: "done", en: "done" } }
      }
    }
  });
  let aCount = 0;
  for (let i = 0; i < 50; i++) {
    const s = { preferredLanguage: "English", lead: { ...lead, language: "English" }, userTurns: 1, panStage: "identity", confirmedName: true, variantWeights: { g1: { 0: 0.99, 1: 0.0 } } };
    const r = _test.buildScriptedReply(s, "yes");
    if (/A phrasing/.test(r)) aCount++;
  }
  assert.ok(aCount > 35, `expected variant A to dominate, got ${aCount}/50`);
});

test("custom flow gate decline uses its own closing text and hangs up", () => {
  const lead = customFlowLead();
  const session = { preferredLanguage: "Hinglish", lead, userTurns: 1, confirmedName: true, panStage: "renewal_interest" };
  const reply = _test.buildScriptedReply(session, "नहीं");
  assert.match(reply, /ठीक है, धन्यवाद/);
  assert.equal(session.panOutcome, "not_interested");
  assert.equal(session.panShouldClose, true);
});
