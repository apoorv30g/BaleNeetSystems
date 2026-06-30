const OUTCOMES = [
  "IN_PROGRESS",
  "INTERESTED",
  "PROMISE_TO_PAY",
  "PAID",
  "CALLBACK",
  "WRONG_NUMBER",
  "VOICEMAIL",
  "CALL_SCREENING",
  "DISPUTE",
  "NOT_INTERESTED",
  "OPTED_OUT",
  "UNCLEAR"
];

function inferOutcome(message) {
  const text = normalizeForIntent(message);
  if (isVoicemail(message)) return "VOICEMAIL";
  if (isCallScreening(message)) return "CALL_SCREENING";
  if (isOptOut(message)) return "OPTED_OUT";
  if (/\b(wrong number|galat number|not my number|not my phone)\b/.test(text) || /(गलत नंबर|मेरा नंबर नहीं|मेरा नंबर नही|मेरे लिए नहीं|मेरे लिए नही)/.test(text)) return "WRONG_NUMBER";
  if (/\b(paid|payment done|already paid|kar diya|ho gaya)\b/.test(text) || /(भुगतान हो गया|पेमेंट कर दिया|पेमेंट हो गया)/.test(text)) return "PAID";
  if (/\b(call back|callback|call me later|call later|phone later|busy|driving|in a meeting|meeting mein|baad mein call|kal call|tomorrow call)\b/.test(text) || /(बाद में कॉल|कल कॉल|व्यस्त|बिजी|अभी नहीं|ड्राइव|गाड़ी चला|मीटिंग)/.test(text)) return "CALLBACK";
  if (/\b(will pay|pay tomorrow|tomorrow pay|kal pay|pay later|pay on|pay by|payment tomorrow|agle hafte pay)\b/.test(text) || /\bpromise\b/.test(text) || /(कल पे|कल pay|कल payment|कल कर दूंगा|कल कर दूंगी|बाद में पे|अगले हफ्ते pay|अगले हफ्ते पे)/.test(text)) return "PROMISE_TO_PAY";
  if (/\b(dispute|wrong amount|not correct)\b/.test(text) || /\b(issue|problem)\b/.test(text) && /\b(loan|payment|amount|emi)\b/.test(text) || /(समस्या|दिक्कत|गलत अमाउंट|गलत राशि)/.test(text)) return "DISPUTE";
  if (isDecline(message) || isGoodbye(message)) return "NOT_INTERESTED";
  if (/\b(yes|haan|han|interested|bhej|send|continue|pay|payment)\b/.test(text) || /(हाँ|हा|ठीक|भेज|जारी|कर दीजिए|कर दीजिये)/.test(text)) return "INTERESTED";
  return "IN_PROGRESS";
}

function classifyConversation({ userMessage = "", transcript = [], playbookType = "" }) {
  const allUserText = [
    ...transcript.filter(item => item.speaker === "user").map(item => item.text),
    userMessage
  ].join(" ");
  const outcome = inferOutcome(allUserText);
  const summary = summarizeOutcome({ outcome, userMessage, allUserText, playbookType });
  const structured = structuredOutcome({ outcome, userMessage, allUserText, playbookType });

  return { outcome, summary, ...structured };
}

function describeOutcome(outcome = "IN_PROGRESS", evidence = "", playbookType = "") {
  const normalized = OUTCOMES.includes(outcome) ? outcome : "IN_PROGRESS";
  return structuredOutcome({
    outcome: normalized,
    userMessage: evidence,
    allUserText: evidence,
    playbookType
  });
}

