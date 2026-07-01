const config = require("../config");
const { buildPrompt } = require("../services/playbooks");

async function generateReply({ lead, lastUserMessage = "", transcript = [], conversationState = {}, isWhyQuestion = false }) {
  if (!config.ai.geminiApiKey) {
    return fallbackReply(lead);
  }

  const prompt = await buildPrompt(lead, { transcript, lastUserMessage, conversationState, isWhyQuestion });
  const models = uniqueModels([config.ai.geminiModel, ...(config.ai.geminiFallbackModels || [])]);
  const errors = [];

  const body = {
    contents: [{
      parts: [{
        text: `${prompt}
${responseInstruction(lead)}`
      }]
    }],
    generationConfig: {
      maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 80),
      temperature: Number(process.env.GEMINI_TEMPERATURE || 0.5)
    }
  };

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${config.ai.geminiApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      errors.push(`${model}: ${await res.text()}`);
      continue;
    }

    const data = await res.json();
    return cleanReply(data?.candidates?.[0]?.content?.parts?.[0]?.text) || fallbackReply(lead);
  }

  throw new Error(`Gemini failed for all configured models: ${errors.join(" | ")}`);
}

function uniqueModels(models) {
  return [...new Set(models.map(model => String(model || "").trim()).filter(Boolean))];
}

function cleanReply(value) {
  const maxWords = Number(process.env.GEMINI_REPLY_MAX_WORDS || 28);
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
  if (isEnglishLead(lead)) return englishFallbackReply(lead);
  const name = firstName(lead.name);
  const prefix = name ? `${name} ji, ` : "";
  if (lead.playbook_type === "SOFT_PAYMENT_REMINDER") {
    return `${prefix}आपकी पेमेंट की तारीख पास है। क्या मैं सुरक्षित पेमेंट लिंक अभी भेज दूँ?`;
  }
  if (lead.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `${prefix}आपकी पेमेंट overdue दिख रही है। आप कब तक पेमेंट कर पाएँगे?`;
  }
  if (lead.playbook_type === "APPROVED_USERS") {
    return `${prefix}आपका loan offer ready है। क्या आप इसे आज आगे बढ़ाना चाहेंगे?`;
  }
  if (lead.playbook_type === "FRESH_LEAD") {
    return `${prefix}मैं loan eligibility के लिए call कर रहा हूँ। आपको कितना loan चाहिए?`;
  }
  return `${prefix}आपकी loan eligibility pending है। क्या मैं final offer check करने में मदद करूँ?`;
}

function responseInstruction(lead) {
  if (isEnglishLead(lead)) {
    return "Respond now as spoken Indian English for TTS: one or two short sentences, maximum 24 words. No bullet points.";
  }
  return "Respond now as spoken Hindi for TTS: one or two short Devanagari sentences, maximum 24 words. No bullet points.";
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

module.exports = { generateReply };
