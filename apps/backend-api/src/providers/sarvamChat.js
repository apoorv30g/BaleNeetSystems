const config = require("../config");
const { buildPrompt } = require("../services/playbooks");

async function generateSarvamReply({ lead, lastUserMessage = "", transcript = [], conversationState = {} }) {
  if (!config.ai.sarvamApiKey) {
    throw new Error("Sarvam API key is not configured");
  }

  const prompt = await buildPrompt(lead, { transcript, lastUserMessage, conversationState });
  const body = {
    model: process.env.SARVAM_CHAT_MODEL || "sarvam-30b",
    messages: [
      {
        role: "system",
        content: prompt
      },
      {
        role: "user",
        content: responseInstruction(lead)
      }
    ],
    max_tokens: Number(process.env.SARVAM_CHAT_MAX_TOKENS || 80),
    temperature: Number(process.env.SARVAM_CHAT_TEMPERATURE || 0.35),
    stream: false,
    n: 1
  };

  const reasoningEffort = process.env.SARVAM_CHAT_REASONING_EFFORT || "none";
  body.reasoning_effort = reasoningEffort.toLowerCase() === "none" ? null : reasoningEffort;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SARVAM_CHAT_TIMEOUT_MS || 3500));
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": config.ai.sarvamApiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await res.text();
    const data = parseMaybeJson(text);
    if (!res.ok) {
      throw new Error(`Sarvam chat failed ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }

    const reply = data?.choices?.[0]?.message?.content || data?.output_text || data?.text || "";
    return ensureCompleteReply(cleanReply(reply), lead) || fallbackReply(lead);
  } finally {
    clearTimeout(timeout);
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cleanReply(value) {
  const maxWords = Number(process.env.SARVAM_REPLY_MAX_WORDS || process.env.GEMINI_REPLY_MAX_WORDS || 28);
  const text = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s"'`*_>-]+/g, "")
    .replace(/^\d+[\).:-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  const words = text.split(/\s+/);
  if (!Number.isFinite(maxWords) || words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ");
}

function ensureCompleteReply(value, lead = {}) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const repaired = repairMalformedCompleteReply(text, lead);
  if (repaired) return repaired;
  if (/[.!?।]$/.test(text)) return text;

  if (isEnglishLead(lead)) return completeEnglishReply(text, lead);
  return completeHindiReply(text, lead);
}

function repairMalformedCompleteReply(text, lead = {}) {
  if (isEnglishLead(lead)) {
    if (/\bsecure[.!?]$/i.test(text)) return text.replace(/\bsecure[.!?]$/i, "secure link.");
    if (/\bopen the[.!?]$/i.test(text)) return text.replace(/\bopen the[.!?]$/i, "open the secure link.");
    return "";
  }

  if (/(ऐप|app) में सुरक्षित।$/.test(text)) {
    return text.replace(/(ऐप|app) में सुरक्षित।$/, "$1 में सुरक्षित लिंक खोलिए।");
  }
  if (/सुरक्षित।$/.test(text)) return text.replace(/सुरक्षित।$/, "सुरक्षित लिंक खोलिए।");
  if (/(लिंक|link) खोलकर।$/.test(text)) return text.replace(/(लिंक|link) खोलकर।$/, "$1 खोलकर स्क्रीन बताइए।");
  if (/(bank verification|verification|वेरिफिकेशन|KYC|के वाई सी|selfie|e-sign|profile)\s+complete[।.]$/i.test(text)) {
    return text.replace(/(bank verification|verification|वेरिफिकेशन|KYC|के वाई सी|selfie|e-sign|profile)\s+complete[।.]$/i, "$1 complete कर सकते हैं?");
  }
  if (/\bcomplete[।.]$/i.test(text) && /(क्या|कृपया|please|can you|app|ऐप)/i.test(text)) {
    return text.replace(/\bcomplete[।.]$/i, "complete कर सकते हैं?");
  }
  return "";
}