function summarizeOutcome({ outcome, userMessage, allUserText, playbookType }) {
  const latest = String(userMessage || "").trim();
  const base = latest ? `Latest user response: "${latest.slice(0, 180)}"` : "No clear user response captured.";

  if (outcome === "PAID") return `${base}. User claims payment is already completed.`;
  if (outcome === "PROMISE_TO_PAY") return `${base}. User indicated a future payment commitment.`;
  if (outcome === "CALLBACK") return `${base}. User requested callback or was busy.`;
  if (outcome === "WRONG_NUMBER") return `${base}. User indicated wrong number.`;
  if (outcome === "VOICEMAIL") return `${base}. Call reached voicemail or an answering machine.`;
  if (outcome === "CALL_SCREENING") return `${base}. Call was intercepted by phone screening before the user conversation.`;
  if (outcome === "DISPUTE") return `${base}. User raised a dispute or issue requiring review.`;
  if (outcome === "INTERESTED") return `${base}. User showed interest or agreed to continue.`;
  if (outcome === "NOT_INTERESTED") return `${base}. User declined or showed no interest.`;
  if (outcome === "OPTED_OUT") return `${base}. User opted out of future calls.`;
  if (outcome === "UNCLEAR") return `${base}. Intent is unclear and needs review.`;

  if (playbookType?.includes("PAYMENT")) return `${base}. Payment intent not confirmed yet.`;
  return `${base}. Conversation still in progress.`;
}

function structuredOutcome({ outcome, userMessage, allUserText, playbookType }) {
  const reason = outcomeReason(outcome, userMessage, playbookType);
  return {
    intent: outcome,
    confidence: outcomeConfidence(outcome, allUserText),
    reason,
    nextAction: nextActionForOutcome(outcome),
    objections: detectObjections(allUserText)
  };
}

function outcomeReason(outcome, userMessage, playbookType) {
  const latest = String(userMessage || "").trim();
  if (outcome === "VOICEMAIL") return "Answering machine or voicemail prompt detected.";
  if (outcome === "CALL_SCREENING") return "Phone screening assistant intercepted the call.";
  if (outcome === "CALLBACK") return "User asked to be called later or said they were busy.";
  if (outcome === "WRONG_NUMBER") return "User indicated the phone number is not relevant.";
  if (outcome === "PROMISE_TO_PAY") return "User gave a payment commitment.";
  if (outcome === "PAID") return "User stated payment is already complete.";
  if (outcome === "INTERESTED") return playbookType?.includes("PAYMENT")
    ? "User agreed to payment or next step."
    : "User agreed to continue or receive details.";
  if (outcome === "NOT_INTERESTED") return "User declined or ended the conversation.";
  if (outcome === "OPTED_OUT") return "User requested no future calls.";
  if (outcome === "DISPUTE") return "User raised a problem or dispute.";
  return latest ? "Conversation has signal, but no terminal intent yet." : "No clear user response captured.";
}

function outcomeConfidence(outcome, allUserText) {
  if (["VOICEMAIL", "CALL_SCREENING", "OPTED_OUT", "WRONG_NUMBER", "PAID", "CALLBACK"].includes(outcome)) return 0.95;
  if (["PROMISE_TO_PAY", "NOT_INTERESTED", "DISPUTE"].includes(outcome)) return 0.88;
  if (outcome === "INTERESTED") return 0.72;
  if (outcome === "UNCLEAR") return 0.35;
  return String(allUserText || "").trim() ? 0.45 : 0.2;
}

function nextActionForOutcome(outcome) {
  return {
    IN_PROGRESS: "Continue conversation if still live; otherwise review transcript.",
    INTERESTED: "Send secure link and follow up if the user does not complete the next step.",
    PROMISE_TO_PAY: "Schedule payment follow-up near the promised time.",
    PAID: "Avoid repeat payment reminders; reconcile payment status.",
    CALLBACK: "Retry at the requested callback window.",
    WRONG_NUMBER: "Suppress this lead unless corrected contact data is available.",
    VOICEMAIL: "Retry later; do not count as a human conversation.",
    CALL_SCREENING: "Retry later or ask user to disable/accept screening for this number.",
    DISPUTE: "Flag for manual review or app support follow-up.",
    NOT_INTERESTED: "Do not retry in the same campaign unless policy allows.",
    OPTED_OUT: "Add to DNC and stop future calls.",
    UNCLEAR: "Review transcript before retrying."
  }[outcome] || "Review transcript.";
}

