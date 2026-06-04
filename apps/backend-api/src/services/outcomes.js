const OUTCOMES = [
  "IN_PROGRESS",
  "INTERESTED",
  "PROMISE_TO_PAY",
  "PAID",
  "CALLBACK",
  "WRONG_NUMBER",
  "DISPUTE",
  "NOT_INTERESTED",
  "OPTED_OUT"
];

function inferOutcome(message) {
  const text = normalizeForIntent(message);
  if (isOptOut(message)) return "OPTED_OUT";
  if (/(wrong number|galat number|not my number|not my phone|गलत नंबर|मेरा नंबर नहीं|मेरा नंबर नही|मेरे लिए नहीं|मेरे लिए नही)/.test(text)) return "WRONG_NUMBER";
  if (/(paid|payment done|already paid|kar diya|ho gaya|भुगतान हो गया|पेमेंट कर दिया|पेमेंट हो गया)/.test(text)) return "PAID";
  if (/(call back|callback|call me|call later|phone later|busy|driving|in a meeting|meeting mein|baad mein call|kal call|tomorrow call|बाद में कॉल|कल कॉल|व्यस्त|बिजी|अभी नहीं|ड्राइव|गाड़ी चला|मीटिंग)/.test(text)) return "CALLBACK";
  if (/(promise|will pay|pay tomorrow|tomorrow pay|kal pay|pay later|pay on|pay by|payment tomorrow|agle hafte pay|कल पे|कल pay|कल payment|कल कर दूंगा|कल कर दूंगी|बाद में पे|अगले हफ्ते pay|अगले हफ्ते पे)/.test(text)) return "PROMISE_TO_PAY";
  if (/(dispute|issue|problem|wrong amount|not correct|समस्या|दिक्कत|गलत अमाउंट|गलत राशि)/.test(text)) return "DISPUTE";
  if (isDecline(message) || isGoodbye(message)) return "NOT_INTERESTED";
  if (/(yes|haan|han|interested|bhej|send|continue|pay|payment|हाँ|हा|ठीक|भेज|जारी|कर दीजिए|कर दीजिये)/.test(text)) return "INTERESTED";
  return "IN_PROGRESS";
}

function classifyConversation({ userMessage = "", transcript = [], playbookType = "" }) {
  const allUserText = [
    ...transcript.filter(item => item.speaker === "user").map(item => item.text),
    userMessage
  ].join(" ");
  const outcome = inferOutcome(allUserText);
  const summary = summarizeOutcome({ outcome, userMessage, allUserText, playbookType });

  return { outcome, summary };
}

function summarizeOutcome({ outcome, userMessage, allUserText, playbookType }) {
  const latest = String(userMessage || "").trim();
  const base = latest ? `Latest user response: "${latest.slice(0, 180)}"` : "No clear user response captured.";

  if (outcome === "PAID") return `${base}. User claims payment is already completed.`;
  if (outcome === "PROMISE_TO_PAY") return `${base}. User indicated a future payment commitment.`;
  if (outcome === "CALLBACK") return `${base}. User requested callback or was busy.`;
  if (outcome === "WRONG_NUMBER") return `${base}. User indicated wrong number.`;
  if (outcome === "DISPUTE") return `${base}. User raised a dispute or issue requiring review.`;
  if (outcome === "INTERESTED") return `${base}. User showed interest or agreed to continue.`;
  if (outcome === "NOT_INTERESTED") return `${base}. User declined or showed no interest.`;
  if (outcome === "OPTED_OUT") return `${base}. User opted out of future calls.`;

  if (playbookType?.includes("PAYMENT")) return `${base}. Payment intent not confirmed yet.`;
  return `${base}. Conversation still in progress.`;
}

function isOptOut(message) {
  const text = normalizeForIntent(message);
  return /\b(stop|unsubscribe|remove|do not call|dont call|don't call|mat call|dobara call nahi|dobara phone nahi)\b/.test(text)
    || /(दोबारा कॉल मत|दोबारा फोन मत|फिर कॉल मत|मत कॉल|कॉल मत करना|फोन मत करना)/.test(text);
}

function isTerminalIntent(message) {
  return isOptOut(message)
    || isGoodbye(message)
    || isDecline(message)
    || ["CALLBACK", "WRONG_NUMBER", "PAID", "PROMISE_TO_PAY"].includes(inferOutcome(message));
}

function terminalOutcome(message) {
  if (isOptOut(message)) return "OPTED_OUT";
  const outcome = inferOutcome(message);
  if (["CALLBACK", "WRONG_NUMBER", "PAID", "PROMISE_TO_PAY", "NOT_INTERESTED"].includes(outcome)) return outcome;
  if (isGoodbye(message) || isDecline(message)) return "NOT_INTERESTED";
  return "IN_PROGRESS";
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
  isOptOut,
  isTerminalIntent,
  terminalOutcome
};
