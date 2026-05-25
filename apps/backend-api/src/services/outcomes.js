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

function isOptOut(message) {
  return /\b(stop|unsubscribe|remove|do not call|dont call|mat call|dobara call nahi|nahi chahiye)\b/i.test(String(message || ""));
}

module.exports = { OUTCOMES, inferOutcome, isOptOut };