function completeEnglishReply(text, lead = {}) {
  const lower = text.toLowerCase();
  if (/(to see|to check|to view|for checking|for seeing|for viewing|open|please open|click|use the link)$/.test(lower)) {
    return `${text} the secure link.`;
  }
  if (/\b(to|for|with|and|or|the|your|our|in|on|at|by|of|please|kindly)$/.test(lower)) {
    return `${text} in the app.`;
  }
  if (lead?.playbook_type === "SOFT_PAYMENT_REMINDER" || lead?.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `${text}. Please use the secure payment link.`;
  }
  return `${text}.`;
}

function completeHindiReply(text, lead = {}) {
  if (/(देखने|चेक करने|जाँच करने|जांच करने|offer देखने|प्रस्ताव देखने|प्रस्ताव को देखने)$/.test(text)) {
    return `${text} के लिए सुरक्षित लिंक खोलिए।`;
  }
  if (/(खोलकर|खोलने|करने|पूरा करने|आगे बढ़ाने)$/.test(text)) {
    return `${text} के लिए app खोलिए।`;
  }
  if (/(कृपया|अपने|अपना|आपका|की|का|के|को|में|से|पर|और|या|लिए)$/.test(text)) {
    return `${text} app में check कर लीजिए।`;
  }
  if (lead?.playbook_type === "SOFT_PAYMENT_REMINDER" || lead?.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `${text}। कृपया सुरक्षित payment link use कीजिए।`;
  }
  return `${text}।`;
}

function fallbackReply(lead) {
  if (isEnglishLead(lead)) return englishFallbackReply(lead);
  const name = firstName(lead?.name);
  const prefix = name ? `${name} ji, ` : "";
  if (lead?.playbook_type === "SOFT_PAYMENT_REMINDER") {
    return `${prefix}आपकी पेमेंट की तारीख पास है। क्या मैं सुरक्षित पेमेंट लिंक अभी भेज दूँ?`;
  }
  if (lead?.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `${prefix}आपकी पेमेंट overdue दिख रही है। आप कब तक पेमेंट कर पाएँगे?`;
  }
  if (lead?.playbook_type === "APPROVED_USERS") {
    return `${prefix}आपका loan offer ready है। क्या आप इसे आज आगे बढ़ाना चाहेंगे?`;
  }
  if (lead?.playbook_type === "FRESH_LEAD") {
    return `${prefix}मैं loan eligibility के लिए call कर रहा हूँ। आपको कितना loan चाहिए?`;
  }
  return `${prefix}आपकी loan eligibility pending है। क्या मैं final offer check करने में मदद करूँ?`;
}

function responseInstruction(lead) {
  if (isEnglishLead(lead)) {
    return "Respond now as spoken Indian English for TTS: one or two short complete sentences, maximum 24 words. Answer the latest user message first, do not repeat the previous assistant line, and end with punctuation.";
  }
  return "Respond now as spoken Hindi for TTS: one or two short complete Devanagari sentences, maximum 24 words. Answer the latest user message first, do not repeat the previous assistant line, and end with punctuation.";
}

function englishFallbackReply(lead = {}) {
  const name = firstName(lead.name);
  const prefix = name ? `${name}, ` : "";
  if (lead.playbook_type === "SOFT_PAYMENT_REMINDER") {
    return `${prefix}your payment due date is near. Should I share the secure payment link now?`;
  }
  if (lead.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `${prefix}your payment looks overdue. By when can you make the payment?`;
  }
  if (lead.playbook_type === "APPROVED_USERS") {
    return `${prefix}your loan offer is ready. Would you like to continue it today?`;
  }
  if (lead.playbook_type === "FRESH_LEAD") {
    return `${prefix}I am calling for loan eligibility. How much loan do you need?`;
  }
  return `${prefix}your loan eligibility is pending. Should I help you check the final offer?`;
}

function isEnglishLead(lead = {}) {
  return String(lead.language || "").toLowerCase().includes("english");
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

module.exports = { generateSarvamReply, _test: { cleanReply, ensureCompleteReply } };
