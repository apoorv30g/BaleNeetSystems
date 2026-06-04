const config = require("../config");
const { buildPrompt } = require("../services/playbooks");

async function generateSarvamReply({ lead, lastUserMessage = "", transcript = [] }) {
  if (!config.ai.sarvamApiKey) {
    throw new Error("Sarvam API key is not configured");
  }

  const prompt = await buildPrompt(lead, { transcript, lastUserMessage });
  const body = {
    model: process.env.SARVAM_CHAT_MODEL || "sarvam-30b",
    messages: [
      {
        role: "system",
        content: prompt
      },
      {
        role: "user",
        content: "Respond now in one natural Hinglish phone-call sentence, maximum 22 words. No bullet points."
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
    return cleanReply(reply) || fallbackReply(lead);
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
  const maxWords = Number(process.env.SARVAM_REPLY_MAX_WORDS || process.env.GEMINI_REPLY_MAX_WORDS || 24);
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

function fallbackReply(lead) {
  const name = firstName(lead?.name);
  const prefix = name ? `${name} ji, ` : "";
  if (lead?.playbook_type === "SOFT_PAYMENT_REMINDER") {
    return `${prefix}aapki payment due date paas hai. Kya main payment link abhi share kar doon?`;
  }
  if (lead?.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `${prefix}payment overdue dikh rahi hai. Kya aap bata sakte hain payment kab tak kar payenge?`;
  }
  if (lead?.playbook_type === "APPROVED_USERS") {
    return `${prefix}aapka loan offer ready hai. Kya aap ise aaj continue karna chahenge?`;
  }
  if (lead?.playbook_type === "FRESH_LEAD") {
    return `${prefix}main loan eligibility ke liye call kar raha hoon. Aapko kitna loan chahiye?`;
  }
  return `${prefix}aapki loan eligibility pending hai. Kya main aapko final offer check karne mein guide karun?`;
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

module.exports = { generateSarvamReply };
