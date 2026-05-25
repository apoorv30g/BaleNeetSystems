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
  const text = String(message || "").toLowerCase();
  if (/(paid|payment done|already paid|kar diya|ho gaya)/.test(text)) return "PAID";
  if (/(promise|will pay|kal pay|tomorrow|pay later|date|agle hafte)/.test(text)) return "PROMISE_TO_PAY";
  if (/(call back|callback|later|busy|baad mein)/.test(text)) return "CALLBACK";
  if (/(wrong number|galat number|not my number)/.test(text)) return "WRONG_NUMBER";
  if (/(dispute|issue|problem|wrong amount|not correct)/.test(text)) return "DISPUTE";
  if (/(yes|haan|interested|bhej|send|continue|pay|payment)/.test(text)) return "INTERESTED";
  if (/(no|nahi|not interested)/.test(text)) return "NOT_INTERESTED";
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
  return /\b(stop|unsubscribe|remove|do not call|dont call|mat call|dobara call nahi|nahi chahiye)\b/i.test(String(message || ""));
}

module.exports = { OUTCOMES, inferOutcome, classifyConversation, isOptOut };