function detectObjections(text) {
  const normalized = normalizeForIntent(text);
  const objections = [];
  if (/(interest|rate|ब्याज|दर)/.test(normalized)) objections.push("interest_rate");
  if (/(fee|charge|penalty|late|processing|फीस|चार्ज|पेनल्टी)/.test(normalized)) objections.push("fees_or_charges");
  if (/(safe|fraud|scam|otp|pin|password|सुरक्षित|फ्रॉड|ओ टी पी|ओटीपी|पासवर्ड)/.test(normalized)) objections.push("trust_or_safety");
  if (/(link|login|app|open|लिंक|लॉगिन|ऐप|खुल)/.test(normalized)) objections.push("app_or_link_issue");
  if (/(busy|meeting|driving|later|बिजी|मीटिंग|बाद में)/.test(normalized)) objections.push("busy_callback");
  if (/(not interested|nahi chahiye|नहीं चाहिए|नही चाहिए|मत call|do not call)/.test(normalized)) objections.push("not_interested");
  return Array.from(new Set(objections));
}

function isOptOut(message) {
  const text = normalizeForIntent(message);
  return /\b(stop|unsubscribe|remove|do not call|dont call|don't call|mat call|dobara call nahi|dobara phone nahi)\b/.test(text)
    || /(दोबारा कॉल मत|दोबारा फोन मत|फिर कॉल मत|मत कॉल|कॉल मत करना|फोन मत करना)/.test(text);
}

function isTerminalIntent(message) {
  return isOptOut(message)
    || isVoicemail(message)
    || isCallScreening(message)
    || isGoodbye(message)
    || isDecline(message)
    || ["CALLBACK", "WRONG_NUMBER", "PAID", "PROMISE_TO_PAY"].includes(inferOutcome(message));
}

function terminalOutcome(message) {
  if (isVoicemail(message)) return "VOICEMAIL";
  if (isCallScreening(message)) return "CALL_SCREENING";
  if (isOptOut(message)) return "OPTED_OUT";
  const outcome = inferOutcome(message);
  if (["CALLBACK", "WRONG_NUMBER", "PAID", "PROMISE_TO_PAY", "NOT_INTERESTED", "VOICEMAIL", "CALL_SCREENING"].includes(outcome)) return outcome;
  if (isGoodbye(message) || isDecline(message)) return "NOT_INTERESTED";
  return "IN_PROGRESS";
}

function isVoicemail(message) {
  const text = normalizeForIntent(message);
  return /(after the tone|leave (a )?message|record your message|voicemail|voice mail|mailbox|beep|not available to take your call|please record|reply after the tone)/.test(text)
    || /(संदेश छोड़|मैसेज छोड़|बीप के बाद|उपलब्ध नहीं|वॉइसमेल|वॉइस मेल)/.test(String(message || ""));
}

function isCallScreening(message) {
  const text = normalizeForIntent(message);
  return /(state your name|say your name|name and reason|say your name and reason|state your name and reason|screening|call screening|checking for name|see if this person is available|this person is available|person is available|please stay on the line|hold while i connect|google assistant|iphone|personal assistant)/.test(text)
    || /(नाम और कारण|लाइन पर रहें|उपलब्ध हैं या नहीं|नाम बताइए)/.test(String(message || ""));
}

function isGoodbye(message) {
  const text = normalizeForIntent(message);
  return /\b(bye|goodbye|end call|disconnect|hang up|cut the call|phone rakho|rakh do|band karo|bas)\b/.test(text)
    || /(बाय|अलविदा|कॉल काट|फोन रख|रख दीजिए|बंद करो|बस अब|बस रहने)/.test(text);
}

function isDecline(message) {
  const raw = String(message || "").trim();
  const text = normalizeForIntent(raw);
  if (/^(no|na|nahi|nahin|nope|नहीं|नही|ना|न)$/.test(text)) return true;
  return /\b(not interested|dont want|don't want|do not want|not needed|not required|nahi karna|nahi chahiye|loan nahi chahiye|mujhe nahi karna|mujhe nahi chahiye)\b/.test(text)
    || /(नहीं करना|नही करना|नहीं चाहिए|नही चाहिए|लोन नहीं चाहिए|मुझे नहीं करना|मुझे नही करना|मुझे नहीं चाहिए|इंटरेस्टेड नहीं|दिलचस्पी नहीं|नहीं लेना|नही लेना|रहने दीजिए|रहने दो)/.test(raw);
}

function normalizeForIntent(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/[।,.!?;:()[\]{}"'`*_>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  OUTCOMES,
  inferOutcome,
  classifyConversation,
  describeOutcome,
  isOptOut,
  isTerminalIntent,
  terminalOutcome,
  isVoicemail,
  isCallScreening
};
